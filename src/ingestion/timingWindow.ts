/**
 * Market-hours timing window multiplier.
 *
 * Polymarket is US-dominated. When geopolitical news breaks during Asian or
 * European business hours while US retail is asleep, markets take 15–45 min
 * to reprice. We flag items that arrive during these windows to signal higher
 * expected edge from the repricing lag.
 *
 * The multiplier is applied to urgencyScore (capped at 10) so items in the lag
 * window are more likely to cross the URGENCY_THRESHOLD for execution.
 *
 * Windows are based on the Geopolitics & Conflict Trader skill's documented
 * structural edges (from Simmer skills registry):
 *
 * Region               UTC window    Multiplier  Rationale
 * Asia/Pacific         00:00–08:00   1.20x       US asleep — repricing lag open
 * Europe/Middle East   06:00–14:00   1.15x       US just waking — partial lag
 * (Outside windows)                  1.00x       US prime time — priced quickly
 */

import { logger } from '../shared/logger.js';
import type { ScoredItem } from './scorer.js';

interface TimingWindow {
  name: string;
  startHour: number; // UTC hour (inclusive)
  endHour: number; // UTC hour (exclusive)
  multiplier: number;
}

const TIMING_WINDOWS: TimingWindow[] = [
  { name: 'asia_pacific', startHour: 0, endHour: 8, multiplier: 1.2 },
  { name: 'europe_mideast', startHour: 6, endHour: 14, multiplier: 1.15 },
];

const MAX_URGENCY_SCORE = 10;

/**
 * Get the active timing multiplier for the given UTC hour.
 * If multiple windows overlap (6–8 UTC), the highest multiplier wins.
 */
export function getTimingMultiplier(utcHour: number): {
  multiplier: number;
  windowName: string | null;
} {
  let best = { multiplier: 1.0, windowName: null as string | null };
  for (const w of TIMING_WINDOWS) {
    if (utcHour >= w.startHour && utcHour < w.endHour) {
      if (w.multiplier > best.multiplier) {
        best = { multiplier: w.multiplier, windowName: w.name };
      }
    }
  }
  return best;
}

/**
 * Apply timing window boost to a batch of scored items.
 *
 * Scores are boosted (multiplied) and capped at MAX_URGENCY_SCORE.
 * The `now` parameter is injectable for testing.
 */
export function applyTimingBoost(items: ScoredItem[], now: Date = new Date()): ScoredItem[] {
  const utcHour = now.getUTCHours();
  const { multiplier, windowName } = getTimingMultiplier(utcHour);

  if (multiplier === 1.0) return items; // no active window — no-op

  return items.map((item) => {
    const boosted = Math.min(MAX_URGENCY_SCORE, item.urgencyScore * multiplier);
    logger.debug('[timing] boosted urgency score', {
      title: item.title.slice(0, 80),
      original: item.urgencyScore,
      boosted,
      window: windowName,
      multiplier,
    });
    return { ...item, urgencyScore: boosted };
  });
}
