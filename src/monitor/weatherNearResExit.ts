/**
 * Weather near-resolution loss-cut evaluator.
 *
 * When a weather position is within WEATHER_NEAR_RES_HOURS of its endDate and
 * losing more than WEATHER_NEAR_RES_MIN_LOSS_PCT, this gate fires. By that point
 * the actual temperature measurement is effectively known — a losing position will
 * not recover.
 */

export interface WeatherNearResConfig {
  nearResHours: number;
  nearResMinLossPct: number;
}

export interface WeatherNearResDecision {
  shouldFire: boolean;
  hoursLeft: number;
}

export function evaluateWeatherNearRes(
  endDate: string | undefined,
  returnPct: number,
  cfg: WeatherNearResConfig,
  nowMs: number = Date.now(),
): WeatherNearResDecision {
  if (!endDate) return { shouldFire: false, hoursLeft: Infinity };
  const endMs = new Date(endDate).getTime();
  const hoursLeft = (endMs - nowMs) / (1000 * 60 * 60);
  const meetsTimeGate = hoursLeft > 0 && hoursLeft < cfg.nearResHours;
  const meetsLossGate = returnPct <= -cfg.nearResMinLossPct;
  return { shouldFire: meetsTimeGate && meetsLossGate, hoursLeft };
}
