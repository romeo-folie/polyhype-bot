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
  currentYesPrice: number;
  /** Total portfolio value in USD */
  bankrollUsd: number;
  /** Minimum required edge to trade (0–1). Typically 0.10 = 10%. */
  divergenceThreshold: number;
  /** Maximum fraction of bankroll per trade. Typically 0.10 = 10%. */
  maxBetFraction: number;
}

export interface DivergenceResult {
  hasTrade: boolean;
  decision: TradeDecision | null;
}

/**
 * Compute edge and position size.
 *
 * Returns `hasTrade: false` when edge is below the divergence threshold.
 */
export function computeDivergence(input: DivergenceInput): DivergenceResult {
  const {
    consensusProbability: p,
    currentYesPrice,
    bankrollUsd,
    divergenceThreshold,
    maxBetFraction,
  } = input;

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
  const stakeUsd = Math.max(0, cappedFraction * bankrollUsd);

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
