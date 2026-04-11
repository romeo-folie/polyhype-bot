/**
 * Weekly calibration cron — Phase 8b.
 *
 * For each known category, recomputes calibration stats from outcome records
 * and sends a Telegram summary.
 *
 * Schedule: `0 3 * * MON` (Monday 03:00 UTC)
 */

import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { computeCalibration } from '../shared/calibration.js';
import { notifyCalibrationUpdate } from '../execution/telegram.js';
import { enqueueWrite } from '../db/writeQueue.js';

const CATEGORIES = ['geopolitical', 'macro', 'crypto-regulatory', 'ai-tech', 'us-politics'];

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.CALIBRATION_ENABLED) {
    logger.info('[calibrate] calibration disabled — skipping');
    return;
  }

  const redis = getRedis();
  await redis.connect().catch(() => {
    /* already connected — ignore */
  });

  const lines: string[] = [];

  for (const category of CATEGORIES) {
    const stats = await computeCalibration(redis, category, cfg.CALIBRATION_MIN_SAMPLES);

    if (!stats) {
      // Try without min samples to get raw stats for the summary
      const rawStats = await computeCalibration(redis, category);
      if (rawStats) {
        lines.push(
          `${category}: ${(rawStats.winRate * 100).toFixed(0)}% win rate (n=${rawStats.sampleSize.toString()}), correction ×${rawStats.edgeCorrectionFactor.toFixed(2)} ⚠️ below min samples — not applied`,
        );
      } else {
        lines.push(`${category}: no data`);
      }
      continue;
    }

    lines.push(
      `${category}: ${(stats.winRate * 100).toFixed(0)}% win rate (n=${stats.sampleSize.toString()}), correction ×${stats.edgeCorrectionFactor.toFixed(2)}`,
    );

    // Emit overall + per-bucket rows to calibration_stats table
    const lastUpdatedAt = stats.updatedAt;
    void enqueueWrite('calibration_stats', {
      category,
      bucket: 'overall',
      tradeCount: stats.sampleSize,
      winCount: Math.round(stats.winRate * stats.sampleSize),
      totalReturnPct: stats.avgReturn * stats.sampleSize,
      lastUpdatedAt,
    });
    for (const bucket of stats.buckets) {
      void enqueueWrite('calibration_stats', {
        category,
        bucket: bucket.range,
        tradeCount: bucket.count,
        winCount: Math.round(bucket.actualWinRate * bucket.count),
        totalReturnPct: 0, // per-bucket return not tracked in CalibrationBucket
        lastUpdatedAt,
      });
    }
  }

  logger.info('[calibrate] weekly calibration complete', { summary: lines.join('; ') });

  await notifyCalibrationUpdate(lines);

  await redis.quit();
}

main().catch((err) => {
  logger.error('[calibrate] fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
