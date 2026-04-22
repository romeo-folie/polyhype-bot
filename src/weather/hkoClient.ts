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
 * Response is JSON despite the .xml extension. Column index 2 of each dayData
 * row is the absolute daily maximum temperature.
 *
 * No auth, no rate limit documented. Data lag: ~1 day.
 *
 * Log marker: [weather-hko]
 */

import { logger } from '../shared/logger.js';

const HKO_BASE = 'https://www.weather.gov.hk/cis/dailyExtract';

export type FetchFn = typeof fetch;

interface HkoMonthBlock {
  month: number;
  dayData: string[][];
}

interface HkoPayload {
  stn: { data: HkoMonthBlock[] };
}

/**
 * Fetch the absolute daily maximum temperature from HKO for a given date.
 * Returns null if the date is not yet available (< 1-day lag) or data is missing.
 */
export async function fetchHkoDailyHigh(
  date: string, // YYYY-MM-DD
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
    res = await fetchFn(url);
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

  if (!row || !row[2]) {
    logger.debug('[weather-hko] day row not found', { date });
    return null;
  }

  const temp = parseFloat(row[2]);
  if (!Number.isFinite(temp)) return null;

  logger.debug('[weather-hko] daily high fetched', { date, temp });
  return temp;
}
