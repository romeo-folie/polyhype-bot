/**
 * Hong Kong Observatory ground-truth client.
 *
 * Fetches the absolute daily maximum temperature from HKO's dailyExtract
 * endpoint — the same source Polymarket uses to resolve Hong Kong temperature
 * markets. HKO reports to one decimal place (e.g. 22.3°C); bracket labels on
 * Polymarket are integer °C so the higher precision is informational only.
 *
 * Endpoints:
 *   Current month: https://www.weather.gov.hk/cis/dailyExtract/dailyExtract_YYYYMM.xml
 *   Past months:   https://www.weather.gov.hk/cis/dailyExtract/dailyExtract_YYYY.xml
 *
 * Response is JSON despite the .xml extension. Each dayData row carries (by
 * column index): [0] day, [1] mean pressure, [2] absolute daily MAX temp,
 * [3] mean temp, [4] absolute daily MIN temp, ... So row[2] resolves
 * "Highest temperature" markets and row[4] resolves "Lowest temperature" ones.
 *
 * No auth, no rate limit documented. Data lag: ~1 day.
 *
 * Log marker: [weather-hko]
 */

import { logger } from '../shared/logger.js';

const HKO_BASE = 'https://www.weather.gov.hk/cis/dailyExtract';
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchFn = typeof fetch;

function fetchWithTimeout(url: string, fetchFn: FetchFn): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetchFn(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

interface HkoMonthBlock {
  month: number;
  dayData: string[][];
}

interface HkoPayload {
  stn: { data: HkoMonthBlock[] };
}

/** dayData column index of the absolute daily extreme for each metric. */
const HKO_COL = { high: 2, low: 4 } as const;

/**
 * Fetch the absolute daily extreme temperature (max or min) from HKO for a given
 * date. Returns null if the date is not yet available (< 1-day lag) or data is
 * missing. `metric='low'` reads the daily-minimum column (row[4]) used to
 * resolve "Lowest temperature" markets.
 */
export async function fetchHkoDailyExtreme(
  date: string, // YYYY-MM-DD
  metric: 'high' | 'low' = 'high',
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  const parts = date.split('-');
  const year = parseInt(parts[0] ?? '', 10);
  const month = parseInt(parts[1] ?? '', 10);
  const day = parseInt(parts[2] ?? '', 10);
  if (!year || !month || !day) return null;
  const monthStr = String(month).padStart(2, '0');

  const now = new Date();
  const isCurrentMonth = year === now.getUTCFullYear() && month === now.getUTCMonth() + 1;

  const url = isCurrentMonth
    ? `${HKO_BASE}/dailyExtract_${year}${monthStr}.xml`
    : `${HKO_BASE}/dailyExtract_${year}.xml`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, fetchFn);
  } catch (err) {
    logger.warn('[weather-hko] fetch error', {
      date, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!res.ok) {
    logger.warn('[weather-hko] unexpected status', { date, status: res.status });
    return null;
  }

  let payload: HkoPayload;
  try {
    payload = (await res.json()) as HkoPayload;
  } catch {
    logger.warn('[weather-hko] JSON parse failed', { date });
    return null;
  }

  const block = payload?.stn?.data?.find((b) => b.month === month);
  if (!block) {
    logger.debug('[weather-hko] month block not found', { date, month });
    return null;
  }

  // dayData rows have the day number as a zero-padded or plain string at index 0.
  const dayPadded = String(day).padStart(2, '0');
  const row = block.dayData.find(
    (r) => r[0] === dayPadded || r[0] === String(day),
  );

  const col = HKO_COL[metric];
  if (!row || !row[col]) {
    logger.debug('[weather-hko] day row not found', { date, metric });
    return null;
  }

  const temp = parseFloat(row[col]);
  if (!Number.isFinite(temp)) return null;

  logger.debug('[weather-hko] daily extreme fetched', { date, metric, temp });
  return temp;
}

/**
 * Fetch the absolute daily MAXIMUM temperature from HKO. Thin wrapper over
 * {@link fetchHkoDailyExtreme} preserving the original call signature.
 */
export function fetchHkoDailyHigh(
  date: string,
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  return fetchHkoDailyExtreme(date, 'high', fetchFn);
}

/**
 * Fetch the absolute daily MINIMUM temperature from HKO — the resolution value
 * for "Lowest temperature in Hong Kong" markets.
 */
export function fetchHkoDailyLow(
  date: string,
  fetchFn: FetchFn = fetch,
): Promise<number | null> {
  return fetchHkoDailyExtreme(date, 'low', fetchFn);
}
