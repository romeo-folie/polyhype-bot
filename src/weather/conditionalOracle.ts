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
  observedMax: number;
  /** ISO8601 UTC timestamp of the observation that set observedMax. */
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
 * Compute P(finalMax > threshold) from ensemble member trajectories conditioned
 * on an already-observed running max. Each member's final max = max(observedMax,
 * member's remaining hourly values). Spread inflation expands each member's
 * deviation from the per-hour ensemble mean before computing the final max.
 */
function ensembleFinalMaxExceedance(
  observedMax: number,
  memberTemps: number[][],
  biasCorrection: number,
  spreadInflation: number,
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

  const finalMaxes: number[] = [];
  for (const member of memberTemps) {
    let memberMax = observedMax;
    for (let h = 0; h < nHours; h++) {
      const raw = member[h];
      if (raw == null || !Number.isFinite(raw)) continue;
      // Apply bias correction and spread inflation.
      // correctedMean = ensemble mean shifted by bias; inflate deviations around it.
      const corrected = raw - biasCorrection;
      const correctedMean = (hourMean[h] ?? 0) - biasCorrection;
      const inflated = correctedMean + (corrected - correctedMean) * spreadInflation;
      if (inflated > memberMax) memberMax = inflated;
    }
    finalMaxes.push(memberMax);
  }
  return finalMaxes;
}

/**
 * P(finalMax rounds into winning condition for a given direction + bracket)
 * given a sorted array of per-member final max values.
 *
 * The rounding boundary semantics match classifyOracleState:
 *   Interior YES: final max must round into [low, high] → finalMax < high + 0.5
 *   Interior NO:  final max must round outside [low, high] → finalMax ≥ high + 0.5
 *   High-tail YES: finalMax rounds ≥ low → finalMax ≥ low - 0.5
 *   High-tail NO:  finalMax rounds < low → finalMax < low - 0.5
 *   Low-tail YES:  finalMax rounds ≤ high → finalMax < high + 0.5
 *   Low-tail NO:   finalMax rounds > high → finalMax ≥ high + 0.5
 *
 * Also handles the case where observedMax has already crossed an irreversible
 * boundary — degenerates to 0 or 1 and matches classifyOracleState.
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

/** Look up the climatological exceedance for a given city/month/localHour at a specific delta. */
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
 */
function climoHeldProbability(
  table: ClimoExceedanceTable,
  city: string,
  observedMax: number,
  observedAtLocalHour: number,
  month: number,
  direction: 'YES' | 'NO',
  bracket: { low: number | null; high: number | null },
): number | null {
  const { low, high } = bracket;

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

  // Degenerate case: binary oracle boundary already crossed → agree with classifyOracleState.
  const binaryState = classifyOracleState(observedMax, direction, bracket);
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
      const finalMaxes = ensembleFinalMaxDistribution(
        observedMax,
        remainingHourlyMembers,
        biasCorrection,
        spreadInflation,
      );
      if (finalMaxes.length >= minMembers) {
        ensembleHeldProb = bracketWinProbFromFinalMaxes(finalMaxes, direction, bracket);
        membersUsed = finalMaxes.length;
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
 * Compute the final daily max for each ensemble member, given the running max
 * already observed and the remaining hourly trajectories.
 * Exported for testing.
 */
export function ensembleFinalMaxDistribution(
  observedMax: number,
  memberTemps: number[][],
  biasCorrection: number,
  spreadInflation: number,
): number[] {
  return ensembleFinalMaxExceedance(observedMax, memberTemps, biasCorrection, spreadInflation);
}

/**
 * Load the climatological exceedance table from the bundled JSON asset.
 * Returns null on read failure. The table may have an empty 'cities' object
 * when no station history has been built yet.
 */
export function loadClimoTable(): ClimoExceedanceTable | null {
  try {
    const raw = _require('./data/climoExceedance.json') as { cities: ClimoExceedanceTable };
    return raw.cities ?? null;
  } catch {
    return null;
  }
}
