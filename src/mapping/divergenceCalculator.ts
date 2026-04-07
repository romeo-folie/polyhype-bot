/**
 * Divergence calculator & Half-Kelly position sizer.
 *
 * Edge formula:
 *   edge = consensusProbability - marketPrice
 *   (positive = market underpricing YES; negative = market overpricing YES / buy NO)
 *
 * Half-Kelly stake:
 *   Kelly fraction = (b*p - q) / b,  where b = (1/price - 1), p = consensusP, q = 1-p
 *   We use half-Kelly (multiply by 0.5) for risk management.
 *   Stake = halfKellyFraction * bankroll, capped at maxBetFraction * bankroll.
 *
 * Direction: if edge > 0 → buy YES; if edge < 0 → buy NO.
 */

export interface TradeDecision {
  /** YES or NO */
  direction: 'YES' | 'NO';
  /** Edge magnitude (always positive) */
  edgeMagnitude: number;
  /** Consensus probability (0–1) */
  consensusProbability: number;
  /** Current market price of the target outcome (0–1) */
  outcomePrice: number;
  /** Recommended stake in USD (already capped at maxBetFraction) */
  stakeUsd: number;
  /** Half-Kelly fraction before capping */
  halfKellyFraction: number;
}

export interface DivergenceInput {
  consensusProbability: number;
  consensusStddev: number;
  currentYesPrice: number;
  /** Total portfolio value in USD */
  bankrollUsd: number;
  /** Minimum required edge to trade (0–1). Typically 0.10 = 10%. */
  divergenceThreshold: number;
  /** Maximum fraction of bankroll per trade. Typically 0.10 = 10%. */
  maxBetFraction: number;
  /** Available liquidity in USD at the current price level (optional) */
  bookDepthUsd?: number;
  /**
   * Extreme-price LLM-distrust threshold. If the market is priced below this
   * value (or above 1 - this value) we treat the LLM consensus with suspicion.
   * Defaults to 0.02 (2¢).
   */
  minPriceForLlmTrust?: number;
  /**
   * Maximum LLM consensus we will trust when the market is in the extreme-price
   * zone. If the LLM disagrees by more than this with a near-zero/near-one
   * market, the trade is skipped. Defaults to 0.15.
   */
  maxLlmProbAtLowPrice?: number;
  /** Market resolution date (ISO string). Used by the time-to-resolution gate. */
  endDate?: string;
  /** Source of the signal — used for telemetry/debug. */
  source?: 'osint' | 'spot' | 'copytrade';
  /** Maximum hours-to-resolution allowed. If undefined, no max gate. */
  maxHoursToResolution?: number;
  /** Minimum hours-to-resolution required. If undefined, no min gate. */
  minHoursToResolution?: number;
}

/**
 * Time-to-resolution gate. Returns `{ ok: false, skipReason }` if the market
 * resolves too far in the future or too soon. No-op when endDate is missing or
 * neither bound is supplied.
 */
export function checkTimeToResolution(
  endDate: string | undefined,
  maxHoursToResolution: number | undefined,
  minHoursToResolution: number | undefined,
): { ok: boolean; skipReason?: string } {
  if (!endDate || (!maxHoursToResolution && !minHoursToResolution)) {
    return { ok: true };
  }
  const hours = (new Date(endDate).getTime() - Date.now()) / 3_600_000;
  if (!Number.isFinite(hours)) return { ok: true };
  if (maxHoursToResolution && hours > maxHoursToResolution) {
    return {
      ok: false,
      skipReason: `too_long_dated:hours=${hours.toFixed(1)},max=${maxHoursToResolution}`,
    };
  }
  if (minHoursToResolution && hours < minHoursToResolution) {
    return {
      ok: false,
      skipReason: `too_soon_expiring:hours=${hours.toFixed(1)},min=${minHoursToResolution}`,
    };
  }
  return { ok: true };
}

export interface DivergenceResult {
  hasTrade: boolean;
  decision: TradeDecision | null;
  skipReason?: string;
}

/** Skip if consensus stddev exceeds this threshold (noisy signal). */
export const NOISE_STDDEV_THRESHOLD = 0.08;

/**
 * Compute edge and position size.
 *
 * Returns `hasTrade: false` when edge is below the divergence threshold,
 * the signal is too noisy, or EV at the lower confidence bound is negative.
 */
export function computeDivergence(input: DivergenceInput): DivergenceResult {
  const {
    consensusProbability: p,
    consensusStddev,
    currentYesPrice,
    bankrollUsd,
    divergenceThreshold,
    maxBetFraction,
    bookDepthUsd,
    minPriceForLlmTrust = 0.02,
    maxLlmProbAtLowPrice = 0.15,
    endDate,
    maxHoursToResolution,
    minHoursToResolution,
  } = input;

  // Gate 0: Extreme-price LLM-distrust gate.
  // When the market is priced very near 0 or 1, the LLM's "default to 50%
  // under uncertainty" failure mode produces phantom edge. Skip these.
  // Symmetric: low-YES checks the LLM's YES probability; high-YES checks NO.
  if (currentYesPrice < minPriceForLlmTrust && p > maxLlmProbAtLowPrice) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `extreme_price_llm_distrust:price=${currentYesPrice.toFixed(4)},consensus=${p.toFixed(3)}`,
    };
  }
  if (currentYesPrice > 1 - minPriceForLlmTrust && 1 - p > maxLlmProbAtLowPrice) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `extreme_price_llm_distrust:price=${currentYesPrice.toFixed(4)},consensus=${p.toFixed(3)}`,
    };
  }

  // Gate 0.5: Time-to-resolution gate.
  const ttr = checkTimeToResolution(endDate, maxHoursToResolution, minHoursToResolution);
  if (!ttr.ok) {
    return { hasTrade: false, decision: null, skipReason: ttr.skipReason ?? 'time_to_resolution' };
  }

  // Gate 1: Noisy signal — stddev too high
  if (consensusStddev > NOISE_STDDEV_THRESHOLD) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `noisy_signal:stddev=${consensusStddev.toFixed(3)}`,
    };
  }

  // Gate 2: EV gate — use pessimistic confidence bound, not point estimate
  // YES trade: pessimistic p(YES) = p - stddev (event less likely than estimated)
  // NO trade:  pessimistic p(NO)  = 1 - (p + stddev) (event more likely than estimated)
  const p_lower = Math.max(0, p - consensusStddev);
  const p_upper = Math.min(1, p + consensusStddev);
  const direction_for_ev: 'YES' | 'NO' = p - currentYesPrice > 0 ? 'YES' : 'NO';
  const outcomePrice_for_ev = direction_for_ev === 'YES' ? currentYesPrice : 1 - currentYesPrice;
  const p_for_ev = direction_for_ev === 'YES' ? p_lower : 1 - p_upper;
  const payout_for_ev = outcomePrice_for_ev > 0 ? 1 / outcomePrice_for_ev : 0;
  const ev = payout_for_ev > 0 ? p_for_ev * payout_for_ev - 1 : -1;
  if (ev <= 0) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `negative_ev:ev=${ev.toFixed(4)},p_lower=${p_lower.toFixed(3)}`,
    };
  }

  const edge = p - currentYesPrice;
  const edgeMagnitude = Math.abs(edge);

  if (edgeMagnitude < divergenceThreshold) {
    return { hasTrade: false, decision: null };
  }

  const direction: 'YES' | 'NO' = edge > 0 ? 'YES' : 'NO';

  // For NO trades, work in complementary probability space
  const outcomePrice = direction === 'YES' ? currentYesPrice : 1 - currentYesPrice;
  const tradeProbability = direction === 'YES' ? p : 1 - p;

  const halfKellyFraction = computeHalfKelly(tradeProbability, outcomePrice);
  const cappedFraction = Math.min(halfKellyFraction, maxBetFraction);
  const rawStakeUsd = Math.max(0, cappedFraction * bankrollUsd);

  // Liquidity Gate: cap stake at 20% of book depth if available
  const stakeUsd =
    bookDepthUsd !== undefined
      ? Math.min(rawStakeUsd, bookDepthUsd * 0.2)
      : rawStakeUsd;

  return {
    hasTrade: true,
    decision: {
      direction,
      edgeMagnitude,
      consensusProbability: p,
      outcomePrice,
      stakeUsd,
      halfKellyFraction,
    },
  };
}

/**
 * Compute the half-Kelly fraction for a binary outcome.
 *
 * @param p - True probability of the outcome winning (0–1)
 * @param price - Market price of the outcome (0–1)
 * @returns Half-Kelly fraction (0–1). Returns 0 if Kelly is non-positive.
 */
export function computeHalfKelly(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  // Net odds: b = (1 - price) / price  (winning $1-price for every $price staked)
  const b = (1 - price) / price;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  if (kelly <= 0) return 0;
  return kelly * 0.5;
}
