/**
 * Maker rebate verification against the public CLOB rebates endpoint:
 *
 *   GET https://clob.polymarket.com/rebates/current?date=YYYY-MM-DD&maker_address=0x…
 *
 * No authentication required. Rebates are computed per market per day and paid
 * in pUSD once accrual crosses $1 — this module reads what Polymarket says we
 * earned so the daily summary can compare it against our own fill-time
 * estimates (audit P2.3/P2.4).
 *
 * The maker address is the wallet stamped as `maker` on our orders — the
 * funder/proxy wallet, not the signer (audit open question 1).
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { notify } from '../execution/telegram.js';
import { fetchWithTimeout } from '../mapping/gamma.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const REQUEST_TIMEOUT_MS = 10_000;
const STATS_KEY = 'rebate:stats';
const SUMMARY_SENT_PREFIX = 'rebate:summary_sent:';

/** One row of the rebates API response. */
export interface RebateApiRow {
  date: string;
  condition_id: string;
  asset_address: string;
  maker_address: string;
  rebated_fees_usdc: string;
}

export interface RebateApiResult {
  date: string;
  rows: RebateApiRow[];
  /** Σ rebated_fees_usdc across markets for the date. */
  totalUsd: number;
}

/**
 * Fetch API-reported rebate accrual for one maker address on one UTC date.
 * Returns null on fetch/parse failure — callers must distinguish "API said
 * zero" from "could not ask".
 */
export async function fetchRebatesForDate(
  date: string,
  makerAddress: string,
): Promise<RebateApiResult | null> {
  try {
    const url = `${CLOB_HOST}/rebates/current?date=${encodeURIComponent(date)}&maker_address=${encodeURIComponent(makerAddress)}`;
    const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
    if (!res.ok) {
      logger.warn('[rebate] rebates API fetch failed', { date, status: res.status });
      return null;
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      logger.warn('[rebate] rebates API returned non-array payload', { date });
      return null;
    }

    const rows = data as RebateApiRow[];
    let totalUsd = 0;
    for (const row of rows) {
      const v = parseFloat(row.rebated_fees_usdc ?? '0');
      if (isFinite(v)) totalUsd += v;
    }

    return { date, rows, totalUsd };
  } catch (err) {
    logger.warn('[rebate] rebates API fetch error', {
      date,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** UTC date string (YYYY-MM-DD) for `daysAgo` days before `nowMs`. */
export function utcDateString(daysAgo: number, nowMs: number = Date.now()): string {
  const d = new Date(nowMs - daysAgo * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Once per UTC day, compare what the public rebates API reports for YESTERDAY
 * with our cumulative fill-time estimates and operational counters, then log
 * it and send a Telegram summary. Yesterday is used because rebates are
 * computed and paid on a daily cycle — today's accrual is still moving.
 *
 * Returns true when a summary was sent this call (used by tests; callers may
 * ignore it). Never throws on API failure — the summary reports
 * "unavailable" instead so a Polymarket outage can't mask our own counters.
 */
export async function maybeSendDailySummary(redis: Redis): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.REBATE_DAILY_SUMMARY_ENABLED) return false;

  const today = utcDateString(0);
  const sentKey = `${SUMMARY_SENT_PREFIX}${today}`;
  // NX + 48h TTL: exactly one summary per UTC day, keys self-expire.
  const acquired = await redis.set(sentKey, '1', 'EX', 48 * 3600, 'NX');
  if (acquired !== 'OK') return false;

  const makerAddress = cfg.REBATE_MAKER_ADDRESS ?? cfg.POLYMARKET_FUNDER_ADDRESS;
  if (!makerAddress) {
    logger.warn('[rebate] daily summary skipped — no maker address configured', {
      hint: 'set REBATE_MAKER_ADDRESS or POLYMARKET_FUNDER_ADDRESS',
    });
    return false;
  }

  const yesterday = utcDateString(1);
  const api = await fetchRebatesForDate(yesterday, makerAddress);
  const stats = await redis.hgetall(STATS_KEY);

  const num = (field: string): number => {
    const v = parseFloat(stats[field] ?? '0');
    return isFinite(v) ? v : 0;
  };
  const lifetimeCount = num('lifetime_count');
  const avgLifetimeMin = lifetimeCount > 0 ? num('lifetime_ms_total') / lifetimeCount / 60_000 : 0;
  const fills = num('fills') + num('partial_fills');
  const estRebateUsd = num('est_rebate_usd');

  const apiLine = api
    ? `API ${yesterday}: $${api.totalUsd.toFixed(4)} across ${api.rows.length.toString()} market(s)`
    : `API ${yesterday}: unavailable`;

  const summary = [
    '🧾 Rebate Farmer Daily Summary',
    apiLine,
    `Cumulative est. rebates: $${estRebateUsd.toFixed(4)}`,
    `Fills: ${fills.toString()} (full ${num('fills').toString()} / partial ${num('partial_fills').toString()})`,
    `Placed: ${num('orders_placed').toString()} | stale-cancelled: ${num('stale_cancels').toString()} | repriced: ${num('reprice_cancels').toString()}`,
    `Avg order lifetime: ${avgLifetimeMin.toFixed(1)} min`,
  ].join('\n');

  logger.info('[rebate] daily summary', {
    apiDate: yesterday,
    apiTotalUsd: api?.totalUsd,
    apiRows: api?.rows.length,
    estRebateUsd,
    fills,
  });
  await notify(summary);
  return true;
}
