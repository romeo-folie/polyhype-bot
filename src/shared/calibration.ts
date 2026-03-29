/**
 * Calibration tracker — Phase 8b.
 *
 * Weekly analysis of outcome records to detect systematic bias per category.
 * Produces a correction factor that adjusts edge estimates at execution time.
 *
 * Correction is bidirectional:
 *   - Factor < 1.0 → model overconfident → reduce edge
 *   - Factor > 1.0 → model underconfident → increase edge
 *   - Clamped to [0.5, 1.5] to prevent extreme swings
 */

import { logger } from './logger.js';
import type { Redis } from 'ioredis';

export interface CalibrationBucket {
  range: string;
  statedMid: number;
  actualWinRate: number;
  count: number;
  correctionFactor: number;
}

export interface CalibrationStats {
  category: string;
  updatedAt: string;
  sampleSize: number;
  winRate: number;
  avgReturn: number;
  edgeCorrectionFactor: number;
  buckets: CalibrationBucket[];
}

const CORRECTION_FLOOR = 0.5;
const CORRECTION_CEILING = 1.5;

const BUCKET_RANGES: { min: number; max: number; label: string; mid: number }[] = [
  { min: 0.0, max: 0.1, label: '0.00-0.10', mid: 0.05 },
  { min: 0.1, max: 0.2, label: '0.10-0.20', mid: 0.15 },
  { min: 0.2, max: 0.3, label: '0.20-0.30', mid: 0.25 },
  { min: 0.3, max: 0.4, label: '0.30-0.40', mid: 0.35 },
  { min: 0.4, max: 0.5, label: '0.40-0.50', mid: 0.45 },
  { min: 0.5, max: 0.6, label: '0.50-0.60', mid: 0.55 },
  { min: 0.6, max: 0.7, label: '0.60-0.70', mid: 0.65 },
  { min: 0.7, max: 0.8, label: '0.70-0.80', mid: 0.75 },
  { min: 0.8, max: 0.9, label: '0.80-0.90', mid: 0.85 },
  { min: 0.9, max: 1.0, label: '0.90-1.00', mid: 0.95 },
];

function clampCorrection(factor: number): number {
  return Math.max(CORRECTION_FLOOR, Math.min(CORRECTION_CEILING, factor));
}

/**
 * Compute calibration stats for a category from its outcome records.
 * Returns null if sampleSize < minSamples.
 */
export async function computeCalibration(
  redis: Redis,
  category: string,
  minSamples?: number,
): Promise<CalibrationStats | null> {
  try {
    // Read all outcome IDs for this category
    const ids: string[] = await redis.zrange(`outcomes:${category}`, 0, -1);
    if (ids.length === 0) return null;

    // Fetch all outcomes
    let wins = 0;
    let totalReturn = 0;
    let totalStatedProb = 0;
    let probCount = 0;
    const bucketData: Map<string, { wins: number; total: number }> = new Map();

    for (const br of BUCKET_RANGES) {
      bucketData.set(br.label, { wins: 0, total: 0 });
    }

    for (const id of ids) {
      const data = await redis.hgetall(`outcome:${id}`);
      if (!data || !data.id) continue;

      const result = data.result as string;
      const returnPct = Number(data.returnPct) || 0;
      const prob = Number(data.consensusProbability) || 0;
      const isWin = result === 'won';

      if (isWin) wins++;
      totalReturn += returnPct;

      if (prob > 0) {
        totalStatedProb += prob;
        probCount++;

        // Assign to bucket
        for (const br of BUCKET_RANGES) {
          if (prob >= br.min && prob < br.max) {
            const b = bucketData.get(br.label)!;
            b.total++;
            if (isWin) b.wins++;
            break;
          }
          // Handle exactly 1.0
          if (prob >= 1.0 && br.label === '0.90-1.00') {
            const b = bucketData.get(br.label)!;
            b.total++;
            if (isWin) b.wins++;
            break;
          }
        }
      }
    }

    const sampleSize = ids.length;
    if (minSamples !== undefined && sampleSize < minSamples) return null;

    const winRate = sampleSize > 0 ? wins / sampleSize : 0;
    const avgReturn = sampleSize > 0 ? totalReturn / sampleSize : 0;
    const avgStatedProb = probCount > 0 ? totalStatedProb / probCount : 0.5;

    // Overall correction: actual vs stated
    const rawCorrection = avgStatedProb > 0 ? winRate / avgStatedProb : 1;
    const edgeCorrectionFactor = clampCorrection(rawCorrection);

    // Build bucket stats
    const buckets: CalibrationBucket[] = [];
    for (const br of BUCKET_RANGES) {
      const b = bucketData.get(br.label)!;
      const actualWinRate = b.total > 0 ? b.wins / b.total : 0;
      const rawBucketCorrection = b.total > 0 ? actualWinRate / br.mid : 1;
      buckets.push({
        range: br.label,
        statedMid: br.mid,
        actualWinRate,
        count: b.total,
        correctionFactor: clampCorrection(rawBucketCorrection),
      });
    }

    const stats: CalibrationStats = {
      category,
      updatedAt: new Date().toISOString(),
      sampleSize,
      winRate,
      avgReturn,
      edgeCorrectionFactor,
      buckets,
    };

    // Cache in Redis for 7 days
    await redis.set(`calibration:${category}`, JSON.stringify(stats), 'EX', 604800);

    logger.info('[calibration] computed stats', {
      category,
      sampleSize,
      winRate: winRate.toFixed(3),
      edgeCorrectionFactor: edgeCorrectionFactor.toFixed(3),
    });

    return stats;
  } catch (err) {
    logger.warn('[calibration] computation failed', {
      category,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Retrieve cached calibration stats for a category.
 */
export async function getCalibrationStats(
  redis: Redis,
  category: string,
): Promise<CalibrationStats | null> {
  try {
    const raw = await redis.get(`calibration:${category}`);
    if (!raw) return null;
    return JSON.parse(raw) as CalibrationStats;
  } catch (err) {
    logger.warn('[calibration] failed to read cached stats', {
      category,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Apply calibration correction to an edge value.
 * Returns edge unchanged if stats are null or sample size is below threshold.
 */
export function applyCalibrationCorrection(
  edge: number,
  stats: CalibrationStats | null,
  sampleRequired: number,
): number {
  if (!stats || stats.sampleSize < sampleRequired) return edge;
  return edge * stats.edgeCorrectionFactor;
}
