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
 * Ships with NEAR_ZERO_SCANNER_ENABLED=false. Shadow-log first (~1–2 weeks),
 * review `[near-zero] candidate evaluated` logs, then enable.
 *
 * Log marker: [near-zero] candidate evaluated
 * Dedup key:  near_zero:dedup:{marketId}:{direction}  (TTL: NEAR_ZERO_DEDUP_TTL_S)
 */

import 'dotenv/config';
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getBankroll } from '../shared/bankroll.js';
import { getCachedMarkets, getNearZeroPeakPrice } from '../shared/watchlist.js';
import { parseOutcomePrices, parseClobTokenIds } from '../mapping/gamma.js';
import { estimateConsensusProbability } from '../mapping/consensusCalculator.js';
import { checkTimeToResolution } from '../mapping/divergenceCalculator.js';
import { executeSignal } from '../execution/executor.js';
import { priceZoneOf } from '../shared/zones.js';
import type { TradeSignal } from '../mapping/index.js';

const DEDUP_KEY_PREFIX = 'near_zero:dedup:';

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

async function main() {
  const redis = getRedis();
  try {
    const cfg = loadConfig();

    // Load markets from local cache (Gamma search API is broken — use cache populated
    // by the every-4h watchlist refresh cron).
    const allMarkets = await getCachedMarkets(redis);
    if (allMarkets.length === 0) {
      logger.warn('[near-zero] market cache empty — ensure refreshWatchlist runs first');
      return;
    }

    // Filter to markets with YES or NO price in the near-zero range.
    const candidates: { market: (typeof allMarkets)[number]; direction: 'YES' | 'NO'; price: number }[] = [];
    for (const market of allMarkets) {
      try {
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
    const fresh: typeof candidates = [];
    for (const c of candidates) {
      const key = `${DEDUP_KEY_PREFIX}${c.market.id}:${c.direction}`;
      const exists = await redis.get(key);
      if (!exists) fresh.push(c);
    }

    // Apply liquidity, time-to-resolution, and keyword-exclusion gates.
    const keywordExcludes = parseKeywordList(cfg.NEAR_ZERO_EXCLUDE_KEYWORDS);
    let keywordFiltered = 0;
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
      return true;
    });

    // Dead-horse filter: require the market to have been above REPRICE_MIN_PEAK
    // at some point in the last REPRICE_LOOKBACK_DAYS. Markets with no history
    // yet are grandfathered in (first sighting — scanner gets a free look).
    let deadHorseFiltered = 0;
    const qualified: typeof valid = [];
    for (const c of valid) {
      if (!cfg.NEAR_ZERO_REQUIRE_REPRICE) {
        qualified.push(c);
        continue;
      }
      const peak = await getNearZeroPeakPrice(
        redis,
        c.market.id,
        c.direction,
        cfg.NEAR_ZERO_REPRICE_LOOKBACK_DAYS,
      );
      if (peak === null) {
        // No history yet — grandfather in.
        qualified.push(c);
        continue;
      }
      if (peak < cfg.NEAR_ZERO_REPRICE_MIN_PEAK) {
        deadHorseFiltered++;
        logger.debug('[near-zero] dead-horse filtered (no recent reprice)', {
          marketId: c.market.id,
          direction: c.direction,
          currentPrice: c.price.toFixed(4),
          peakDays: cfg.NEAR_ZERO_REPRICE_LOOKBACK_DAYS,
          peakPrice: peak.toFixed(4),
          threshold: cfg.NEAR_ZERO_REPRICE_MIN_PEAK,
        });
        continue;
      }
      qualified.push(c);
    }

    // Sort ascending by price — cheapest = most asymmetric = highest potential payout.
    qualified.sort((a, b) => a.price - b.price);

    // Cap to LLM budget per run.
    const toEvaluate = qualified.slice(0, cfg.NEAR_ZERO_MAX_CANDIDATES_PER_RUN);

    logger.info('[near-zero] scan summary', {
      total: candidates.length,
      fresh: fresh.length,
      validAfterLiquidityAndKeyword: valid.length,
      keywordFiltered,
      deadHorseFiltered,
      qualified: qualified.length,
      evaluating: toEvaluate.length,
      enabled: cfg.NEAR_ZERO_SCANNER_ENABLED,
    });

    if (toEvaluate.length === 0) return;

    const bankrollUsd = await getBankroll(redis);

    for (const candidate of toEvaluate) {
      const dedupKey = `${DEDUP_KEY_PREFIX}${candidate.market.id}:${candidate.direction}`;

      // Mark dedup before LLM call to prevent concurrent runs re-evaluating the same market.
      await redis.set(dedupKey, '1', 'EX', cfg.NEAR_ZERO_DEDUP_TTL_S);

      // The headline frames the structural mispricing angle rather than a news event.
      const headline =
        `Market price: ${(candidate.price * 100).toFixed(1)}¢. ` +
        `Assess whether the true probability of outcome "${candidate.direction}" ` +
        `is substantially higher than this price implies, based on fundamentals and context.`;

      let estimate;
      try {
        estimate = await estimateConsensusProbability({
          question: candidate.market.question,
          description: candidate.market.description ?? null,
          headline,
          redis,
        });
      } catch (err) {
        logger.warn('[near-zero] consensus estimation failed', {
          marketId: candidate.market.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      const wouldTrade =
        cfg.NEAR_ZERO_SCANNER_ENABLED &&
        estimate.probability >= cfg.NEAR_ZERO_MIN_CONSENSUS;

      logger.info('[near-zero] candidate evaluated', {
        marketId: candidate.market.id,
        question: candidate.market.question.slice(0, 100),
        direction: candidate.direction,
        marketPrice: candidate.price.toFixed(4),
        consensus: estimate.probability.toFixed(3),
        stddev: estimate.stddev.toFixed(3),
        payoutRatio: ((1 - candidate.price) / candidate.price).toFixed(1),
        threshold: cfg.NEAR_ZERO_MIN_CONSENSUS,
        wouldTrade,
      });

      if (!wouldTrade) continue;

      const clobTokenIds = parseClobTokenIds(candidate.market.clobTokenIds);
      const stakeUsd = Math.min(cfg.NEAR_ZERO_MAX_STAKE_USD, bankrollUsd * 0.02);

      const signal: TradeSignal = {
        marketId: candidate.market.id,
        conditionId: candidate.market.conditionId,
        clobTokenIds,
        question: candidate.market.question,
        direction: candidate.direction,
        stakeUsd,
        edgeMagnitude: Math.abs(estimate.probability - candidate.price),
        consensusProbability: estimate.probability,
        consensusStddev: estimate.stddev,
        outcomePrice: candidate.price,
        halfKellyFraction: 0,
        priceZone: priceZoneOf(candidate.price),
        sourcedFrom: 'near-zero-arb',
        reasoning:
          `Near-zero scanner: market=${candidate.price.toFixed(3)}, ` +
          `consensus=${estimate.probability.toFixed(3)}, ` +
          `payout=${((1 - candidate.price) / candidate.price).toFixed(1)}x. ` +
          estimate.reasoning,
        source: 'near-zero-arb',
        endDate: candidate.market.endDate ?? undefined,
      };

      const result = await executeSignal(signal, redis, stakeUsd);
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
  } finally {
    await closeRedis();
  }
}

void main().catch((err) => {
  logger.error('[near-zero] fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
