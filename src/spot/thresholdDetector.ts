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
import { isCryptoAsset } from '../shared/assets.js';

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

export async function detectMoves(currentPrices: SpotPrice[]): Promise<SpotMove[]> {
  const cfg = loadConfig();
  const lookbackMinutes = cfg.SPOT_LOOKBACK_MINUTES;
  const lookbackMs = lookbackMinutes * 60 * 1000;

  const moves: SpotMove[] = [];

  for (const sp of currentPrices) {
    const isCrypto = isCryptoAsset(sp.assetId);
    let threshold = (cfg.TIERED_LOGIC_ENABLED && isCrypto)
      ? cfg.CRYPTO_MOVE_THRESHOLD
      : cfg.SPOT_MOVE_THRESHOLD;

    // Session-aware multiplier: widen threshold during high-vol hours, narrow during quiet hours
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

    if (Math.abs(changePercent) < threshold) {
      continue;
    }

    const direction: 'up' | 'down' = changePercent > 0 ? 'up' : 'down';

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
