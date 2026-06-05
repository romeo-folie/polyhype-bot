/**
 * Copytrade Hedge Scanner
 *
 * For each open copytrade position on a binary market, checks whether buying
 * the opposite side creates a guaranteed profit (Tier 1 arb) or caps max loss
 * (Tier 2 damage control) given the position's entry price and current prices.
 *
 * Tier 1 — Pure arb: entry_price + hedge_ask < ARB_CEILING (~0.985 after fees).
 *   Sizes for equal profit in both outcome scenarios.
 *   hedge_stake = original_stake × hedge_ask / entry_price
 *
 * Tier 2 — Damage control: hedge_ask < q_max(entry_price, max_loss_fraction).
 *   Sizes to cap loss at max_loss_fraction × stake if the hedge wins.
 *   hedge_stake = stake × (1 - max_loss_fraction) × hedge_ask / (1 - hedge_ask)
 *
 * The q_max gate — (1 - entry_price) / (1 - entry_price × max_loss_fraction) —
 * ensures the original-position-wins scenario stays profitable after hedge cost
 * in both tiers. Beyond that threshold the hedge hurts more than it helps.
 *
 * Ships dark (COPYTRADE_HEDGE_ENABLED=false). Shadow-logs all evaluations.
 *
 * Log marker: [copytrade-hedge]
 * Redis key:  copytrade:hedged:{positionId}  (TTL: 7 days)
 */

import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getSql } from '../db/client.js';
import { getMarket, parseClobTokenIds } from '../mapping/gamma.js';
import { getClobOrderBook, submitClobBuy } from '../shared/clob.js';
import { getBookTouchLevels } from '../shared/bookTouch.js';
import { deductStake } from '../shared/bankroll.js';
import { notify } from '../execution/telegram.js';

const HEDGE_KEY_PREFIX = 'copytrade:hedged:';
// 90 days: safely exceeds the longest realistic copytrade hold.
const HEDGE_TTL_S = 90 * 24 * 3600;
const MIN_FILL_RATIO = 0.85;
// Combined entry + hedge ask ceiling for Tier 1 arb (nets ~1.5% fee buffer).
const ARB_CEILING = 0.985;

interface OpenCopytradePosition {
  id: string;
  marketId: string;
  question: string;
  direction: 'YES' | 'NO';
  entryPrice: number;
  stakeUsd: number;
  sharesHeld: number;
}

async function fetchOpenCopytradePositions(): Promise<OpenCopytradePosition[]> {
  const sql = getSql();
  return sql<OpenCopytradePosition[]>`
    SELECT
      id::text             AS id,
      market_id            AS "marketId",
      question,
      direction::text      AS direction,
      entry_price::float8  AS "entryPrice",
      stake_usd::float8    AS "stakeUsd",
      shares_held::float8  AS "sharesHeld"
    FROM positions
    WHERE sourced_from LIKE 'copytrade:%'
      AND pending_settlement = false
      AND closed_at IS NULL
      AND shares_held > 0
      AND stake_usd > 0
      AND entry_price > 0
    ORDER BY opened_at DESC
  `;
}

/**
 * Maximum hedge price at which the original-position-wins scenario stays
 * profitable after accounting for hedge cost.
 *
 * Derivation: hedge_stake < (shares_held - stake) requires
 *   Y < stake*(1-p)/p.  The Tier 2 sizing Y = stake*(1-mf)*q/(1-q) stays
 *   within this when q < (1-p)/(1-p*mf).  The Tier 1 sizing Y = stake*q/p
 *   satisfies it automatically whenever p+q < 1 (since q < 1-p < (1-p)/(1-p*mf)).
 */
export function maxHedgePrice(entryPrice: number, maxLossFraction: number): number {
  return (1 - entryPrice) / (1 - entryPrice * maxLossFraction);
}

/**
 * Tier 1 stake: sizes the hedge for equal profit in both outcome scenarios.
 * Only call this when entry_price + hedge_ask < ARB_CEILING.
 */
export function tier1Stake(stakeUsd: number, entryPrice: number, hedgeAsk: number): number {
  return (stakeUsd * hedgeAsk) / entryPrice;
}

/**
 * Tier 2 stake: sizes the hedge to cap loss at max_loss_fraction of original
 * stake when the hedge wins.
 */
export function tier2Stake(
  stakeUsd: number,
  hedgeAsk: number,
  maxLossFraction: number,
): number {
  return (stakeUsd * (1 - maxLossFraction) * hedgeAsk) / (1 - hedgeAsk);
}

/**
 * Computes expected P&L in both outcome scenarios.
 * Positive originalWins + positive hedgeWins = guaranteed arb (Tier 1).
 * Negative hedgeWins bounded by max_loss_fraction = Tier 2.
 */
export function computePnl(
  sharesHeld: number,
  stakeUsd: number,
  hedgeAsk: number,
  hedgeStake: number,
): { originalWins: number; hedgeWins: number } {
  return {
    originalWins: sharesHeld - stakeUsd - hedgeStake,
    hedgeWins: hedgeStake / hedgeAsk - stakeUsd - hedgeStake,
  };
}

interface HedgeDecision {
  tier: 1 | 2;
  hedgeStake: number;
  hedgeTokenId: string;
  hedgeDirection: 'YES' | 'NO';
  originalWins: number;
  hedgeWins: number;
}

/** Run one hedge-scanner cycle across all open copytrade positions. */
export async function runCopytradeHedgeScan(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  let positions: OpenCopytradePosition[];
  try {
    positions = await fetchOpenCopytradePositions();
  } catch (err) {
    logger.warn('[copytrade-hedge] DB query failed — aborting scan', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (positions.length === 0) return;

  for (const pos of positions) {
    try {
      const hedgeKey = `${HEDGE_KEY_PREFIX}${pos.id}`;
      const alreadyHedged = await redis.exists(hedgeKey);
      if (alreadyHedged) continue;

      let market;
      try {
        market = await getMarket(pos.marketId);
      } catch (err) {
        logger.warn('[copytrade-hedge] Gamma market fetch failed — skipping', {
          positionId: pos.id,
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (market.closed === true || market.active === false) {
        logger.debug('[copytrade-hedge] market closed/inactive — skipping', {
          positionId: pos.id,
          marketId: pos.marketId,
        });
        continue;
      }

      let tokenIds: string[];
      try {
        tokenIds = parseClobTokenIds(market.clobTokenIds);
        if (tokenIds.length < 2) {
          logger.debug('[copytrade-hedge] not a binary market — skipping', {
            marketId: pos.marketId,
            tokenCount: tokenIds.length,
          });
          continue;
        }
      } catch (err) {
        logger.warn('[copytrade-hedge] failed to parse clobTokenIds — skipping', {
          marketId: pos.marketId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // tokenIds[0] = YES token, tokenIds[1] = NO token
      const hedgeTokenId = pos.direction === 'NO' ? tokenIds[0]! : tokenIds[1]!;
      const hedgeDirection: 'YES' | 'NO' = pos.direction === 'NO' ? 'YES' : 'NO';

      const book = await getClobOrderBook(hedgeTokenId);
      if (!book?.asks?.length) {
        logger.debug('[copytrade-hedge] no asks on hedge side — skipping', {
          positionId: pos.id,
          hedgeDirection,
        });
        continue;
      }

      // Order-agnostic touch: asks[0] on a REST book is the WORST ask. See shared/bookTouch.ts.
      const hedgeAsk = getBookTouchLevels(book).bestAsk?.price ?? 0;
      if (!isFinite(hedgeAsk) || hedgeAsk <= 0 || hedgeAsk >= 1) continue;

      const p = pos.entryPrice;
      const s = pos.stakeUsd;
      const mf = cfg.COPYTRADE_HEDGE_MAX_LOSS_FRACTION;
      const qMax = maxHedgePrice(p, mf);

      let decision: HedgeDecision | null = null;

      if (hedgeAsk < qMax) {
        const isArb = p + hedgeAsk < ARB_CEILING;
        const rawStake = isArb
          ? tier1Stake(s, p, hedgeAsk)
          : tier2Stake(s, hedgeAsk, mf);
        const hedgeStake = Math.min(rawStake, s * cfg.COPYTRADE_HEDGE_MAX_STAKE_MULTIPLIER);
        const { originalWins, hedgeWins } = computePnl(
          pos.sharesHeld,
          s,
          hedgeAsk,
          hedgeStake,
        );
        // Require original-wins scenario to remain profitable. A partial original
        // fill (sharesHeld < stake/entryPrice) can make originalWins negative even
        // when the arb condition holds for a full fill.
        if (originalWins > 0) {
          decision = { tier: isArb ? 1 : 2, hedgeStake, hedgeTokenId, hedgeDirection, originalWins, hedgeWins };
        }
      }

      const wouldHedge = decision !== null;

      logger.info('[copytrade-hedge] opportunity evaluated', {
        positionId: pos.id,
        marketId: pos.marketId,
        direction: pos.direction,
        entryPrice: p,
        stakeUsd: s,
        hedgeDirection,
        hedgeAsk: hedgeAsk.toFixed(4),
        qMax: qMax.toFixed(4),
        withinQMax: hedgeAsk < qMax,
        tier: decision?.tier ?? null,
        hedgeStake: decision ? decision.hedgeStake.toFixed(2) : null,
        originalWins: decision ? decision.originalWins.toFixed(2) : null,
        hedgeWins: decision ? decision.hedgeWins.toFixed(2) : null,
        enabled: cfg.COPYTRADE_HEDGE_ENABLED,
      });

      void enqueueWrite('shadow_observations', {
        kind: 'copytrade_hedge',
        source: 'copytrade',
        marketId: pos.marketId,
        direction: hedgeDirection,
        wouldBlock: !wouldHedge || !cfg.COPYTRADE_HEDGE_ENABLED,
        metricValue: hedgeAsk,
        threshold: qMax,
        payload: {
          positionId: pos.id,
          positionDirection: pos.direction,
          entryPrice: p,
          stakeUsd: s,
          sharesHeld: pos.sharesHeld,
          hedgeAsk,
          qMax,
          withinQMax: hedgeAsk < qMax,
          isArb: wouldHedge && decision?.tier === 1,
          tier: decision?.tier ?? null,
          hedgeStake: decision?.hedgeStake ?? null,
          originalWins: decision?.originalWins ?? null,
          hedgeWins: decision?.hedgeWins ?? null,
          maxLossFraction: mf,
          maxStakeMultiplier: cfg.COPYTRADE_HEDGE_MAX_STAKE_MULTIPLIER,
          enabled: cfg.COPYTRADE_HEDGE_ENABLED,
        },
      });

      if (!wouldHedge || !cfg.COPYTRADE_HEDGE_ENABLED || !decision) continue;

      const result = await submitClobBuy({
        tokenId: decision.hedgeTokenId,
        amountUsd: decision.hedgeStake,
        orderType: 'FAK',
      });

      if (result.success) {
        const sharesBought = result.shares_bought ?? 0;
        const expectedShares = hedgeAsk > 0 ? decision.hedgeStake / hedgeAsk : 0;
        const fillRatio = expectedShares > 0 ? sharesBought / expectedShares : 0;

        // Lock the position regardless of fill ratio to prevent unbounded retries
        // accumulating over-sized hedge exposure on thin books.
        await redis.set(hedgeKey, '1', 'EX', HEDGE_TTL_S);
        await deductStake(redis, result.cost ?? decision.hedgeStake * Math.max(fillRatio, 0));

        if (fillRatio < MIN_FILL_RATIO) {
          logger.warn('[copytrade-hedge] partial fill — position locked to prevent retry accumulation', {
            positionId: pos.id,
            expectedShares: expectedShares.toFixed(2),
            sharesBought: sharesBought.toFixed(2),
            fillRatio: fillRatio.toFixed(3),
          });
          continue;
        }

        logger.info('[copytrade-hedge] hedge executed', {
          positionId: pos.id,
          marketId: pos.marketId,
          tier: decision.tier,
          hedgeDirection,
          hedgeAsk,
          hedgeStake: decision.hedgeStake.toFixed(2),
          sharesBought,
          originalWins: decision.originalWins.toFixed(2),
          hedgeWins: decision.hedgeWins.toFixed(2),
        });

        const label =
          decision.tier === 1
            ? 'Tier 1 — guaranteed arb'
            : `Tier 2 — loss cap ${Math.round(mf * 100)}%`;
        const pnlLine =
          decision.tier === 1
            ? `Both +: <b>+$${decision.originalWins.toFixed(2)}</b> / <b>+$${decision.hedgeWins.toFixed(2)}</b>`
            : `Original wins: <b>+$${decision.originalWins.toFixed(2)}</b>  |  Hedge wins: <b>-$${Math.abs(decision.hedgeWins).toFixed(2)}</b>`;

        await notify(
          `🔀 Copytrade hedge (${label})\n` +
            `<i>${pos.question.slice(0, 70)}</i>\n` +
            `Held: ${pos.direction} @${p.toFixed(3)} ($${s.toFixed(2)})\n` +
            `Hedge: ${hedgeDirection} @${hedgeAsk.toFixed(3)} ($${decision.hedgeStake.toFixed(2)})\n` +
            pnlLine,
        );
      } else {
        logger.warn('[copytrade-hedge] CLOB buy failed', {
          positionId: pos.id,
          hedgeDirection,
          hedgeAsk,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('[copytrade-hedge] unexpected error for position — continuing', {
        positionId: pos.id,
        marketId: pos.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
