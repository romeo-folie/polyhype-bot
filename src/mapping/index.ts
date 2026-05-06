/**
 * Phase 2: Market Mapping & Execution Logic
 *
 * Orchestrates the full mapping pipeline:
 *   1. For each high-urgency ingestion item, find candidate Polymarket markets
 *   2. For each candidate, estimate consensus probability via LLM
 *   3. Compute divergence; if edge ≥ threshold, produce a trade signal
 *
 * Returns an array of TradeSignal objects ready for Phase 3 execution.
 */

import { randomUUID } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { findCandidateMarkets, type CandidateMarket } from './entityExtractor.js';
import { scoreMarketRelevance } from './relevanceGate.js';
import { estimateConsensusProbability, estimateSentiment } from './consensusCalculator.js';
import { computeDivergence, checkTimeToResolution } from './divergenceCalculator.js';
import { resolveYesPrice, resolveNoPrice } from '../shared/priceCache.js';
import { resolveHlSymbol } from '../shared/hyperliquid.js';
import { getRedis } from '../shared/redis.js';
import { priceZoneOf } from '../shared/zones.js';
import { scoreConfluence } from '../arb/confluenceScorer.js';
import { computeATR } from '../arb/indicators.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import type { ScoredItem } from '../ingestion/scorer.js';
import type { Redis } from 'ioredis';
import type { ClobPriceFeed } from '../shared/clobWebSocket.js';

const NEAR_ZERO_OSINT_KEY = 'near_zero:osint_signals';

/**
 * OSINT→Polymarket mapping is strictly for political/macro/tech binary markets.
 * Sports items (e.g. "Warriors vs Clippers Play-In preview") surface high-
 * liquidity NBA markets via /public-search, the LLM scores team-match as a
 * causal chain (~0.5-0.7), and the divergence gate was only blocked by a
 * coincidental governor throttle on 2026-04-15. Reject non-political items
 * at the pipeline entry so they never reach candidate retrieval.
 */
const OSINT_MAPPING_ALLOWED_CATEGORIES = new Set<string>([
  'geopolitical',
  'crypto-regulatory',
  'us-politics',
  'macro',
  'ai-tech',
]);

export { OSINT_MAPPING_ALLOWED_CATEGORIES };

export interface TradeSignal {
  /** Gamma market ID or Hyperliquid symbol */
  marketId: string;
  conditionId?: string;
  clobTokenIds?: string[];
  executionId?: string;
  /** UUID minted at signal decision time — links signal_decisions → execution_events → outcomes */
  decisionId?: string;
  question: string;
  direction: 'YES' | 'NO' | 'UP' | 'DOWN' | 'LONG' | 'SHORT';
  stakeUsd: number;
  edgeMagnitude: number;
  consensusProbability?: number;
  /** Standard deviation of consensus probability across N LLM samples */
  consensusStddev?: number;
  outcomePrice: number;
  halfKellyFraction?: number;
  /** The OSINT headline that triggered this signal */
  sourcedFrom: string;
  /** LLM reasoning for the probability estimate */
  reasoning: string;
  /** Futures-specific */
  isFutures?: boolean;
  leverage?: number;
  symbol?: string;
  /** True when the Gamma market has fees enabled — executor skips CLOB for these */
  feesEnabled?: boolean;
  /** Origin of the signal, used for execution routing (e.g. bypassing Simmer for arb) */
  source?: 'osint' | 'crypto-arb' | 'futures' | 'copytrade' | 'spot' | 'sports' | 'clob-flow' | 'arb' | 'near-zero-arb' | 'oracle-lag' | 'longshot-bias' | 'correlation-arb' | 'hl-momentum' | 'weather' | 'fv-scanner';
  /** Origin event timestamp (e.g. Binance kline event time) — used for end-to-end latency tracking */
  eventTs?: number | undefined;
  /** Operational metadata for alerts/telemetry */
  latencyMs?: number | undefined;
  volatility?: number | undefined;
  spreadBps?: number | undefined;
  assetId?: string | undefined;
  endDate?: string | undefined;
  /** Price-zone classification for the entry outcome price (Change 3 telemetry). */
  priceZone?: 1 | 2 | 3 | 4 | 5;
}

/**
 * Run the market mapping pipeline on a set of high-urgency items.
 *
 * @param items      High-urgency scored items from Phase 1.
 * @param bankrollUsd Current portfolio value in USD (passed in from caller for testability).
 * @param opts       Optional WebSocket feed + Redis for real-time price resolution.
 */
export async function runMapping(
  items: ScoredItem[],
  bankrollUsd: number,
  opts?: { redis?: Redis; feed?: ClobPriceFeed },
): Promise<TradeSignal[]> {
  const cfg = loadConfig();

  // Per-market deduplication: tracks the highest-edge signal seen for each market.
  // Multiple headlines in one cycle can match the same market; emitting duplicate
  // signals would create over-exposure. We keep only the strongest edge per market.
  const bestByMarket = new Map<string, TradeSignal>();

  for (const item of items) {
    if (!OSINT_MAPPING_ALLOWED_CATEGORIES.has(item.categoryId)) {
      logger.info('[mapping] skipping item — category not eligible for Polymarket mapping', {
        title: item.title,
        categoryId: item.categoryId,
      });
      continue;
    }

    logger.info('[mapping] processing item', { title: item.title, urgency: item.urgencyScore });

    let candidates;
    try {
      candidates = await findCandidateMarkets(item);
    } catch (err) {
      logger.error('[mapping] failed to find candidate markets', {
        title: item.title,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (candidates.length === 0) {
      logger.info('[mapping] no candidate markets found', { title: item.title });
      continue;
    }

    logger.info('[mapping] evaluating candidates', {
      title: item.title,
      count: candidates.length,
    });

    // Evaluate the highest-ranked candidates (match-strength desc, liquidity desc),
    // capped at RELEVANCE_CANDIDATE_CAP to control LLM spend per headline.
    // Widened from the historical hard-coded 10 once match-strength ranking
    // was introduced — relevance-gate caching makes the extra scores cheap,
    // and the wider funnel surfaces correct-but-low-liquidity political
    // markets that the old liquidity-only top-10 was evicting.
    const toEvaluate = candidates.slice(0, cfg.RELEVANCE_CANDIDATE_CAP);

    // Score candidates sequentially. The relevance cache makes repeat calls
    // cheap, and serial scoring avoids a 10x concurrent-LLM burst per headline
    // (matches the old cascade's serial cost profile).
    const scored: { candidate: CandidateMarket; fitScore: number }[] = [];
    for (const c of toEvaluate) {
      const { fitScore } = await scoreMarketRelevance({
        headline: item.title,
        question: c.question,
        description: c.description,
      });
      scored.push({ candidate: c, fitScore });
    }
    const scoreByMarket = new Map(scored.map((s) => [s.candidate.marketId, s.fitScore]));

    // Near-zero OSINT signal: fire for every fit-qualified candidate (observability
    // for the near-zero scanner, independent of trade selection). Resolve YES
    // and NO prices independently — Polymarket quotes per outcome, so 1 - YES
    // ≠ NO by a few cents of spread/overround. At 1–5¢ bands, that spread
    // flips near-zero signals on/off, so we must read each side directly.
    for (const { candidate, fitScore } of scored) {
      if (fitScore < cfg.RELEVANCE_MIN_FIT_SCORE) continue;
      let yesPrice = candidate.currentYesPrice;
      let noPrice: number | null = null;
      if (opts?.redis && opts.feed) {
        const [wsYes, wsNo] = await Promise.all([
          resolveYesPrice(candidate.marketId, opts.redis, opts.feed),
          resolveNoPrice(candidate.marketId, opts.redis),
        ]);
        if (wsYes !== null) yesPrice = wsYes;
        if (wsNo !== null) noPrice = wsNo;
      }
      if (yesPrice >= cfg.NEAR_ZERO_MIN_PRICE && yesPrice <= cfg.NEAR_ZERO_MAX_PRICE) {
        void writeNearZeroOsintSignal(candidate.marketId, 'YES', yesPrice, item, cfg);
      } else if (
        noPrice !== null &&
        noPrice >= cfg.NEAR_ZERO_MIN_PRICE &&
        noPrice <= cfg.NEAR_ZERO_MAX_PRICE
      ) {
        void writeNearZeroOsintSignal(candidate.marketId, 'NO', noPrice, item, cfg);
      }
    }

    // Rank by fitScore desc; sort is stable so liquidity order (from
    // findCandidateMarkets) is preserved as tiebreak.
    const fitRanked = scored
      .filter((s) => s.fitScore >= cfg.RELEVANCE_MIN_FIT_SCORE)
      .sort((a, b) => b.fitScore - a.fitScore);

    if (fitRanked.length === 0) {
      logger.info('[mapping] no fit-qualified candidate', {
        title: item.title,
        candidatesScored: scored.length,
        threshold: cfg.RELEVANCE_MIN_FIT_SCORE,
      });
      continue;
    }

    const topFit = fitRanked[0]!;

    if (cfg.STRICT_TOP_FIT_ENABLED) {
      // LIVE strict mode: evaluate only the highest-fit candidate. If it's
      // gated, drop the headline — no cascade to weaker-fit markets.
      const result = await evaluateOsintCandidate({
        candidate: topFit.candidate,
        fitScore: topFit.fitScore,
        item,
        bankrollUsd,
        cfg,
        opts,
      });
      if (result.signal) {
        registerSignal(bestByMarket, result.signal);
      } else {
        logger.info('[mapping] top-fit gated (strict mode)', {
          title: item.title,
          marketId: topFit.candidate.marketId,
          fitScore: topFit.fitScore.toFixed(3),
          skipReason: result.skipReason,
        });
      }

      // Sibling fan-out: after evaluating the top-fit market, also evaluate
      // other fit-qualified candidates that share the same Gamma event. These
      // are structurally correlated (same event umbrella) so the same news
      // item may move multiple legs simultaneously.
      const siblingEventId = topFit.candidate.eventId;
      if (siblingEventId && fitRanked.length > 1) {
        const siblings = fitRanked
          .slice(1) // exclude top-fit itself
          .filter(
            (s) =>
              s.candidate.eventId === siblingEventId &&
              s.fitScore >= cfg.OSINT_SIBLING_MIN_FIT_SCORE,
          )
          .slice(0, cfg.OSINT_SIBLING_MAX_PER_EVENT);

        if (siblings.length > 0) {
          logger.info('[mapping] sibling_fanout evaluating', {
            title: item.title,
            eventId: siblingEventId,
            siblingCount: siblings.length,
            enabled: cfg.OSINT_SIBLING_FANOUT_ENABLED,
          });

          for (const sibling of siblings) {
            const sibResult = await evaluateOsintCandidate({
              candidate: sibling.candidate,
              fitScore: sibling.fitScore,
              item,
              bankrollUsd,
              cfg,
              opts,
            });
            if (sibResult.signal) {
              if (cfg.OSINT_SIBLING_FANOUT_ENABLED) {
                registerSignal(bestByMarket, sibResult.signal);
              }
              logger.info('[mapping] sibling_fanout result', {
                marketId: sibling.candidate.marketId,
                fitScore: sibling.fitScore.toFixed(3),
                hasTrade: true,
                enabled: cfg.OSINT_SIBLING_FANOUT_ENABLED,
              });
            } else {
              logger.debug('[mapping] sibling_fanout gated', {
                marketId: sibling.candidate.marketId,
                skipReason: sibResult.skipReason,
              });
            }
            void enqueueWrite('shadow_observations', {
              kind: 'osint_sibling_fanout',
              source: 'osint',
              marketId: sibling.candidate.marketId,
              wouldBlock: !cfg.OSINT_SIBLING_FANOUT_ENABLED && sibResult.signal != null,
              metricValue: sibling.fitScore,
              threshold: cfg.OSINT_SIBLING_MIN_FIT_SCORE,
              payload: {
                eventId: siblingEventId,
                topFitMarketId: topFit.candidate.marketId,
                siblingFitScore: sibling.fitScore,
                hasTrade: sibResult.signal !== null,
                skipReason: sibResult.skipReason,
              },
            });
          }
        }
      }

      continue;
    }

    // SHADOW mode: keep current cascade behavior (evaluate all fit-qualified
    // candidates in liquidity order, highest-edge wins per market via
    // bestByMarket dedup) BUT log what strict top-1 would have done so we can
    // review divergence before flipping STRICT_TOP_FIT_ENABLED=true.
    let cascadeFirstTradedMarketId: string | null = null;
    let cascadeFirstTradedFit: number | null = null;
    for (const candidate of toEvaluate) {
      const fitScore = scoreByMarket.get(candidate.marketId) ?? 0;
      if (fitScore < cfg.RELEVANCE_MIN_FIT_SCORE) continue;
      const result = await evaluateOsintCandidate({
        candidate,
        fitScore,
        item,
        bankrollUsd,
        cfg,
        opts,
      });
      if (result.signal) {
        registerSignal(bestByMarket, result.signal);
        if (cascadeFirstTradedMarketId === null) {
          cascadeFirstTradedMarketId = candidate.marketId;
          cascadeFirstTradedFit = fitScore;
        }
      }
    }

    const agree =
      cascadeFirstTradedMarketId !== null &&
      cascadeFirstTradedMarketId === topFit.candidate.marketId;
    // wouldBlock captures the Kharg-Island failure mode specifically: cascade
    // traded some market AND strict top-fit would have picked a different one
    // (or dropped). Pure "nothing traded" isn't a block event for this kind.
    const wouldBlock =
      cascadeFirstTradedMarketId !== null &&
      cascadeFirstTradedMarketId !== topFit.candidate.marketId;

    logger.info('[mapping] top_fit_shadow', {
      title: item.title,
      topFitMarketId: topFit.candidate.marketId,
      topFitScore: topFit.fitScore.toFixed(3),
      cascadeTradedMarketId: cascadeFirstTradedMarketId,
      cascadeTradedFit: cascadeFirstTradedFit?.toFixed(3) ?? null,
      agree,
      wouldBlock,
      fitQualifiedCount: fitRanked.length,
    });
    void enqueueWrite('shadow_observations', {
      kind: 'top_fit',
      source: 'osint',
      marketId: topFit.candidate.marketId,
      wouldBlock,
      metricValue: topFit.fitScore,
      threshold: cfg.RELEVANCE_MIN_FIT_SCORE,
      payload: {
        cascadeTradedMarketId: cascadeFirstTradedMarketId,
        cascadeTradedFit: cascadeFirstTradedFit,
        fitQualifiedCount: fitRanked.length,
        headline: item.title.slice(0, 200),
      },
    });
  }

  const signals = Array.from(bestByMarket.values());

  logger.info('[mapping] pipeline complete', {
    itemsProcessed: items.length,
    signalsGenerated: signals.length,
  });

  return signals;
}

interface EvaluateCandidateArgs {
  candidate: CandidateMarket;
  fitScore: number;
  item: ScoredItem;
  bankrollUsd: number;
  cfg: ReturnType<typeof loadConfig>;
  opts?: { redis?: Redis; feed?: ClobPriceFeed } | undefined;
}

interface EvaluateCandidateResult {
  signal: TradeSignal | null;
  skipReason: string | undefined;
}

/**
 * Run the full per-candidate mapping step: WS subscribe, resolve price,
 * consensus estimation, divergence + gates, enqueue signal_decisions, and
 * produce a TradeSignal if every gate passes. Returned signal is null when
 * any stage fails.
 */
async function evaluateOsintCandidate(args: EvaluateCandidateArgs): Promise<EvaluateCandidateResult> {
  const { candidate, item, bankrollUsd, cfg, opts } = args;

  // Pre-screen time horizon before any downstream work. The full gate runs
  // again inside computeDivergence but doing it here avoids the WS subscribe,
  // price resolution, and 3 consensus provider calls for markets that will be
  // rejected as too_long_dated regardless.
  const ttr = checkTimeToResolution(candidate.endDate ?? undefined, cfg.PM_MAX_HOURS_TO_RESOLUTION_OSINT, cfg.PM_MIN_HOURS_TO_RESOLUTION);
  if (!ttr.ok) {
    return { signal: null, skipReason: ttr.skipReason ?? 'time_to_resolution' };
  }

  // Category gate: OSINT only operates on its allowed categories. Check before
  // any LLM calls so we don't burn API budget on weather/crypto markets that
  // have dedicated scanners.
  if (cfg.OSINT_ALLOWED_CATEGORIES.length > 0) {
    const preCategory = inferCategory(candidate.question);
    if (!cfg.OSINT_ALLOWED_CATEGORIES.includes(preCategory)) {
      return { signal: null, skipReason: 'osint_category_blocked' };
    }
  }

  // Subscribe to WS updates for high-urgency items
  if (opts?.feed && item.urgencyScore >= cfg.URGENCY_THRESHOLD) {
    await opts.feed.watch(candidate.marketId, candidate.clobTokenIds);
  }

  // Resolve price: WS cache first, then fall back to Gamma snapshot
  let currentYesPrice = candidate.currentYesPrice;
  if (opts?.redis && opts.feed) {
    const wsPrice = await resolveYesPrice(candidate.marketId, opts.redis, opts.feed);
    if (wsPrice !== null) currentYesPrice = wsPrice;
  }

  let consensus;
  try {
    consensus = await estimateConsensusProbability({
      question: candidate.question,
      description: candidate.description,
      headline: item.title,
      ...(opts?.redis ? { redis: opts.redis } : {}),
      ...(candidate.endDate ? { endDateIso: candidate.endDate } : {}),
    });
  } catch (err) {
    logger.warn('[mapping] consensus estimation failed', {
      marketId: candidate.marketId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { signal: null, skipReason: 'consensus_failed' };
  }

  const decisionId = randomUUID();
  const marketCategory = inferCategory(candidate.question);
  const { hasTrade, decision, skipReason } = computeDivergence({
    consensusProbability: consensus.probability,
    consensusStddev: consensus.stddev,
    currentYesPrice,
    bankrollUsd,
    divergenceThreshold: cfg.DIVERGENCE_THRESHOLD,
    maxBetFraction: cfg.MAX_BET_FRACTION,
    bookDepthUsd: candidate.liquidity,
    minPriceForLlmTrust: cfg.MIN_PRICE_FOR_LLM_TRUST,
    maxLlmProbAtLowPrice: cfg.MAX_LLM_PROB_AT_LOW_PRICE,
    ...(candidate.endDate ? { endDate: candidate.endDate } : {}),
    source: 'osint',
    maxHoursToResolution: cfg.PM_MAX_HOURS_TO_RESOLUTION_OSINT,
    minHoursToResolution: cfg.PM_MIN_HOURS_TO_RESOLUTION,
    zone3FeeBuffer: cfg.ZONE3_FEE_BUFFER,
    zone4DirectionalBlock: cfg.ZONE4_DIRECTIONAL_BLOCK,
    zone5DirectionalBlock: cfg.ZONE5_DIRECTIONAL_BLOCK,
    category: marketCategory,
    kellyFraction: cfg.KELLY_FRACTION,
    noiseStddevThreshold: cfg.NOISE_STDDEV_THRESHOLD,
    consensusSampleCount: consensus.sampleCount,
    consensusTargetSamples: cfg.CONSENSUS_TARGET_SAMPLES,
    consensusMinSamples: cfg.CONSENSUS_MIN_SAMPLES,
    kellyProbeDelta: cfg.KELLY_PROBE_DELTA,
    kellyRequireSignStable: cfg.KELLY_REQUIRE_SIGN_STABLE,
    calibrationBiasEnabled: cfg.CALIBRATION_BIAS_ENABLED,
    anchorCollapsePDelta: cfg.ANCHOR_COLLAPSE_P_DELTA,
    anchorCollapseStddevEpsilon: cfg.ANCHOR_COLLAPSE_STDDEV_EPSILON,
  });

  logger.info('[mapping] divergence result', {
    marketId: candidate.marketId,
    question: candidate.question.substring(0, 80),
    fitScore: args.fitScore.toFixed(3),
    consensusP: consensus.probability.toFixed(3),
    consensusStddev: consensus.stddev.toFixed(3),
    marketP: currentYesPrice.toFixed(3),
    hasTrade,
    skipReason,
    direction: decision?.direction,
    stakeUsd: decision?.stakeUsd.toFixed(2),
  });

  void enqueueWrite('signal_decisions', {
    decisionId,
    source: 'osint',
    marketId: candidate.marketId,
    conditionId: candidate.conditionId,
    question: candidate.question,
    category: marketCategory,
    direction: decision?.direction,
    hasTrade,
    skipReason: skipReason ?? (hasTrade ? undefined : 'other'),
    consensusProbability: consensus.probability,
    consensusStddev: consensus.stddev,
    consensusSampleCount: consensus.sampleCount,
    currentYesPrice,
    divergence: decision?.edgeMagnitude,
    kellyFraction: decision?.halfKellyFraction,
    priceZone: decision?.priceZone,
    bankrollUsd,
    stakeAttemptedUsd: decision?.stakeUsd,
    bookDepthUsd: candidate.liquidity != null ? Number(candidate.liquidity) : undefined,
    sourceHeadline: item.title.slice(0, 200),
  });

  if (!hasTrade || !decision) {
    return { signal: null, skipReason };
  }

  const signal: TradeSignal = {
    marketId: candidate.marketId,
    conditionId: candidate.conditionId,
    clobTokenIds: candidate.clobTokenIds,
    question: candidate.question,
    direction: decision.direction,
    stakeUsd: decision.stakeUsd,
    edgeMagnitude: decision.edgeMagnitude,
    consensusProbability: decision.consensusProbability,
    consensusStddev: consensus.stddev,
    outcomePrice: decision.outcomePrice,
    halfKellyFraction: decision.halfKellyFraction,
    priceZone: decision.priceZone,
    sourcedFrom: item.title,
    reasoning: consensus.reasoning,
    source: 'osint',
    latencyMs: item.latencyMs,
    endDate: candidate.endDate ?? undefined,
    decisionId,
    // assetId is not directly known from entity extraction, but usually
    // inferred by the monitor or stored if known from spot move.
  };
  return { signal, skipReason: undefined };
}

/** Per-market dedup: keep the signal with the highest edge. */
function registerSignal(bestByMarket: Map<string, TradeSignal>, signal: TradeSignal): void {
  const existing = bestByMarket.get(signal.marketId);
  if (!existing || signal.edgeMagnitude > existing.edgeMagnitude) {
    bestByMarket.set(signal.marketId, signal);
  }
}

/**
 * Write an OSINT signal for the near-zero scanner when a mapping candidate
 * happens to have a side in the near-zero price range. Fire-and-forget.
 */
async function writeNearZeroOsintSignal(
  marketId: string,
  direction: 'YES' | 'NO',
  price: number,
  item: ScoredItem,
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  try {
    const redis = getRedis();
    const member = JSON.stringify({
      marketId,
      direction,
      price,
      headline: item.title.slice(0, 300),
      urgencyScore: item.urgencyScore,
    });
    const nowS = Math.floor(Date.now() / 1000);
    await redis.zadd(NEAR_ZERO_OSINT_KEY, nowS, member);
    // Prune entries older than TTL
    const cutoff = nowS - cfg.NEAR_ZERO_OSINT_SIGNAL_TTL_S;
    await redis.zremrangebyscore(NEAR_ZERO_OSINT_KEY, '-inf', cutoff);
  } catch (err) {
    logger.warn('[mapping] near-zero OSINT signal write failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * High-speed mapping for News -> Futures.
 */
export async function mapNewsToFutures(
  items: ScoredItem[],
  bankrollUsd: number,
): Promise<TradeSignal[]> {
  const cfg = loadConfig();
  if (!cfg.FUTURES_ENABLED) return [];

  const signals: TradeSignal[] = [];

  for (const item of items) {
    if (item.urgencyScore < cfg.FUTURES_URGENCY_THRESHOLD) continue;

    // 1. Identify asset using shared symbol resolution logic
    const symbol = resolveHlSymbol(item.title);
    if (!symbol) continue;

    // 2. Loss cooldown gate — skip if we just lost a trade on this symbol
    const cooldownKey = `futures:loss-cooldown:${symbol}`;
    const onCooldown = await getRedis().exists(cooldownKey);
    if (onCooldown) {
      logger.info('[mapping] futures skipped — loss cooldown active', { symbol, title: item.title });
      continue;
    }

    // 3. Perform zero-shot LLM sentiment analysis
    const direction = await estimateSentiment(item.title);
    if (direction === 'NEUTRAL') {
      logger.info('[mapping] skipping HL signal — neutral sentiment', {
        symbol,
        title: item.title,
      });
      continue;
    }

    // TA confluence gate — block if indicators disagree with LLM sentiment
    if (cfg.FUTURES_CONFLUENCE_GATE_ENABLED) {
      const redis = getRedis();
      const confluence = await scoreConfluence(symbol, redis);
      const expectedDir = direction === 'LONG' ? 'UP' : 'DOWN';

      // === Shadow logs (Phase 2/3 validation) ===
      // Hoisted above the score gate so they accumulate samples on every
      // confluence evaluation, not just the rare ones that pass.
      if (cfg.NEWS_FUTURES_REGIME_GATES_ENABLED) {
        if (confluence.volume?.ratio !== null && confluence.volume?.ratio !== undefined) {
          if (!cfg.VOLUME_SPIKE_GATE_ENABLED) {
            const ratio = confluence.volume.ratio;
            const passed = ratio >= cfg.VOLUME_SPIKE_MULT;
            logger.info('[mapping] volume_spike shadow', {
              symbol, direction,
              wouldBlock: !passed,
              volRatio: ratio.toFixed(2),
              volMult: cfg.VOLUME_SPIKE_MULT,
              confluenceScore: confluence.score,
            });
            void enqueueWrite('shadow_observations', {
              kind: 'volume_spike', source: 'futures', symbol, direction,
              wouldBlock: !passed, metricValue: ratio, threshold: cfg.VOLUME_SPIKE_MULT,
              payload: { confluenceScore: confluence.score },
            });
          }
        }
        const adxValShadow = confluence.regime?.adx ?? null;
        if (adxValShadow !== null && !cfg.ADX_GATE_ENABLED) {
          const adxPassed = adxValShadow >= cfg.ADX_MIN;
          logger.info('[mapping] adx shadow', {
            symbol, direction,
            wouldBlock: !adxPassed,
            adx: adxValShadow.toFixed(2), adxMin: cfg.ADX_MIN,
            confluenceScore: confluence.score,
          });
          void enqueueWrite('shadow_observations', {
            kind: 'adx', source: 'futures', symbol, direction,
            wouldBlock: !adxPassed, metricValue: adxValShadow, threshold: cfg.ADX_MIN,
            payload: { confluenceScore: confluence.score },
          });
        }
        const chopValShadow = confluence.regime?.choppiness ?? null;
        if (chopValShadow !== null && !cfg.CHOPPINESS_GATE_ENABLED) {
          const chopPassed = chopValShadow <= cfg.CHOPPINESS_MAX;
          logger.info('[mapping] choppiness shadow', {
            symbol, direction,
            wouldBlock: !chopPassed,
            choppiness: chopValShadow.toFixed(2), chopMax: cfg.CHOPPINESS_MAX,
            confluenceScore: confluence.score,
          });
          void enqueueWrite('shadow_observations', {
            kind: 'choppiness', source: 'futures', symbol, direction,
            wouldBlock: !chopPassed, metricValue: chopValShadow, threshold: cfg.CHOPPINESS_MAX,
            payload: { confluenceScore: confluence.score },
          });
        }
      }

      // === Hard gates ===
      if (confluence.score < cfg.FUTURES_MIN_CONFLUENCE_SCORE) {
        logger.info('[mapping] futures confluence_block — score too low', {
          symbol, direction, score: confluence.score,
          signals: confluence.signals, title: item.title,
        });
        continue;
      }
      if (confluence.direction !== expectedDir) {
        logger.info('[mapping] futures confluence_block — direction mismatch', {
          symbol, direction,
          confluenceDirection: confluence.direction, score: confluence.score,
          signals: confluence.signals, title: item.title,
        });
        continue;
      }
      if (
        cfg.NEWS_FUTURES_REGIME_GATES_ENABLED &&
        cfg.VOLUME_SPIKE_GATE_ENABLED &&
        confluence.volume?.ratio !== null && confluence.volume?.ratio !== undefined &&
        confluence.volume.ratio < cfg.VOLUME_SPIKE_MULT
      ) {
        logger.info('[mapping] futures volume_spike_block', {
          symbol, direction,
          volRatio: confluence.volume.ratio.toFixed(2),
          volMult: cfg.VOLUME_SPIKE_MULT,
          title: item.title,
        });
        continue;
      }
      const adxVal = confluence.regime?.adx ?? null;
      if (cfg.NEWS_FUTURES_REGIME_GATES_ENABLED && cfg.ADX_GATE_ENABLED && adxVal !== null && adxVal < cfg.ADX_MIN) {
        logger.info('[mapping] futures regime_no_trend', {
          symbol, direction,
          adx: adxVal.toFixed(2), adxMin: cfg.ADX_MIN, title: item.title,
        });
        continue;
      }
      const chopVal = confluence.regime?.choppiness ?? null;
      if (cfg.NEWS_FUTURES_REGIME_GATES_ENABLED && cfg.CHOPPINESS_GATE_ENABLED && chopVal !== null && chopVal > cfg.CHOPPINESS_MAX) {
        logger.info('[mapping] futures regime_chop', {
          symbol, direction,
          choppiness: chopVal.toFixed(2), chopMax: cfg.CHOPPINESS_MAX, title: item.title,
        });
        continue;
      }

      logger.info('[mapping] futures confluence_pass', {
        symbol, direction, score: confluence.score,
        signals: confluence.signals,
        volRatio: confluence.volume?.ratio?.toFixed(2),
        adx: confluence.regime?.adx?.toFixed(2),
        choppiness: confluence.regime?.choppiness?.toFixed(2),
        bbRegime: confluence.regime?.bbRegime,
      });
    }

    // Scale stakeUsd based on urgency (e.g. 6/10 urgency = 60% of max allowed stake).
    const maxStake = Math.min(cfg.FUTURES_MAX_PER_TRADE_USD, bankrollUsd * cfg.MAX_BET_FRACTION);
    let stakeUsd = maxStake * (item.urgencyScore / 10);

    // Volatility-adjusted sizing: scale stake inversely with ATR
    if (cfg.FUTURES_VOL_SIZING_ENABLED) {
      const redis = getRedis();
      const atrResult = await computeATR(symbol, redis);
      if (atrResult && atrResult.atrPct > 0) {
        const volMultiplier = Math.max(0.3, Math.min(1.5, cfg.FUTURES_ATR_BASELINE_PCT / atrResult.atrPct));
        stakeUsd *= volMultiplier;
        logger.info('[mapping] vol-adjusted sizing', {
          symbol, atrPct: atrResult.atrPct.toFixed(3),
          baseline: cfg.FUTURES_ATR_BASELINE_PCT, volMultiplier: volMultiplier.toFixed(2),
          adjustedStake: stakeUsd.toFixed(2),
        });
      }
    }

    signals.push({
      marketId: symbol,
      question: `News Futures: ${symbol} ${direction}`,
      direction,
      stakeUsd,
      edgeMagnitude: item.urgencyScore / 10,
      outcomePrice: 0, // Market order
      isFutures: true,
      leverage: cfg.FUTURES_DEFAULT_LEVERAGE,
      priceZone: priceZoneOf(0),
      sourcedFrom: `News: ${item.title}`,
      reasoning: `High-urgency news detected for ${symbol} with ${direction} sentiment. Urgency: ${item.urgencyScore}. Executing single-signal HL Perp via rapid LLM classification.`,
      source: 'futures',
      latencyMs: item.latencyMs,
      assetId: symbol,
    });

    // Only one futures signal per news item to prevent over-trading
  }

  return signals;
}
