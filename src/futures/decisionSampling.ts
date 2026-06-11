/**
 * Sampling gate for the HL scanners' `signal_decisions` logging.
 *
 * The HL momentum and funding scanners evaluate every symbol on every scan tick
 * and enqueue a `signal_decisions` row for each — overwhelmingly routine
 * early-gate skips (score_below_min, oi_below_minimum, …). At ~280k rows/day
 * this is the dominant driver of DB growth. Trades (any has_trade=true decision)
 * are always persisted so execution lineage stays complete; skip rows are
 * sampled at `HL_DECISION_LOG_SAMPLE_RATE` to bound the write rate.
 *
 * Returns true when the caller should DROP (not persist) this decision row:
 *   - hasTrade            → never drop (full fidelity on real entries)
 *   - sampleRate >= 1     → never drop (sampling disabled; legacy behaviour)
 *   - sampleRate <= 0     → always drop skips (persist no skips)
 *   - else                → drop with probability (1 - sampleRate)
 *
 * NOTE: skip-row counts in `signal_decisions` are therefore a sample — reweight
 * aggregate skip counts by 1 / HL_DECISION_LOG_SAMPLE_RATE.
 */
export function shouldDropSampledDecision(hasTrade: boolean, sampleRate: number): boolean {
  if (hasTrade) return false;
  if (sampleRate >= 1) return false;
  return Math.random() >= sampleRate;
}
