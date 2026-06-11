/**
 * Shared probability helpers used by both the weather scanner (sizing) and the
 * executor (size-up eligibility). Kept here — rather than in weatherScanner.ts —
 * because the executor cannot import the scanner (the scanner already imports the
 * executor's executeAndRecordSignal, so the reverse edge would be circular).
 */

/**
 * Shrink a model win-probability toward the market price before Kelly sizing:
 *
 *   sizingProb = w·modelProb + (1−w)·marketPrice
 *
 * Closed-bet calibration shows the weather model is overconfident (model ~0.65 →
 * realized ~0.52) and only ties the market as a forecaster, so Half-Kelly on the
 * raw model prob oversizes the edge ~2×. Shrinking toward the better-calibrated
 * market price right-sizes the stake. Sign-invariant: for w∈(0,1],
 * `sizingProb > price ⟺ modelProb > price`, so it never flips a positive-edge entry
 * to a skip — it only reduces stake magnitude. w=1 → no shrink. (w=0 → fully market,
 * which zeroes the Kelly edge; the weather config restricts to (0,1] so that degenerate
 * value can't silently skip every entry — see WEATHER_KELLY_SHRINK_WEIGHT.)
 *
 * @param modelProb   model P(side wins), 0–1
 * @param marketPrice price of the side we buy (= market-implied P(side)), 0–1
 * @param weight      shrink weight w∈[0,1] (clamped)
 */
export function shrinkTowardMarket(modelProb: number, marketPrice: number, weight: number): number {
  // Non-finite weight (e.g. an unset config) falls back to no shrink (legacy behavior)
  // rather than poisoning the stake with NaN.
  const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 1;
  const shrunk = w * modelProb + (1 - w) * marketPrice;
  return Math.min(1, Math.max(0, shrunk));
}
