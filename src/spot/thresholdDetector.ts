/**
 * Threshold detector.
 *
 * Compares current spot prices to the rolling window and detects significant moves.
 * Enforces a per-asset, per-direction cooldown via Redis to prevent re-triggering.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import type { SpotPrice } from './poller.js';
import { getPriceAtLookback } from './poller.js';
import { isCryptoAsset, BINANCE_SYMBOL_TO_ASSET } from '../shared/assets.js';

// Reverse map: assetId ('bitcoin') → binance symbol ('btcusdt') for kline lookup.
const ASSET_TO_BINANCE_SYMBOL: Record<string, string> = Object.fromEntries(
  Object.entries(BINANCE_SYMBOL_TO_ASSET).map(([sym, asset]) => [asset, sym]),
);

export interface SpotMove {
  assetId: string;
  currentPrice: number;
  referencePrice: number;
  changePercent: number; // signed: +5.2 or -3.1
  windowMinutes: number;
  detectedAt: string; // ISO timestamp
}

/**
 * Check whether a cooldown is active for a given asset + direction.
 */
async function isCooldownActive(assetId: string, direction: 'up' | 'down'): Promise<boolean> {
  const redis = getRedis();
  const key = `spot:cooldown:${assetId}:${direction}`;
  const val = await redis.get(key);
  return val !== null;
}

/**
 * Set the cooldown flag for a given asset + direction.
 */
async function setCooldown(assetId: string, direction: 'up' | 'down'): Promise<void> {
  const redis = getRedis();
  const cfg = loadConfig();
  const key = `spot:cooldown:${assetId}:${direction}`;
  
  const cooldownMinutes = (cfg.TIERED_LOGIC_ENABLED && isCryptoAsset(assetId))
    ? cfg.CRYPTO_COOLDOWN_MINUTES
    : cfg.SPOT_COOLDOWN_MINUTES;

  await redis.set(key, '1', 'EX', cooldownMinutes * 60);
}

/**
 * Compute the z-score of the most recent log return for an asset, using
 * 1m closes from the kline store. Returns null if insufficient data.
 *
 * Series: r_i = ln(c_i / c_{i-windowBars}) for a fixed return window.
 * z = (r_now - mean(r)) / stddev(r)
 */
async function computeMomentumZscore(
  assetId: string,
  lookbackMin: number,
  returnWindowBars = 5,
): Promise<{ z: number; rNow: number } | null> {
  const symbol = ASSET_TO_BINANCE_SYMBOL[assetId];
  if (!symbol) return null;
  const redis = getRedis();
  const key = `spot:klines:${symbol}:1m`;
  const from = Date.now() - lookbackMin * 60_000;
  const raw = await redis.zrangebyscore(key, from, '+inf');
  if (raw.length < returnWindowBars + 5) return null;

  const closes: number[] = [];
  for (const entry of raw) {
    try {
      const k = JSON.parse(entry) as { c?: number };
      if (typeof k.c === 'number' && k.c > 0) closes.push(k.c);
    } catch { /* skip */ }
  }
  if (closes.length < returnWindowBars + 5) return null;

  const returns: number[] = [];
  for (let i = returnWindowBars; i < closes.length; i++) {
    const a = closes[i - returnWindowBars]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) returns.push(Math.log(b / a));
  }
  if (returns.length < 5) return null;

  const rNow = returns[returns.length - 1]!;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance =
    returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / returns.length;
  const std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std === 0) return null;

  return { z: (rNow - mean) / std, rNow };
}

export async function detectMoves(currentPrices: SpotPrice[]): Promise<SpotMove[]> {
  const cfg = loadConfig();
  const lookbackMinutes = cfg.SPOT_LOOKBACK_MINUTES;
  const lookbackMs = lookbackMinutes * 60 * 1000;
  const triggerMode = cfg.SPOT_TRIGGER_MODE;

  const moves: SpotMove[] = [];

  for (const sp of currentPrices) {
    const isCrypto = isCryptoAsset(sp.assetId);
    let threshold = (cfg.TIERED_LOGIC_ENABLED && isCrypto)
      ? cfg.CRYPTO_MOVE_THRESHOLD
      : cfg.SPOT_MOVE_THRESHOLD;

    // Session-aware multiplier: widen threshold during high-vol hours, narrow during quiet hours.
    // Applies to the percent path only — z-score is already regime-normalized.
    if (cfg.SESSION_THRESHOLD_ENABLED) {
      const hour = new Date().getUTCHours();
      const multipliers = cfg.SESSION_MULTIPLIERS.split(',').map(Number);
      const multiplier = multipliers[hour] ?? 1.0;
      threshold *= multiplier;
      logger.debug('[spot-threshold] session-adjusted threshold', {
        assetId: sp.assetId, hour, multiplier, threshold: threshold.toFixed(3),
      });
    }

    const referencePrice = await getPriceAtLookback(sp.assetId, lookbackMs);
    if (referencePrice == null || referencePrice === 0) {
      logger.info('[spot-threshold] no reference price yet', { assetId: sp.assetId });
      continue;
    }

    const changePercent = ((sp.price - referencePrice) / referencePrice) * 100;
    const pctTriggered = Math.abs(changePercent) >= threshold;

    // Z-score path: log "would-have-triggered" in pct mode, hard-gate in zscore/both modes.
    let zscoreTriggered: boolean | null = null;
    let zValue: number | null = null;
    if (triggerMode !== 'pct') {
      const z = await computeMomentumZscore(sp.assetId, cfg.SPOT_ZSCORE_LOOKBACK_MIN);
      if (z) {
        zValue = z.z;
        zscoreTriggered = Math.abs(z.z) >= cfg.SPOT_ZSCORE_THRESHOLD;
      } else {
        zscoreTriggered = false;
      }
    } else {
      // Shadow-log z-score in pct mode for validation
      const z = await computeMomentumZscore(sp.assetId, cfg.SPOT_ZSCORE_LOOKBACK_MIN).catch(
        () => null,
      );
      if (z) {
        zValue = z.z;
        const wouldTrigger = Math.abs(z.z) >= cfg.SPOT_ZSCORE_THRESHOLD;
        if (wouldTrigger !== pctTriggered) {
          logger.info('[spot-threshold] zscore shadow', {
            assetId: sp.assetId,
            triggerMode,
            pctTriggered,
            wouldTrigger,
            zscore: z.z.toFixed(2),
            changePercent: changePercent.toFixed(2),
          });
        }
      }
    }

    let triggered = false;
    let directionFromZ: 'up' | 'down' | null = null;
    switch (triggerMode) {
      case 'pct':
        triggered = pctTriggered;
        break;
      case 'zscore':
        triggered = zscoreTriggered === true;
        if (triggered && zValue !== null) directionFromZ = zValue > 0 ? 'up' : 'down';
        break;
      case 'both':
        triggered = pctTriggered && zscoreTriggered === true;
        break;
    }

    if (!triggered) continue;

    const direction: 'up' | 'down' =
      directionFromZ ?? (changePercent > 0 ? 'up' : 'down');

    if (await isCooldownActive(sp.assetId, direction)) {
      logger.info('[spot-threshold] cooldown active, skipping', {
        assetId: sp.assetId,
        direction,
        changePercent: changePercent.toFixed(2),
      });
      continue;
    }

    // Set cooldown before emitting the move
    await setCooldown(sp.assetId, direction);

    const move: SpotMove = {
      assetId: sp.assetId,
      currentPrice: sp.price,
      referencePrice,
      changePercent,
      windowMinutes: lookbackMinutes,
      detectedAt: new Date().toISOString(),
    };

    moves.push(move);

    logger.info('[spot-threshold] significant move detected', {
      assetId: sp.assetId,
      isCrypto,
      changePercent: changePercent.toFixed(2),
      threshold,
      currentPrice: sp.price,
      referencePrice,
    });
  }

  return moves;
}
