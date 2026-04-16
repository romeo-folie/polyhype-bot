/**
 * Near-Zero Entry Scanner
 *
 * Scans the local market cache for binary markets priced 3–10¢ (YES or NO side)
 * and runs LLM consensus to find structural mispricings where the true probability
 * is much higher than the market price implies.
 *
 * Asymmetry rationale: a 5¢ entry that resolves YES at 95¢ = 19× payout. The
 * scanner hunts for cases where the market has not yet repriced to reflect
 * near-certain outcomes.
 *
 * Universe rework (2026-04-12):
 *   - Multi-outcome gate: skip markets with >2 outcomes (structurally cheap slices)
 *   - Heuristic patterns: skip championship/award/election long-shots
 *   - OSINT prioritization: prefer markets that matched real OSINT headlines
 *   - Near-zero LLM prompt: removes "return 0.50 if unrelated" anchor
 *   - Minimum edge gate: require consensus - price >= NEAR_ZERO_MIN_EDGE
 *   - Velocity dead-horse filter: require meaningful price drop into the zone
 *   - Sort by price descending (higher near-zero = more likely genuine mispricing)
 *
 * Ships with NEAR_ZERO_SCANNER_ENABLED=false. Shadow-log first (~48–72h),
 * review `[near-zero] candidate evaluated` logs, then enable.
 *
 * Log marker: [near-zero] candidate evaluated
 * Dedup:
 *   near_zero:inflight:{marketId}:{direction}  NX-claimed pre-LLM (300s TTL)
 *   near_zero:dedup:{marketId}:{direction}     set after successful LLM call,
 *     TTL = NEAR_ZERO_DEDUP_TTL_S when OSINT-matched, else NEAR_ZERO_DEDUP_TTL_S_NON_OSINT.
 *     Transient LLM failures do not burn the slot (the dedup key is never set).
 */

import 'dotenv/config';
import type { Redis } from 'ioredis';
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getBankroll } from '../shared/bankroll.js';
import { getCachedMarkets, getNearZeroPeakPriceDetailed } from '../shared/watchlist.js';
import { parseOutcomePrices, parseClobTokenIds, parseOutcomes } from '../mapping/gamma.js';
import { estimateConsensusProbability } from '../mapping/consensusCalculator.js';
import { checkTimeToResolution } from '../mapping/divergenceCalculator.js';
import { executeAndRecordSignal } from '../execution/executor.js';
import { priceZoneOf } from '../shared/zones.js';
import { enqueueWrite } from '../db/writeQueue.js';
import type { TradeSignal } from '../mapping/index.js';

const DEDUP_KEY_PREFIX = 'near_zero:dedup:';
const INFLIGHT_KEY_PREFIX = 'near_zero:inflight:';
const INFLIGHT_TTL_S = 300;
const NEAR_ZERO_OSINT_KEY = 'near_zero:osint_signals';

// ── Heuristic exclusion patterns ────────────────────────────────────────────
// Markets matching these patterns are almost always correctly cheap at 3-10¢.
// These are structural, not tunable via config.
export const HEURISTIC_EXCLUDE_PATTERNS: RegExp[] = [
  /\bwin\b.*\b(championship|title|cup|trophy|medal|pennant|league)\b/i,
  /\bnext\b.*\b(president|prime minister|chancellor|leader)\b/i,
  /\b(win|receive|awarded?)\b.*\b(oscar|emmy|grammy|nobel|award|ballon)\b/i,
  /\b(make|reach)\b.*\b(playoff|final|semifinal)\b/i,
  // Head-to-head matchups (tennis/baseball/etc.) — "X vs. Y" format.
  // LLM has no information edge on specific games; consensus is hallucinated.
  /\bvs\.?\s+[A-Z][a-z]/,
];

function parseKeywordList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function isExcludedByKeyword(question: string, excludes: string[]): boolean {
  if (excludes.length === 0) return false;
  const q = question.toLowerCase();
  return excludes.some((kw) => q.includes(kw));
}

export function isExcludedByHeuristic(question: string): boolean {
  return HEURISTIC_EXCLUDE_PATTERNS.some((re) => re.test(question));
}

interface OsintSignal {
  marketId: string;
  direction: string;
  headline: string;
  urgencyScore: number;
}

export async function runNearZeroScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  // Load markets from local cache (Gamma search API is broken — use cache populated
  // by the every-4h watchlist refresh cron).
  const allMarkets = await getCachedMarkets(redis);
  if (allMarkets.length === 0) {
    logger.warn('[near-zero] market cache empty — ensure refreshWatchlist runs first');
    return;
  }

  // Filter to markets with YES or NO price in the near-zero range.
  let multiOutcomeFiltered = 0;
  const candidates: { market: (typeof allMarkets)[number]; direction: 'YES' | 'NO'; price: number }[] = [];
  for (const market of allMarkets) {
    try {
      // Phase 1b: Multi-outcome gate — skip markets with >2 outcomes.
      // These are structurally cheap slices (e.g. 18-way "Best AI Model").
      if (market.outcomes) {
        try {
          const outcomeList = parseOutcomes(market.outcomes);
          if (outcomeList.length > 2) {
            multiOutcomeFiltered++;
            continue;
          }
        } catch {
          // Can't parse outcomes — skip gate, don't block
        }
      }

      const prices = parseOutcomePrices(market.outcomePrices);
      const yesPrice = parseFloat(prices[0] ?? '0');
      const noPrice = parseFloat(prices[1] ?? '0');

      if (!isFinite(yesPrice) || !isFinite(noPrice)) continue;

      if (yesPrice >= cfg.NEAR_ZERO_MIN_PRICE && yesPrice <= cfg.NEAR_ZERO_MAX_PRICE) {
        candidates.push({ market, direction: 'YES', price: yesPrice });
      } else if (noPrice >= cfg.NEAR_ZERO_MIN_PRICE && noPrice <= cfg.NEAR_ZERO_MAX_PRICE) {
        candidates.push({ market, direction: 'NO', price: noPrice });
      }
    } catch {
      // skip malformed prices
    }
  }

  // Drop markets that were evaluated recently (dedup by market+direction).
  // The dedup key is set AFTER a successful LLM call, so transient failures
  // don't burn the slot; a stuck/crashed run also cannot poison future runs.
  const fresh: typeof candidates = [];
  for (const c of candidates) {
    const key = `${DEDUP_KEY_PREFIX}${c.market.id}:${c.direction}`;
    const exists = await redis.get(key);
    if (!exists) fresh.push(c);
  }

  // Apply liquidity, time-to-resolution, keyword-exclusion, and heuristic gates.
  const keywordExcludes = parseKeywordList(cfg.NEAR_ZERO_EXCLUDE_KEYWORDS);
  let keywordFiltered = 0;
  let heuristicFiltered = 0;
  const valid = fresh.filter((c) => {
    const liquidity = parseFloat(c.market.liquidity ?? '0');
    if (!isFinite(liquidity) || liquidity < cfg.NEAR_ZERO_MIN_LIQUIDITY) return false;
    const ttr = checkTimeToResolution(
      c.market.endDate ?? undefined,
      undefined,
      cfg.NEAR_ZERO_MIN_HOURS,
    );
    if (!ttr.ok) return false;
    if (isExcludedByKeyword(c.market.question, keywordExcludes)) {
      keywordFiltered++;
      return false;
    }
    // Phase 1c: Heuristic pattern exclusion
    if (isExcludedByHeuristic(c.market.question)) {
      heuristicFiltered++;
      return false;
    }
    return true;
  });

  // Phase 4: Velocity-aware dead-horse filter. Replaces the binary "has peak
  // ever been above X?" check with a velocity assessment: markets that dropped
  // INTO the zone from higher prices are good candidates; markets that have
  // always been flat near zero are dead horses.
  let deadHorseFiltered = 0;
  const qualified: typeof valid = [];
  for (const c of valid) {
    if (!cfg.NEAR_ZERO_REQUIRE_REPRICE) {
      qualified.push(c);
      continue;
    }
    const peakResult = await getNearZeroPeakPriceDetailed(
      redis,
      c.market.id,
      c.direction,
      cfg.NEAR_ZERO_REPRICE_LOOKBACK_DAYS,
    );
    if (peakResult === null) {
      // No history yet — grandfather in.
      qualified.push(c);
      continue;
    }

    // Must have been above REPRICE_MIN_PEAK at some point
    if (peakResult.peak < cfg.NEAR_ZERO_REPRICE_MIN_PEAK) {
      deadHorseFiltered++;
      logger.debug('[near-zero] dead-horse filtered (never above threshold)', {
        marketId: c.market.id,
        direction: c.direction,
        currentPrice: c.price.toFixed(4),
        peakPrice: peakResult.peak.toFixed(4),
        threshold: cfg.NEAR_ZERO_REPRICE_MIN_PEAK,
      });
      continue;
    }

    // Velocity check: require meaningful drop from peak to current
    const dropPct = (peakResult.peak - c.price) / peakResult.peak;
    if (dropPct < cfg.NEAR_ZERO_MIN_PRICE_DROP_PCT) {
      deadHorseFiltered++;
      logger.debug('[near-zero] dead-horse filtered (flat — no meaningful drop)', {
        marketId: c.market.id,
        direction: c.direction,
        currentPrice: c.price.toFixed(4),
        peakPrice: peakResult.peak.toFixed(4),
        dropPct: dropPct.toFixed(3),
        minDropPct: cfg.NEAR_ZERO_MIN_PRICE_DROP_PCT,
      });
      continue;
    }
    qualified.push(c);
  }

  // Phase 2b: OSINT prioritization — read OSINT signals and sort matches first.
  const osintMap = new Map<string, OsintSignal>();
  try {
    const cutoffS = Math.floor(Date.now() / 1000) - cfg.NEAR_ZERO_OSINT_SIGNAL_TTL_S;
    const members = await redis.zrangebyscore(NEAR_ZERO_OSINT_KEY, cutoffS, '+inf');
    for (const m of members) {
      try {
        const signal = JSON.parse(m) as OsintSignal;
        const key = `${signal.marketId}:${signal.direction}`;
        const existing = osintMap.get(key);
        if (!existing || signal.urgencyScore > existing.urgencyScore) {
          osintMap.set(key, signal);
        }
      } catch { /* skip malformed */ }
    }
  } catch {
    // Redis read failed — proceed without OSINT prioritization
  }

  // Split into OSINT-matched and non-OSINT, sort each group, then combine.
  const osintMatched: typeof qualified = [];
  const nonOsint: typeof qualified = [];
  for (const c of qualified) {
    const key = `${c.market.id}:${c.direction}`;
    if (osintMap.has(key)) {
      osintMatched.push(c);
    } else {
      nonOsint.push(c);
    }
  }

  // Phase 1d: Sort by price descending — higher near-zero prices are more
  // likely genuine mispricings than 3¢ markets which are usually correctly cheap.
  // OSINT-matched candidates come first, sorted by urgency descending.
  osintMatched.sort((a, b) => {
    const aSignal = osintMap.get(`${a.market.id}:${a.direction}`);
    const bSignal = osintMap.get(`${b.market.id}:${b.direction}`);
    return (bSignal?.urgencyScore ?? 0) - (aSignal?.urgencyScore ?? 0);
  });
  nonOsint.sort((a, b) => b.price - a.price);

  const sorted = [...osintMatched, ...nonOsint];

  // Cap to LLM budget per run.
  const toEvaluate = sorted.slice(0, cfg.NEAR_ZERO_MAX_CANDIDATES_PER_RUN);

  logger.info('[near-zero] scan summary', {
    total: candidates.length,
    multiOutcomeFiltered,
    fresh: fresh.length,
    validAfterFilters: valid.length,
    keywordFiltered,
    heuristicFiltered,
    deadHorseFiltered,
    qualified: qualified.length,
    osintMatched: osintMatched.length,
    evaluating: toEvaluate.length,
    enabled: cfg.NEAR_ZERO_SCANNER_ENABLED,
  });

  if (toEvaluate.length === 0) return;

  const bankrollUsd = await getBankroll(redis);

  for (const candidate of toEvaluate) {
    const dedupKey = `${DEDUP_KEY_PREFIX}${candidate.market.id}:${candidate.direction}`;
    const inflightKey = `${INFLIGHT_KEY_PREFIX}${candidate.market.id}:${candidate.direction}`;

    // Pre-LLM NX claim — prevents two concurrent scanner runs (or a scanner and
    // a manual invocation) from both paying the LLM cost for the same market.
    // Short TTL so a crashed worker doesn't block for long.
    const claimed = await redis.set(inflightKey, '1', 'EX', INFLIGHT_TTL_S, 'NX');
    if (claimed === null) {
      logger.debug('[near-zero] skipped — in-flight from concurrent run', {
        marketId: candidate.market.id,
        direction: candidate.direction,
      });
      continue;
    }

    // Phase 2c: Use real OSINT headline when available, generic prompt otherwise.
    const osintKey = `${candidate.market.id}:${candidate.direction}`;
    const osintSignal = osintMap.get(osintKey);
    const hasOsintSignal = osintSignal !== undefined;
    const headline = osintSignal
      ? osintSignal.headline
      : `Market price: ${(candidate.price * 100).toFixed(1)}¢. ` +
        `Assess whether the true probability of outcome "${candidate.direction}" ` +
        `is substantially higher than this price implies, based on fundamentals and context.`;

    let estimate;
    try {
      // Phase 3c: Use near-zero mode prompt (no "return 0.50 if unrelated" anchor)
      estimate = await estimateConsensusProbability({
        question: candidate.market.question,
        description: candidate.market.description ?? null,
        headline,
        redis,
        mode: 'near-zero',
        marketPrice: candidate.price,
        ...(candidate.market.endDate ? { endDateIso: candidate.market.endDate } : {}),
      });
    } catch (err) {
      // Deliberately leave dedupKey unset — a transient LLM failure should not
      // burn a full evaluation slot. The in-flight key expires on its own TTL.
      logger.warn('[near-zero] consensus estimation failed', {
        marketId: candidate.market.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Phase 3b: Direction-aware edge gate.
    // estimateConsensusProbability() returns P(YES) — the consensusProbability
    // invariant (see MEMORY.md). For NO candidates we need P(NO) = 1 - P(YES).
    const pYes = estimate.probability;
    const pOurSide = candidate.direction === 'YES' ? pYes : 1 - pYes;
    const edge = pOurSide - candidate.price;
    const meetsEdge = edge >= cfg.NEAR_ZERO_MIN_EDGE;
    // Stddev gate: reject noisy LLM consensus where providers disagree.
    const lowStddev = estimate.stddev <= cfg.NEAR_ZERO_MAX_STDDEV;

    // Observability-only flag: would this candidate have traded if the scanner
    // were enabled? Split from wouldExecute so shadow logs reflect the true
    // gate outcome regardless of the ENABLED switch.
    const wouldTradeIfEnabled =
      pOurSide >= cfg.NEAR_ZERO_MIN_CONSENSUS && meetsEdge && lowStddev;
    const wouldExecute = wouldTradeIfEnabled && cfg.NEAR_ZERO_SCANNER_ENABLED;

    logger.info('[near-zero] candidate evaluated', {
      marketId: candidate.market.id,
      question: candidate.market.question.slice(0, 100),
      direction: candidate.direction,
      marketPrice: candidate.price.toFixed(4),
      consensusPYes: pYes.toFixed(3),
      pOurSide: pOurSide.toFixed(3),
      stddev: estimate.stddev.toFixed(3),
      maxStddev: cfg.NEAR_ZERO_MAX_STDDEV,
      lowStddev,
      edge: edge.toFixed(3),
      minEdge: cfg.NEAR_ZERO_MIN_EDGE,
      meetsEdge,
      payoutRatio: ((1 - candidate.price) / candidate.price).toFixed(1),
      threshold: cfg.NEAR_ZERO_MIN_CONSENSUS,
      hasOsint: hasOsintSignal,
      wouldTradeIfEnabled,
      wouldExecute,
    });
    void enqueueWrite('shadow_observations', {
      kind: 'near_zero',
      source: 'osint',
      marketId: candidate.market.id,
      direction: candidate.direction,
      wouldBlock: !wouldTradeIfEnabled,
      metricValue: edge,
      threshold: cfg.NEAR_ZERO_MIN_EDGE,
      payload: {
        question: candidate.market.question.slice(0, 200),
        marketPrice: candidate.price,
        consensusPYes: pYes,
        pOurSide,
        stddev: estimate.stddev,
        maxStddev: cfg.NEAR_ZERO_MAX_STDDEV,
        lowStddev,
        meetsEdge,
        payoutRatio: (1 - candidate.price) / candidate.price,
        minConsensus: cfg.NEAR_ZERO_MIN_CONSENSUS,
        hasOsint: hasOsintSignal,
        wouldTradeIfEnabled,
        wouldExecute,
        scannerEnabled: cfg.NEAR_ZERO_SCANNER_ENABLED,
      },
    });

    // Successful evaluation — mark dedup so we don't re-LLM this candidate until
    // meaningfully-newer context exists. OSINT-matched evaluations refresh sooner
    // since a new headline is the most likely trigger for fresh signal.
    const dedupTtl = hasOsintSignal
      ? cfg.NEAR_ZERO_DEDUP_TTL_S
      : cfg.NEAR_ZERO_DEDUP_TTL_S_NON_OSINT;
    await redis.set(dedupKey, '1', 'EX', dedupTtl);

    if (!wouldExecute) continue;

    const clobTokenIds = parseClobTokenIds(candidate.market.clobTokenIds);
    const stakeUsd = Math.min(cfg.NEAR_ZERO_MAX_STAKE_USD, bankrollUsd * 0.02);

    const signal: TradeSignal = {
      marketId: candidate.market.id,
      conditionId: candidate.market.conditionId,
      clobTokenIds,
      question: candidate.market.question,
      direction: candidate.direction,
      stakeUsd,
      edgeMagnitude: Math.abs(edge),
      // consensusProbability is always P(YES) per project invariant
      consensusProbability: pYes,
      consensusStddev: estimate.stddev,
      outcomePrice: candidate.price,
      halfKellyFraction: 0,
      priceZone: priceZoneOf(candidate.price),
      sourcedFrom: osintSignal
        ? `near-zero-arb (OSINT: ${osintSignal.headline.slice(0, 80)})`
        : 'near-zero-arb',
      reasoning:
        `Near-zero scanner: market=${candidate.price.toFixed(3)}, ` +
        `P(${candidate.direction})=${pOurSide.toFixed(3)}, ` +
        `edge=${edge.toFixed(3)}, ` +
        `payout=${((1 - candidate.price) / candidate.price).toFixed(1)}x. ` +
        estimate.reasoning,
      source: 'near-zero-arb',
      endDate: candidate.market.endDate ?? undefined,
    };

    const result = await executeAndRecordSignal(signal, redis);
    if (!result.skipped) {
      logger.info('[near-zero] trade executed', {
        marketId: candidate.market.id,
        direction: candidate.direction,
        stakeUsd,
        venue: result.executionVenue,
        entryPrice: result.entryPrice,
      });
    } else {
      logger.info('[near-zero] trade skipped by executor', {
        marketId: candidate.market.id,
        skipReason: result.skipReason,
      });
    }
  }
}

async function main(): Promise<void> {
  const redis = getRedis();
  try {
    await runNearZeroScan(redis);
  } finally {
    await closeRedis();
  }
}

// Only auto-run when executed as the direct entrypoint, not when imported
// by tests or other modules.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/nearZeroScanner.js') === true ||
  process.argv[1]?.endsWith('/nearZeroScanner.ts') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[near-zero] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
