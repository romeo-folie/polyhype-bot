/**
 * Black-Scholes binary option pricer for Polymarket 15m BTC/ETH Up/Down markets.
 *
 * Model: digital call (YES) = Φ(d), digital put (NO) = Φ(-d)
 *   d = (ln(S/K) - 0.5σ²τ) / (σ√τ)
 *   r = 0 (no drift), τ in Julian years (365.25 × 24 × 3600 s/yr)
 *
 * Both σ annualization and τ conversion use the same SECONDS_PER_YEAR constant
 * so the factors cancel cleanly in the d-term.
 */

/** Julian year in seconds: 365.25 × 24 × 3600 = 31,557,600 */
export const SECONDS_PER_YEAR = 365.25 * 24 * 3600;

/**
 * Normal CDF via Abramowitz & Stegun rational approximation (error < 7.5e-8).
 * Exposed for unit testing.
 *
 * Non-finite handling: +Inf → 1, −Inf → 0, NaN → NaN. Callers are expected
 * to treat a NaN result as a hard signal that upstream inputs were invalid —
 * `computePModel` validates Number.isFinite on all inputs up front so this
 * path shouldn't fire in production, but returning NaN keeps the failure
 * loud rather than turning bad math into a deceptively valid probability.
 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const phi = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - phi * poly;
  return x >= 0 ? cdf : 1 - cdf;
}

export interface PModelResult {
  pYes: number;
  pNo: number;
  d: number;
  tauYears: number;
  valid: boolean;
  invalidReason?: string;
}

/**
 * Compute p_model for a Polymarket binary market.
 *
 * @param spot     Current Chainlink price (S)
 * @param strike   Chainlink price at window open (K)
 * @param sigma    Annualized realized vol (σ), already clamped
 * @param tauSecs  Seconds remaining until resolution
 */
export function computePModel(
  spot: number,
  strike: number,
  sigma: number,
  tauSecs: number,
): PModelResult {
  if (
    !Number.isFinite(spot) ||
    !Number.isFinite(strike) ||
    !Number.isFinite(sigma) ||
    !Number.isFinite(tauSecs)
  ) {
    return { pYes: 0.5, pNo: 0.5, d: 0, tauYears: 0, valid: false, invalidReason: 'non_finite_input' };
  }
  if (spot <= 0 || strike <= 0) {
    return { pYes: 0.5, pNo: 0.5, d: 0, tauYears: 0, valid: false, invalidReason: 'non_positive_price' };
  }
  if (sigma <= 0) {
    return { pYes: 0.5, pNo: 0.5, d: 0, tauYears: 0, valid: false, invalidReason: 'non_positive_sigma' };
  }
  if (tauSecs <= 0) {
    return { pYes: 0.5, pNo: 0.5, d: 0, tauYears: 0, valid: false, invalidReason: 'expired' };
  }

  const tauYears = tauSecs / SECONDS_PER_YEAR;
  const sqrtTau = Math.sqrt(tauYears);
  const d = (Math.log(spot / strike) - 0.5 * sigma * sigma * tauYears) / (sigma * sqrtTau);
  const pYes = normalCdf(d);
  return { pYes, pNo: 1 - pYes, d, tauYears, valid: true };
}
