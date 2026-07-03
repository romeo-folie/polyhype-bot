/**
 * Conditional weather oracle (Phases A-C).
 *
 * Estimates P(our held side wins | running max observed so far today) by
 * conditioning on the intraday observed maximum temperature. This fills the
 * gap between the binary certainty oracle (classifyOracleState) and "no
 * signal" — the market re-prices probabilistically from intraday readings
 * while the static daily-max model stays blind until the next forecast update.
 *
 * Two estimators:
 *   1. Conditioned ensemble (primary): each member's remaining hourly
 *      trajectory gives a final-day max → fraction of members winning gives
 *      P. Synoptic-aware; no new data dependency beyond the hourly parameter.
 *   2. Empirical climatology (fallback/clamp): precomputed per-city/month/hour
 *      table of P(finalMax > runningMax + δ). Handles Open-Meteo outages.
 *
 * Exit rule (Phase B): bid > conditionalHeldProb + COST_BUFFER → sell.
 * Hold guard (Phase B): conditionalP - bid ≥ HOLD_GUARD_GAP → suppress velocity exits.
 *
 * Log marker: [weather-cond-oracle]
 */

import { createRequire } from 'module';
import { logger } from '../shared/logger.js';
import { classifyOracleState } from './liveObservation.js';

// JSON asset loader — ESM-compatible via createRequire.
const _require = createRequire(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClimoExceedanceEntry {
  delta: number;
  exceedance: number;
}

/** city → month (1-12) → localHour (0-23) → sorted entries by delta */
export type ClimoExceedanceTable = Record<
  string,
  Record<number, Record<number, ClimoExceedanceEntry[]>>
>;

export interface ConditionalOracleInput {
  city: string;
  direction: 'YES' | 'NO';
  bracket: { low: number | null; high: number | null };
  /** Running daily extreme observed so far: daily MAX for metric='high', daily
   *  MIN for metric='low'. Named observedMax for continuity with the high path. */
  observedMax: number;
  /** Which daily extreme the market resolves on. Defaults to 'high'. Drives the
   *  oracle direction (max increases vs min decreases) and the climo table type. */
  metric?: 'high' | 'low';
  /** ISO8601 UTC timestamp of the latest observation included in observedMax. */
  observedAt: string;
  /** IANA timezone for the city (to derive local hour from observedAt). */
  tz: string;
  /** Per-member hourly temp arrays for remaining hours: memberTemps[memberIdx][hourIdx].
   *  Only hours AFTER observedAtLocalHour need to be included — caller may pass full day
   *  and this function ignores past hours by filtering on the hour array. */
  remainingHourlyMembers: number[][] | null;
  climoTable: ClimoExceedanceTable | null;
  /** City mean bias (forecast − observed). Subtract from member trajectories. */
  biasCorrection: number;
  /** Spread inflation multiplier for member trajectories (default 1.0 = no inflation). */
  spreadInflation: number;
  /** Minimum ensemble members to use ensemble estimator; fall back to climo below this. */
  minMembers: number;
  /** Maximum obs age in minutes for action-eligible output. */
  maxObsAgeMin: number;
  /** Max gap between ensemble and climo before conservative clamp applies. */
  estimatorMaxGap: number;
}

export type ConditionalEstimator = 'ensemble' | 'climo' | 'degenerate';

export interface ConditionalOracleResult {
  /** Probability that the held side wins, conditioned on the running max so far. */
  heldProb: number;
  estimator: ConditionalEstimator;
  /** Number of ensemble members used (0 when climo-only). */
  members: number;
  /** Local hour of the observation timestamp (used for climo lookup). */
  observedAtLocalHour: number;
  /** True when the observation is older than maxObsAgeMin — result must not trigger live actions. */
  isStale: boolean;
  /** True when the ensemble estimate was clamped toward the climo estimate. */
  clampedByClimo: boolean;
  /** Absolute gap between ensemble and climo estimates (null when only one available). */
  estimatorGap: number | null;
  /** Climo-only P (null when climo unavailable for this city/month/hour). */
  climoHeldProb: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Return the local hour (0-23) for a UTC ISO8601 timestamp in the given IANA timezone. */
export function localHourFromUtc(utcIso: string, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    const parts = fmt.formatToParts(new Date(utcIso));
    const h = parts.find((p) => p.type === 'hour');
    return h ? parseInt(h.value, 10) % 24 : 0;
  } catch {
    return 0;
  }
}

/** Return the local calendar month (1-12) for a UTC ISO8601 timestamp in the given IANA timezone. */
function localMonthFromUtc(utcIso: string, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      month: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(utcIso));
    const m = parts.find((p) => p.type === 'month');
    return m ? parseInt(m.value, 10) : new Date(utcIso).getUTCMonth() + 1;
  } catch {
    return new Date(utcIso).getUTCMonth() + 1;
  }
}

/**
 * Compute the projected final daily extreme for each ensemble member,
 * conditioned on the already-observed running extreme. For metric='high' each
 * member's final value = max(observed, member's remaining hourly values); for
 * metric='low' it is min(observed, …). Spread inflation expands each member's
 * deviation from the per-hour ensemble mean before reducing.
 */
function ensembleFinalExtremeDistribution(
  observed: number,
  memberTemps: number[][],
  biasCorrection: number,
  spreadInflation: number,
  metric: 'high' | 'low' = 'high',
): number[] {
  const nMembers = memberTemps.length;
  if (nMembers === 0) return [];
  const nHours = memberTemps[0]!.length;

  // Per-hour ensemble mean for spread inflation.
  const hourMean: number[] = Array.from({ length: nHours }, (_, h) => {
    let sum = 0;
    let count = 0;
    for (const member of memberTemps) {
      const v = member[h];
      if (v != null && Number.isFinite(v)) { sum += v; count++; }
    }
    return count > 0 ? sum / count : 0;
  });

  const finalValues: number[] = [];
  for (const member of memberTemps) {
    let memberExtreme = observed;
    for (let h = 0; h < nHours; h++) {
      const raw = member[h];
      if (raw == null || !Number.isFinite(raw)) continue;
      // Apply bias correction and spread inflation.
      // correctedMean = ensemble mean shifted by bias; inflate deviations around it.
      const corrected = raw - biasCorrection;
      const correctedMean = (hourMean[h] ?? 0) - biasCorrection;
      const inflated = correctedMean + (corrected - correctedMean) * spreadInflation;
      if (metric === 'low' ? inflated < memberExtreme : inflated > memberExtreme) {
        memberExtreme = inflated;
      }
    }
    finalValues.push(memberExtreme);
  }
  return finalValues;
}

/**
 * P(the final daily statistic rounds into the winning condition for a given
 * direction + bracket) given a per-member array of projected final values.
 *
 * This is direction-AGNOSTIC: the win condition only asks whether the resolved
 * daily value (a max for highest-temperature markets, a min for lowest) rounds
 * into the bracket, so the same math serves both metrics — only how each
 * member's final value was reduced (max vs min) differs upstream.
 *
 * The rounding boundary semantics match classifyOracleState:
 *   Interior YES: final value must round into [low, high] → low-0.5 ≤ v < high + 0.5
 *   High-tail YES: rounds ≥ low → v ≥ low - 0.5
 *   Low-tail YES:  rounds ≤ high → v < high + 0.5
 *   (NO is the complement of YES in each case.)
 */
export function bracketWinProbFromFinalMaxes(
  finalMaxes: number[],
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
): number {
  if (finalMaxes.length === 0) return 0.5;
  const { low, high } = bracket;
  let wins = 0;

  for (const fm of finalMaxes) {
    let yesWins: boolean;

    if (low !== null && high !== null) {
      // Interior: YES if finalMax rounds into [low, high] → [low-0.5, high+0.5)
      yesWins = fm >= low - 0.5 && fm < high + 0.5;
    } else if (low === null && high !== null) {
      // Low-tail: YES if finalMax ≤ high (rounds to ≤ high) → finalMax < high + 0.5
      yesWins = fm < high + 0.5;
    } else if (high === null && low !== null) {
      // High-tail: YES if finalMax ≥ low (rounds to ≥ low) → finalMax ≥ low - 0.5
      yesWins = fm >= low - 0.5;
    } else {
      yesWins = false;
    }

    if ((direction === 'YES' && yesWins) || (direction === 'NO' && !yesWins)) {
      wins++;
    }
  }

  return wins / finalMaxes.length;
}

/**
 * Look up the climatological exceedance for a given city/month/localHour at a specific delta.
 *
 * Deltas outside the table's range are clamped to the nearest endpoint — an
 * approximation: below the historical minimum rise the true exceedance
 * approaches 1.0 but the clamp returns the first entry's value; above the
 * historical maximum it returns the last entry's (≈0). Material only for
 * observations far outside the table's multi-year envelope.
 */
function climoExceedanceAt(
  table: ClimoExceedanceTable,
  city: string,
  month: number,
  localHour: number,
  delta: number,
): number | null {
  const cityData = (table as Record<string, unknown>)[city];
  if (!cityData || typeof cityData !== 'object') return null;

  const monthData = (cityData as Record<number, unknown>)[month];
  if (!monthData || typeof monthData !== 'object') return null;

  const hourData = (monthData as Record<number, ClimoExceedanceEntry[]>)[localHour];
  if (!Array.isArray(hourData) || hourData.length === 0) return null;

  // Binary search for the closest delta bracket via linear interpolation.
  if (delta <= hourData[0]!.delta) return hourData[0]!.exceedance;
  if (delta >= hourData[hourData.length - 1]!.delta) return hourData[hourData.length - 1]!.exceedance;

  for (let i = 0; i < hourData.length - 1; i++) {
    const lo = hourData[i]!;
    const hi = hourData[i + 1]!;
    if (delta >= lo.delta && delta <= hi.delta) {
      const t = (delta - lo.delta) / (hi.delta - lo.delta);
      return lo.exceedance + t * (hi.exceedance - lo.exceedance);
    }
  }
  return null;
}

/**
 * Compute conditionalHeldProb from the climo table alone.
 * Returns null when the city/month/hour is not covered.
 *
 * For metric='high' the table is a "rise" table — climoExceedanceAt returns
 * P(finalMax > runningMax + delta) — and observedMax is the running daily max.
 * For metric='low' the caller passes a "fall" table whose entries are
 * P(runningMin - finalMin > delta), observed is the running daily min, and the
 * derivation below is the point-reflection of the high case.
 */
function climoHeldProbability(
  table: ClimoExceedanceTable,
  city: string,
  observedMax: number,
  observedAtLocalHour: number,
  month: number,
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
  metric: 'high' | 'low' = 'high',
): number | null {
  const { low, high } = bracket;

  if (metric === 'low') {
    return climoHeldProbabilityLow(
      table, city, observedMax, observedAtLocalHour, month, direction, bracket,
    );
  }

  if (low !== null && high !== null) {
    // Interior bracket.
    // P(YES) = P(finalMax rounds into bracket)
    //        = P(finalMax < high+0.5) − P(finalMax < low-0.5) (if observedMax < low-0.5)
    //        = P(finalMax < high+0.5)                         (if observedMax already in bracket)
    if (observedMax >= high + 0.5) {
      // Irreversible: finalMax already rounds out of bracket → P(YES) = 0.
      return direction === 'YES' ? 0 : 1;
    }
    if (observedMax >= low - 0.5) {
      // Already in bracket: only need to stay below high+0.5.
      // P(YES) = 1 - P(finalMax ≥ high+0.5) = 1 - climo(high+0.5 - observedMax)
      const deltaHigh = (high + 0.5) - observedMax;
      const excHigh = climoExceedanceAt(table, city, month, observedAtLocalHour, deltaHigh);
      if (excHigh === null) return null;
      const pYes = 1 - excHigh;
      return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
    }
    // Below bracket: need to reach it AND not overshoot.
    const deltaLow = (low - 0.5) - observedMax;
    const deltaHigh = (high + 0.5) - observedMax;
    const excLow = climoExceedanceAt(table, city, month, observedAtLocalHour, deltaLow);
    const excHigh = climoExceedanceAt(table, city, month, observedAtLocalHour, deltaHigh);
    if (excLow === null || excHigh === null) return null;
    const pYes = excLow - excHigh;
    return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
  }

  if (low === null && high !== null) {
    // Low-tail: YES = finalMax ≤ high (rounds to ≤ high) → finalMax < high + 0.5.
    if (observedMax >= high + 0.5) {
      return direction === 'YES' ? 0 : 1;
    }
    const delta = (high + 0.5) - observedMax;
    const exc = climoExceedanceAt(table, city, month, observedAtLocalHour, delta);
    if (exc === null) return null;
    const pYes = 1 - exc;
    return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
  }

  if (high === null && low !== null) {
    // High-tail: YES = finalMax ≥ low (rounds to ≥ low) → finalMax ≥ low - 0.5.
    if (observedMax >= low - 0.5) {
      return direction === 'YES' ? 1 : 0;
    }
    const delta = (low - 0.5) - observedMax;
    const exc = climoExceedanceAt(table, city, month, observedAtLocalHour, delta);
    if (exc === null) return null;
    const pYes = exc;
    return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
  }

  return null;
}

/**
 * climoHeldProbability for lowest-temperature markets (metric='low').
 *
 * `observedMin` is the running daily minimum (only decreases intraday). The
 * `table` is a "fall" table: climoExceedanceAt(table, …, delta) returns
 * P(runningMin − finalMin > delta), i.e. P(the final daily min ends more than
 * `delta` BELOW the current running min). Equivalently P(finalMin < observedMin − delta).
 *
 * This is the point-reflection of the high-temperature derivation above.
 */
function climoHeldProbabilityLow(
  table: ClimoExceedanceTable,
  city: string,
  observedMin: number,
  observedAtLocalHour: number,
  month: number,
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
): number | null {
  const { low, high } = bracket;
  // P(finalMin < boundary), via the fall table. boundary must be ≤ observedMin
  // for a meaningful (delta ≥ 0) lookup; callers below guarantee that.
  const pFinalBelow = (boundary: number): number | null => {
    const delta = observedMin - boundary;
    return climoExceedanceAt(table, city, month, observedAtLocalHour, delta);
  };

  if (low !== null && high !== null) {
    // Interior. YES = finalMin rounds into [low, high] → low-0.5 ≤ finalMin < high+0.5.
    if (observedMin < low - 0.5) {
      // Irreversible: running min already below the bracket floor → YES impossible.
      return direction === 'YES' ? 0 : 1;
    }
    if (observedMin < high + 0.5) {
      // Already inside the rounding window from above; only risk is dropping out
      // the bottom. P(YES) = P(finalMin ≥ low-0.5) = 1 − P(finalMin < low-0.5).
      const excLow = pFinalBelow(low - 0.5);
      if (excLow === null) return null;
      const pYes = 1 - excLow;
      return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
    }
    // Above bracket: must fall into [low-0.5, high+0.5) — reach below high+0.5 but not below low-0.5.
    const excHigh = pFinalBelow(high + 0.5);
    const excLow = pFinalBelow(low - 0.5);
    if (excHigh === null || excLow === null) return null;
    const pYes = excHigh - excLow;
    return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
  }

  if (low === null && high !== null) {
    // Low-tail "high or below": YES = finalMin ≤ high → finalMin < high + 0.5.
    if (observedMin < high + 0.5) {
      // Running min already at/below the ceiling and only drops further → YES confirmed.
      return direction === 'YES' ? 1 : 0;
    }
    const exc = pFinalBelow(high + 0.5);
    if (exc === null) return null;
    const pYes = exc;
    return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
  }

  if (high === null && low !== null) {
    // High-tail "low or higher": YES = finalMin ≥ low → finalMin ≥ low - 0.5.
    if (observedMin < low - 0.5) {
      // Running min already below the floor → YES impossible.
      return direction === 'YES' ? 0 : 1;
    }
    const exc = pFinalBelow(low - 0.5);
    if (exc === null) return null;
    const pYes = 1 - exc;
    return direction === 'YES' ? clamp01(pYes) : clamp01(1 - pYes);
  }

  return null;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ── Main function ─────────────────────────────────────────────────────────────

/**
 * Estimate P(held side wins | running max observed so far today).
 *
 * Returns null when:
 *   - The binary oracle already has a certain answer (caller should check classifyOracleState first).
 *   - No estimator is available (no hourly members AND no climo table entry for the city).
 *
 * When isStale=true the result must NOT trigger live actions — it is shadow-log only.
 */
export function conditionalHeldProbability(
  input: ConditionalOracleInput,
): ConditionalOracleResult | null {
  const {
    city,
    direction,
    bracket,
    observedMax,
    observedAt,
    tz,
    remainingHourlyMembers,
    climoTable,
    biasCorrection,
    spreadInflation,
    minMembers,
    maxObsAgeMin,
    estimatorMaxGap,
  } = input;
  const metric = input.metric ?? 'high';

  // Degenerate case: binary oracle boundary already crossed → agree with classifyOracleState.
  const binaryState = classifyOracleState(observedMax, direction, bracket, metric);
  if (binaryState === 'oracle_impossible' || binaryState === 'oracle_confirmed') {
    const obsAgeMinDegen = (Date.now() - new Date(observedAt).getTime()) / 60_000;
    return {
      heldProb: binaryState === 'oracle_confirmed' ? 1 : 0,
      estimator: 'degenerate',
      members: 0,
      observedAtLocalHour: localHourFromUtc(observedAt, tz),
      isStale: obsAgeMinDegen > maxObsAgeMin,
      clampedByClimo: false,
      estimatorGap: null,
      climoHeldProb: null,
    };
  }

  // Staleness check.
  const obsAgeMin = (Date.now() - new Date(observedAt).getTime()) / 60_000;
  const isStale = obsAgeMin > maxObsAgeMin;

  // Local hour of the observation timestamp.
  const observedAtLocalHour = localHourFromUtc(observedAt, tz);

  // Local month — use the IANA timezone so eastern cities near UTC midnight get the correct month.
  const month = localMonthFromUtc(observedAt, tz);

  // ── Ensemble estimator ───────────────────────────────────────────────────────
  let ensembleHeldProb: number | null = null;
  let membersUsed = 0;

  if (
    remainingHourlyMembers != null &&
    remainingHourlyMembers.length >= minMembers
  ) {
    try {
      const finalValues = ensembleFinalMaxDistribution(
        observedMax,
        remainingHourlyMembers,
        biasCorrection,
        spreadInflation,
        metric,
      );
      if (finalValues.length >= minMembers) {
        ensembleHeldProb = bracketWinProbFromFinalMaxes(finalValues, direction, bracket);
        membersUsed = finalValues.length;
      }
    } catch (err) {
      logger.warn('[weather-cond-oracle] ensemble estimator error', {
        city,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Climo estimator ──────────────────────────────────────────────────────────
  let climoHeldProb: number | null = null;
  if (climoTable) {
    try {
      climoHeldProb = climoHeldProbability(
        climoTable,
        city,
        observedMax,
        observedAtLocalHour,
        month,
        direction,
        bracket,
        metric,
      );
    } catch (err) {
      logger.warn('[weather-cond-oracle] climo estimator error', {
        city,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Resolve estimator ────────────────────────────────────────────────────────
  let heldProb: number;
  let estimator: ConditionalEstimator;
  let clampedByClimo = false;
  let estimatorGap: number | null = null;

  if (ensembleHeldProb !== null && membersUsed >= minMembers) {
    if (climoHeldProb !== null) {
      estimatorGap = Math.abs(ensembleHeldProb - climoHeldProb);
      if (estimatorGap > estimatorMaxGap) {
        // Disagree too much — use the more conservative value (further from winning).
        const ensembleWorseForHolder = ensembleHeldProb < climoHeldProb;
        heldProb = ensembleWorseForHolder ? ensembleHeldProb : climoHeldProb;
        clampedByClimo = true;
        logger.info('[weather-cond-oracle] estimator disagreement — using conservative', {
          city,
          direction,
          ensembleHeldProb: +ensembleHeldProb.toFixed(3),
          climoHeldProb: +climoHeldProb.toFixed(3),
          gap: +estimatorGap.toFixed(3),
          threshold: estimatorMaxGap,
        });
      } else {
        heldProb = ensembleHeldProb;
      }
    } else {
      heldProb = ensembleHeldProb;
    }
    estimator = 'ensemble';
  } else if (climoHeldProb !== null) {
    heldProb = climoHeldProb;
    estimator = 'climo';
    membersUsed = 0;
  } else {
    // No estimator available.
    return null;
  }

  return {
    heldProb: clamp01(heldProb),
    estimator,
    members: membersUsed,
    observedAtLocalHour,
    isStale,
    clampedByClimo,
    estimatorGap,
    climoHeldProb,
  };
}

/**
 * Compute the projected final daily extreme for each ensemble member, given the
 * running extreme already observed and the remaining hourly trajectories.
 * metric='low' reduces with min() (for lowest-temperature markets).
 * Exported for testing.
 */
export function ensembleFinalMaxDistribution(
  observedMax: number,
  memberTemps: number[][],
  biasCorrection: number,
  spreadInflation: number,
  metric: 'high' | 'low' = 'high',
): number[] {
  return ensembleFinalExtremeDistribution(observedMax, memberTemps, biasCorrection, spreadInflation, metric);
}

/**
 * Load the climatological RISE exceedance table (highest-temperature markets)
 * from the bundled JSON asset. Returns null on read failure. The table may have
 * an empty 'cities' object when no station history has been built yet.
 */
export function loadClimoTable(): ClimoExceedanceTable | null {
  try {
    const raw = _require('./data/climoExceedance.json') as { cities: ClimoExceedanceTable };
    return raw.cities ?? null;
  } catch {
    return null;
  }
}

/**
 * Load the climatological FALL exceedance table (lowest-temperature markets):
 * P(runningMin − finalMin > delta) per city/month/localHour. Same JSON shape as
 * the rise table. Returns null when the asset is missing — callers then fall
 * back to the ensemble estimator alone.
 */
export function loadClimoFallTable(): ClimoExceedanceTable | null {
  try {
    const raw = _require('./data/climoFallExceedance.json') as { cities: ClimoExceedanceTable };
    return raw.cities ?? null;
  } catch {
    return null;
  }
}
