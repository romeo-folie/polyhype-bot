/**
 * Divergence calculator & fractional-Kelly position sizer.
 *
 * Edge formula:
 *   edge = consensusProbability - marketPrice
 *   (positive = market underpricing YES; negative = market overpricing YES / buy NO)
 *
 * Fractional-Kelly stake:
 *   Kelly fraction = (b*p - q) / b,  where b = (1/price - 1), p = consensusP, q = 1-p
 *   We use quarter-Kelly by default (multiply by KELLY_FRACTION=0.25) for risk management.
 *   Stake = kellyFraction * bankroll, capped at maxBetFraction * bankroll.
 *
 * Direction: if edge > 0 → buy YES; if edge < 0 → buy NO.
 */

import { priceZoneOf, type PriceZone } from '../shared/zones.js';
import { applyCategoryBias } from './calibrationBias.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { enqueueWrite } from '../db/writeQueue.js';

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
  /** Price-zone classification for the entry outcome price */
  priceZone: PriceZone;
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
  /** Zone-gate knobs (optional — defaults mirror cfg). */
  zone3FeeBuffer?: number;
  zone4DirectionalBlock?: boolean;
  zone5DirectionalBlock?: boolean;
  /** Category of the market (e.g. 'us-politics', 'geopolitical'). Used for
   *  category-aware zone unblocking — research shows political favorites at
   *  70-90¢ are systematically underpriced. */
  category?: string;
  /** Kelly fraction multiplier (default 0.25 = quarter-Kelly). */
  kellyFraction?: number;
  /** Noise gate — stddev threshold (default 0.22, calibrated for n=3 Bessel
   *  post the 2026-04-15 deadline-surfacing fix). */
  noiseStddevThreshold?: number;
  /**
   * Number of LLM providers that returned for this estimate. When less than
   * `consensusTargetSamples`, the noise threshold is scaled down by
   * sqrt((n-1)/(target-1)) to compensate for the fewer-outlier-chances effect
   * (fewer providers → systematically lower observed stddev). If undefined,
   * no scaling is applied (back-compat for callers that don't thread it yet).
   */
  consensusSampleCount?: number;
  /** Baseline sample count the noise threshold was tuned against. Default 3. */
  consensusTargetSamples?: number;
  /** Hard floor — skip if fewer than this many providers returned. Default 3. */
  consensusMinSamples?: number;
  /** Kelly sign-stability probe. */
  kellyProbeDelta?: number;
  kellyRequireSignStable?: boolean;
  /** Whether calibration bias correction is enabled. */
  calibrationBiasEnabled?: boolean;
  /**
   * Anchor-collapse gate. When every provider defaults to the explicit 0.50
   * "I don't know" anchor in consensusCalculator's prompt, we see p≈0.5 with
   * stddev≈0 — fake agreement that's actually the LLM default, not signal.
   * Reject when |p − 0.5| < pDelta AND stddev < stddevEpsilon.
   */
  anchorCollapsePDelta?: number;
  anchorCollapseStddevEpsilon?: number;
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

/** Legacy constant — callers should use the configurable `noiseStddevThreshold`
 *  input field instead. Kept for backward-compat with tests that import it. */
export const NOISE_STDDEV_THRESHOLD = 0.22;

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
    zone3FeeBuffer = 0.02,
    zone4DirectionalBlock = true,
    zone5DirectionalBlock = true,
    category,
    kellyFraction = 0.25,
    noiseStddevThreshold = 0.22,
    consensusSampleCount,
    consensusTargetSamples = 3,
    consensusMinSamples = 3,
    kellyProbeDelta = 0.05,
    kellyRequireSignStable = true,
    calibrationBiasEnabled = false,
    anchorCollapsePDelta = 0.05,
    anchorCollapseStddevEpsilon = 0.01,
  } = input;

  // Gate -1: Insufficient consensus samples. Enforced here (rather than in
  // individual callers) so spot, OSINT, copytrade, and near-zero all share
  // one floor. The circuit breaker may drop providers; this gate caps how
  // degraded we're willing to trade from.
  if (consensusSampleCount !== undefined && consensusSampleCount < consensusMinSamples) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `insufficient_samples:n=${consensusSampleCount.toString()},min=${consensusMinSamples.toString()}`,
    };
  }

  // Sample-count-aware noise threshold. With fewer providers, observed stddev
  // is systematically smaller — not because the signal is less noisy but
  // because with n points the chance of catching a dissenter is lower. We
  // scale the threshold by sqrt((n-1)/(target-1)) so the gate's effective
  // strictness is invariant to how many providers returned.
  const effectiveNoiseThreshold =
    consensusSampleCount !== undefined && consensusSampleCount < consensusTargetSamples
      ? noiseStddevThreshold *
        Math.sqrt(
          Math.max(1, consensusSampleCount - 1) / Math.max(1, consensusTargetSamples - 1),
        )
      : noiseStddevThreshold;

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

  // Gate 0.1: Calibration bias correction (Le 2026 recalibration).
  // Adjusts market price by domain-specific theta before edge calculation.
  // When CALIBRATION_BIAS_ENABLED=false, shadow-logs what would change but
  // uses the raw price for the actual edge calc.
  let effectiveYesPrice = currentYesPrice;
  if (category) {
    const biasConfig = loadConfig();
    const hoursToResolution = endDate
      ? (new Date(endDate).getTime() - Date.now()) / 3_600_000
      : undefined;
    const bias = applyCategoryBias(
      currentYesPrice,
      category,
      hoursToResolution !== undefined && Number.isFinite(hoursToResolution)
        ? hoursToResolution
        : undefined,
      biasConfig,
    );
    if (bias.theta !== 1) {
      if (calibrationBiasEnabled) {
        effectiveYesPrice = bias.adjustedPrice;
      } else {
        logger.debug('[divergence] calibration_bias shadow', {
          category,
          theta: bias.theta,
          rawPrice: bias.rawPrice.toFixed(4),
          adjustedPrice: bias.adjustedPrice.toFixed(4),
          delta: (bias.adjustedPrice - bias.rawPrice).toFixed(4),
        });
        void enqueueWrite('shadow_observations', {
          kind: 'calibration_bias',
          source: input.source ?? 'osint',
          // Bias is shadow-observing only: the trade proceeds with the raw
          // price, so this feature is not blocking anything. Use the payload's
          // delta to judge whether enabling the bias would change the decision.
          wouldBlock: false,
          metricValue: bias.adjustedPrice - bias.rawPrice,
          threshold: 0,
          payload: {
            category,
            theta: bias.theta,
            rawPrice: bias.rawPrice,
            adjustedPrice: bias.adjustedPrice,
            hoursToResolution,
            consensusProbability: p,
          },
        });
      }
    }
  }

  // Gate 0.25: Price-zone EV gate. Classify entry into 5 zones; block or
  // tighten requirements for the high-risk zones 3–5. Applied to whichever
  // outcome (YES/NO) we would actually enter, not the raw YES price.
  const provisionalEdgeSign = p - effectiveYesPrice;
  const provisionalDirection: 'YES' | 'NO' = provisionalEdgeSign > 0 ? 'YES' : 'NO';
  // Zone classification uses raw market price (actual cost of entry); edge uses corrected price.
  const provisionalOutcomePrice =
    provisionalDirection === 'YES' ? currentYesPrice : 1 - currentYesPrice;
  const provisionalEdgeMag = Math.abs(provisionalEdgeSign);
  const entryZone = priceZoneOf(provisionalOutcomePrice);
  if (entryZone === 3 && provisionalEdgeMag < divergenceThreshold + zone3FeeBuffer) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `zone3_edge_below_fee_buffer:price=${provisionalOutcomePrice.toFixed(3)},edge=${provisionalEdgeMag.toFixed(3)}`,
    };
  }
  // Category-aware zone unblocking: research (Le 2026, θ=1.83 for politics)
  // shows political/macro favorites at 60-90¢ are systematically underpriced.
  const ZONE4_BYPASS_CATEGORIES = new Set(['us-politics', 'geopolitical', 'macro']);
  const ZONE5_BYPASS_CATEGORIES = new Set(['us-politics', 'geopolitical']);
  const zone4Blocked = zone4DirectionalBlock && !(category && ZONE4_BYPASS_CATEGORIES.has(category));
  const zone5Blocked = zone5DirectionalBlock && !(category && ZONE5_BYPASS_CATEGORIES.has(category));

  if (entryZone === 4 && zone4Blocked) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `zone4_comfort_trap:price=${provisionalOutcomePrice.toFixed(3)},edge=${provisionalEdgeMag.toFixed(3)}`,
    };
  }
  if (entryZone === 5 && zone5Blocked) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `zone5_widow_maker:price=${provisionalOutcomePrice.toFixed(3)}`,
    };
  }

  // Gate 0.5: Time-to-resolution gate.
  const ttr = checkTimeToResolution(endDate, maxHoursToResolution, minHoursToResolution);
  if (!ttr.ok) {
    return { hasTrade: false, decision: null, skipReason: ttr.skipReason ?? 'time_to_resolution' };
  }

  // Gate 1: Noisy signal — stddev too high. Threshold scales with sample count.
  if (consensusStddev > effectiveNoiseThreshold) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `noisy_signal:stddev=${consensusStddev.toFixed(3)},threshold=${effectiveNoiseThreshold.toFixed(3)}`,
    };
  }

  // Gate 1.5: Anchor-collapse — every provider returned ~0.5 with ~zero
  // disagreement. consensusCalculator's prompt instructs providers to return
  // EXACTLY 0.50 when they don't have an edge; when they all hit that anchor
  // we get phantom agreement. A legitimate 50/50 would show some
  // provider-to-provider disagreement; stddev≈0 at p≈0.5 is the default's
  // signature. Treat as no-signal rather than letting it slip through and
  // synthesize an edge against the market.
  if (
    Math.abs(p - 0.5) < anchorCollapsePDelta &&
    consensusStddev < anchorCollapseStddevEpsilon
  ) {
    return {
      hasTrade: false,
      decision: null,
      skipReason: `anchor_collapse:p=${p.toFixed(3)},stddev=${consensusStddev.toFixed(4)}`,
    };
  }

  // Gate 2: EV gate — use pessimistic confidence bound, not point estimate
  // YES trade: pessimistic p(YES) = p - stddev (event less likely than estimated)
  // NO trade:  pessimistic p(NO)  = 1 - (p + stddev) (event more likely than estimated)
  // Direction uses effectiveYesPrice (bias-corrected) to decide which side to trade,
  // but payout/EV uses the raw market price because that's the actual cost of entry.
  const p_lower = Math.max(0, p - consensusStddev);
  const p_upper = Math.min(1, p + consensusStddev);
  const direction_for_ev: 'YES' | 'NO' = p - effectiveYesPrice > 0 ? 'YES' : 'NO';
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

  // Edge is measured against effectiveYesPrice (bias-corrected "true" probability).
  const edge = p - effectiveYesPrice;
  const edgeMagnitude = Math.abs(edge);

  if (edgeMagnitude < divergenceThreshold) {
    return { hasTrade: false, decision: null };
  }

  const direction: 'YES' | 'NO' = edge > 0 ? 'YES' : 'NO';

  // For NO trades, work in complementary probability space.
  // outcomePrice uses the ACTUAL market price (what we pay), not the bias-corrected one.
  // Kelly sizing must use the real market price because that's the actual cost of entry.
  const outcomePrice = direction === 'YES' ? currentYesPrice : 1 - currentYesPrice;
  const tradeProbability = direction === 'YES' ? p : 1 - p;

  const halfKellyFraction = computeHalfKelly(tradeProbability, outcomePrice, kellyFraction);

  // Kelly sign-stability check — perturb probability by ±delta; if Kelly
  // flips to non-positive on either side, the edge is too fragile to bet.
  if (kellyRequireSignStable && halfKellyFraction > 0) {
    const pPlus = Math.min(1, tradeProbability + kellyProbeDelta);
    const pMinus = Math.max(0, tradeProbability - kellyProbeDelta);
    const kellyPlus = computeHalfKelly(pPlus, outcomePrice, kellyFraction);
    const kellyMinus = computeHalfKelly(pMinus, outcomePrice, kellyFraction);
    if (kellyPlus <= 0 || kellyMinus <= 0) {
      return {
        hasTrade: false,
        decision: null,
        skipReason: `kelly_sign_unstable:p=${tradeProbability.toFixed(3)},kelly=${halfKellyFraction.toFixed(4)}`,
      };
    }
  }

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
      priceZone: priceZoneOf(outcomePrice),
    },
  };
}

/**
 * Compute the fractional-Kelly fraction for a binary outcome.
 *
 * @param p - True probability of the outcome winning (0–1)
 * @param price - Market price of the outcome (0–1)
 * @param fraction - Kelly multiplier (default 0.25 = quarter-Kelly)
 * @returns Fractional-Kelly fraction (0–1). Returns 0 if Kelly is non-positive.
 */
export function computeHalfKelly(p: number, price: number, fraction = 0.25): number {
  if (price <= 0 || price >= 1) return 0;
  // Net odds: b = (1 - price) / price  (winning $1-price for every $price staked)
  const b = (1 - price) / price;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  if (kelly <= 0) return 0;
  return kelly * fraction;
}
