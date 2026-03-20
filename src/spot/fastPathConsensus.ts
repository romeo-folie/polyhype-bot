/**
 * Fast-path consensus estimator.
 *
 * For price-target markets (e.g. "Will BTC be above $100k on June 30?"):
 *   Uses a Black-Scholes-inspired binary option probability formula.
 *   Runs in <1ms with zero API calls.
 *
 * For non-price-target markets (e.g. "Will the SEC approve a Bitcoin ETF?"):
 *   Falls back to the existing LLM-based consensus calculator,
 *   injecting the spot move as context.
 */

import { logger } from '../shared/logger.js';
import { estimateConsensusProbability } from '../mapping/consensusCalculator.js';
import type { SpotMove } from './thresholdDetector.js';
import type { CorrelatedMarket } from './marketCorrelator.js';

export interface FastConsensusResult {
  probability: number;
  reasoning: string;
  method: 'formula' | 'llm';
}

/** Default annualised volatility estimates by asset class. */
const DEFAULT_ANNUAL_VOL: Record<string, number> = {
  bitcoin: 0.80,
  ethereum: 0.90,
  'CL=F': 0.40,
  'GC=F': 0.20,
};

const DEFAULT_VOL = 0.60;

interface PriceTarget {
  targetPrice: number;
  direction: 'above' | 'below';
  deadlineMs: number; // epoch ms
}

/**
 * Attempt to extract a price target from a market question.
 *
 * Matches patterns like:
 *   "Will Bitcoin be above $100,000 on June 30, 2026?"
 *   "Will BTC exceed $150k by December 2026?"
 *   "Will ETH be below $2,000 on March 31?"
 */
export function extractPriceTarget(question: string): PriceTarget | null {
  // Match price: $100,000 or $100k or $150K
  const priceMatch = question.match(
    /\$([0-9,]+(?:\.[0-9]+)?)\s*([kKmM])?/,
  );
  if (!priceMatch) return null;

  let targetPrice = parseFloat(priceMatch[1]!.replace(/,/g, ''));
  const suffix = priceMatch[2]?.toLowerCase();
  if (suffix === 'k') targetPrice *= 1_000;
  if (suffix === 'm') targetPrice *= 1_000_000;
  if (!isFinite(targetPrice) || targetPrice <= 0) return null;

  // Direction: "above" or "below" / "exceed" / "reach" / "hit"
  const questionLower = question.toLowerCase();
  const isBelow = /\bbelow\b/.test(questionLower);
  const direction: 'above' | 'below' = isBelow ? 'below' : 'above';

  // Date extraction: try common patterns
  const deadlineMs = extractDeadline(question);
  if (deadlineMs == null) return null;

  return { targetPrice, direction, deadlineMs };
}

function extractDeadline(question: string): number | null {
  // Match patterns: "June 30, 2026", "December 2026", "March 31", "2026-06-30"
  const months: Record<string, number> = {
    january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
    july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  };

  // "Month Year" without day — check first to avoid "December 2026" matching as day=20
  const monthYearMatch = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
  );

  // "Month Day, Year" or "Month Day Year"
  const dateMatch = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?!\d)(?:\s*,\s*|\s+)(\d{4})\b/i,
  );

  if (dateMatch) {
    const month = months[dateMatch[1]!.toLowerCase()]!;
    const day = parseInt(dateMatch[2]!, 10);
    const year = parseInt(dateMatch[3]!, 10);
    return new Date(year, month, day).getTime();
  }

  // "Month Day" — no year, assume current year
  const monthDayMatch = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?!\d)\b/i,
  );

  if (monthDayMatch && !monthYearMatch) {
    const month = months[monthDayMatch[1]!.toLowerCase()]!;
    const day = parseInt(monthDayMatch[2]!, 10);
    return new Date(new Date().getFullYear(), month, day).getTime();
  }

  if (monthYearMatch) {
    const month = months[monthYearMatch[1]!.toLowerCase()]!;
    const year = parseInt(monthYearMatch[2]!, 10);
    // Last day of the month
    return new Date(year, month + 1, 0).getTime();
  }

  // ISO date: 2026-06-30
  const isoMatch = question.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    return new Date(
      parseInt(isoMatch[1]!, 10),
      parseInt(isoMatch[2]!, 10) - 1,
      parseInt(isoMatch[3]!, 10),
    ).getTime();
  }

  return null;
}

/**
 * Standard normal CDF approximation (Abramowitz and Stegun).
 */
function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Binary option probability: P(S_T > K) using Black-Scholes assumptions.
 *
 * d2 = (ln(S/K) + (r - 0.5*vol^2)*T) / (vol*sqrt(T))
 * P = N(d2)  for above, 1-N(d2) for below
 *
 * We assume r=0 (risk-free rate negligible for short horizons).
 */
export function formulaProbability(
  currentPrice: number,
  targetPrice: number,
  direction: 'above' | 'below',
  annualVol: number,
  timeToExpiryYears: number,
): number {
  if (timeToExpiryYears <= 0) {
    // Already expired — deterministic
    if (direction === 'above') return currentPrice > targetPrice ? 1 : 0;
    return currentPrice < targetPrice ? 1 : 0;
  }

  const volSqrtT = annualVol * Math.sqrt(timeToExpiryYears);
  if (volSqrtT === 0) {
    if (direction === 'above') return currentPrice > targetPrice ? 1 : 0;
    return currentPrice < targetPrice ? 1 : 0;
  }

  const d2 =
    (Math.log(currentPrice / targetPrice) - 0.5 * annualVol * annualVol * timeToExpiryYears) /
    volSqrtT;

  const prob = direction === 'above' ? normalCdf(d2) : 1 - normalCdf(d2);

  // Clamp to [0.01, 0.99] — never fully certain
  return Math.max(0.01, Math.min(0.99, prob));
}

/**
 * Estimate consensus probability for a correlated market given a spot move.
 *
 * Uses formula for price-target markets, falls back to LLM for complex markets.
 */
export async function estimateFastConsensus(
  move: SpotMove,
  market: CorrelatedMarket,
): Promise<FastConsensusResult> {
  // Try formula-based approach for price-target markets
  const priceTarget = extractPriceTarget(market.question);

  if (priceTarget) {
    const annualVol = DEFAULT_ANNUAL_VOL[move.assetId] ?? DEFAULT_VOL;
    const now = Date.now();
    const timeToExpiryYears = Math.max(0, (priceTarget.deadlineMs - now) / (365.25 * 24 * 3600 * 1000));

    const probability = formulaProbability(
      move.currentPrice,
      priceTarget.targetPrice,
      priceTarget.direction,
      annualVol,
      timeToExpiryYears,
    );

    const reasoning =
      `Formula: S=${move.currentPrice}, K=${priceTarget.targetPrice}, ` +
      `dir=${priceTarget.direction}, vol=${annualVol}, T=${timeToExpiryYears.toFixed(3)}yr → P=${probability.toFixed(3)}`;

    logger.info('[spot-fast-consensus] formula-based estimate', {
      marketId: market.marketId,
      probability,
      method: 'formula',
    });

    return { probability, reasoning, method: 'formula' };
  }

  // Non-price-target market: fall back to LLM with spot move as context
  const headline =
    `Breaking: ${move.assetId} just moved ${move.changePercent > 0 ? '+' : ''}${move.changePercent.toFixed(1)}% ` +
    `in ${move.windowMinutes} minutes (now at $${move.currentPrice.toLocaleString()}).`;

  const estimate = await estimateConsensusProbability({
    question: market.question,
    description: market.description,
    headline,
    currentYesPrice: market.currentYesPrice,
  });

  logger.info('[spot-fast-consensus] LLM-based estimate', {
    marketId: market.marketId,
    probability: estimate.probability,
    method: 'llm',
  });

  return {
    probability: estimate.probability,
    reasoning: estimate.reasoning,
    method: 'llm',
  };
}
