/**
 * Le 2026 recalibration bias correction.
 *
 * Prediction markets are systematically biased by domain:
 *   - Politics: underconfident (favourites underpriced) => theta > 1
 *   - Sports >1mo: underconfident => theta > 1
 *   - Weather ≤48h: overconfident (favourites overpriced) => theta < 1
 *   - Crypto: well-calibrated => theta ~ 1
 *
 * Formula:  p* = p^theta / [p^theta + (1-p)^theta]
 *
 * p* represents the "true" probability implied by the biased market price.
 * When theta > 1, p* > p for p > 0.5 (market underprices favourites).
 * When theta < 1, p* < p for p > 0.5 (market overprices favourites).
 * When theta = 1, p* = p (identity — no correction).
 */

import { loadConfig, type AppConfig } from '../shared/config.js';

export interface CalibrationBiasResult {
  /** Recalibrated price — the "true" probability implied by the biased market. */
  adjustedPrice: number;
  /** Domain-specific theta used for this correction. */
  theta: number;
  /** Original market price, unchanged. */
  rawPrice: number;
}

/**
 * Apply the Le 2026 recalibration formula to a market price.
 *
 * @param marketPrice - Raw market price (0-1).
 * @param theta - Domain-specific recalibration exponent.
 * @returns Adjusted price (0-1). Returns boundary values for p=0 or p=1.
 */
export function recalibratePrice(marketPrice: number, theta: number): number {
  // Boundary cases: formula is undefined at 0 and 1, but limits are well-defined.
  if (marketPrice <= 0) return 0;
  if (marketPrice >= 1) return 1;

  // Identity shortcut — skip the math when theta = 1.
  if (theta === 1) return marketPrice;

  const pTheta = Math.pow(marketPrice, theta);
  const qTheta = Math.pow(1 - marketPrice, theta);
  const denominator = pTheta + qTheta;

  // Guard against degenerate numerics (should not happen for valid inputs).
  if (denominator === 0) return marketPrice;

  return pTheta / denominator;
}

/** Max hours for weather overconfidence bias to apply (48h). */
const WEATHER_BIAS_MAX_HOURS = 48;

/**
 * Resolve the recalibration theta for a given market category.
 *
 * @param category - Market category (e.g. 'us-politics', 'sports').
 * @param timeToResolutionHours - Optional hours until market resolves.
 *   Used to distinguish short-term sports (<=720h / 1mo) from long-term,
 *   and to gate weather bias to <48h markets only.
 * @param cfg - Optional pre-loaded config to avoid redundant loadConfig() calls.
 * @returns Domain-specific theta value from config.
 */
export function getThetaForCategory(
  category: string,
  timeToResolutionHours?: number,
  cfg?: AppConfig,
): number {
  const c = cfg ?? loadConfig();

  switch (category) {
    case 'us-politics':
    case 'geopolitical':
      return c.CALIBRATION_BIAS_THETA_POLITICS;

    case 'sports':
    case 'sports-nba':
    case 'sports-nfl':
    case 'sports-soccer':
    case 'sports-mlb': {
      // Sports short-term (<=1 month / 720h) vs long-term (>1 month).
      // If timeToResolutionHours is unknown, default to short-term (conservative).
      const isLongTerm = timeToResolutionHours !== undefined && timeToResolutionHours > 720;
      return isLongTerm
        ? c.CALIBRATION_BIAS_THETA_SPORTS_LONG
        : c.CALIBRATION_BIAS_THETA_SPORTS_SHORT;
    }

    case 'weather':
      // Weather overconfidence bias only applies to short-horizon (≤48h) markets.
      // Longer-horizon weather markets are closer to well-calibrated.
      // When horizon is unknown, default conservatively (no bias correction).
      if (timeToResolutionHours === undefined || timeToResolutionHours > WEATHER_BIAS_MAX_HOURS) {
        return c.CALIBRATION_BIAS_THETA_DEFAULT;
      }
      return c.CALIBRATION_BIAS_THETA_WEATHER;

    case 'crypto-regulatory':
    case 'crypto-updown':
      return c.CALIBRATION_BIAS_THETA_CRYPTO;

    case 'ai-tech':
    case 'entertainment':
      return c.CALIBRATION_BIAS_THETA_ENTERTAINMENT;

    case 'macro':
      // Macro is closer to politics in terms of calibration bias.
      return c.CALIBRATION_BIAS_THETA_POLITICS;

    default:
      return c.CALIBRATION_BIAS_THETA_DEFAULT;
  }
}

/**
 * Convenience wrapper: resolve theta for the category, apply recalibration,
 * and return the full result with metadata.
 *
 * @param marketPrice - Raw market YES price (0-1).
 * @param category - Market category string.
 * @param timeToResolutionHours - Optional hours until resolution.
 * @param cfg - Optional pre-loaded config to avoid redundant loadConfig() calls.
 */
export function applyCategoryBias(
  marketPrice: number,
  category: string,
  timeToResolutionHours?: number,
  cfg?: AppConfig,
): CalibrationBiasResult {
  const theta = getThetaForCategory(category, timeToResolutionHours, cfg);
  const adjustedPrice = recalibratePrice(marketPrice, theta);
  return { adjustedPrice, theta, rawPrice: marketPrice };
}
