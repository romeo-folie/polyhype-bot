/**
 * Price zones for Polymarket entries.
 *
 * Based on "Zones of prediction market risk":
 *   Zone 1: <0.20   tail/longshot
 *   Zone 2: 0.20–0.40
 *   Zone 3: 0.40–0.60  fair-value neighborhood
 *   Zone 4: 0.60–0.80  "comfort trap" — asymmetric downside
 *   Zone 5: 0.80–0.98  "widow maker" — catastrophic R/R
 *
 * Single source of truth for zone classification used by the zone gate
 * (divergenceCalculator) and direct-signal paths (spot, futures).
 */

export type PriceZone = 1 | 2 | 3 | 4 | 5;

export function priceZoneOf(price: number): PriceZone {
  if (!isFinite(price)) return 3;
  if (price < 0.2) return 1;
  if (price < 0.4) return 2;
  if (price < 0.6) return 3;
  if (price < 0.8) return 4;
  return 5;
}
