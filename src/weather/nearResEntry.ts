/**
 * Weather near-resolution entry gate.
 *
 * Blocks new weather entries when the market is within WEATHER_NEAR_RES_ENTRY_HOURS
 * of its endDate. By that point the overnight GFS forecast is stale — intraday
 * temperature tracking has already overridden it, and any edge we see is a
 * phantom from a stale model vs. a correctly-repriced market.
 */

export interface WeatherNearResEntryDecision {
  shouldSkip: boolean;
  hoursLeft: number;
}

export function evaluateWeatherNearResEntry(
  endDate: string | undefined | null,
  thresholdHours: number,
  nowMs: number = Date.now(),
): WeatherNearResEntryDecision {
  if (!endDate) return { shouldSkip: false, hoursLeft: Infinity };
  const endMs = new Date(endDate).getTime();
  if (!Number.isFinite(endMs)) return { shouldSkip: false, hoursLeft: Infinity };
  const hoursLeft = (endMs - nowMs) / (1000 * 60 * 60);
  const withinWindow = hoursLeft > 0 && hoursLeft <= thresholdHours;
  return { shouldSkip: withinWindow, hoursLeft };
}
