/**
 * Weather strategy daily digest.
 *
 * Once per UTC day, summarise how the weather strategy performed over the
 * *previous* weather day and send it to Telegram — the weather analogue of the
 * rebate farmer's daily summary (`src/rebate/rebateChecker.ts`).
 *
 * Yesterday (not today) is used because weather PnL is only realised when a
 * market resolves at the end of its local day; today's resolutions are still
 * moving.
 *
 * Two different clocks, intentionally:
 *   - Entry-activity sections (placed/filled) are windowed by the UTC calendar
 *     day — they describe what we DID yesterday (UTC).
 *   - Resolutions (PnL, wins/losses, best/worst) are bucketed by each market's
 *     CITY-LOCAL resolution day. A "June 13" market resolves at local midnight,
 *     which for Western-hemisphere cities lands in the next UTC day — so grouping
 *     resolutions by closed_at's UTC date splits a weather day in two and pushes
 *     Western wins into the wrong report. The send is also deferred to
 *     WEATHER_DAILY_SUMMARY_MIN_UTC_HOUR so those late resolutions have settled.
 *
 * Data sources (all populated in Postgres; `signal_decisions` is intentionally
 * NOT used — the weather path never writes it):
 *   - execution_events  source='weather', final_execution_path='maker_pending'
 *                       → resting maker orders we worked  ("bets placed")
 *   - positions         sourced_from LIKE 'weather%'      → fills that became
 *                       positions, entry prices, stake     ("filled")
 *   - outcomes          source='weather'                  → realised PnL,
 *                       wins/losses, return %, best/worst (bucketed by weather day)
 *
 * Fired from the weather cron entrypoint (`weatherScanner.ts` main()) every
 * scan; a Redis NX key (`weather:summary_sent:<day>`) makes it send at most once
 * per UTC day. Best-effort: never throws into the scan loop.
 *
 * Log marker: [weather-digest]
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { notify, escapeHtml } from '../execution/telegram.js';
import { getSql } from '../db/client.js';
import { utcDateString } from '../rebate/rebateChecker.js';
import { weatherTargetDateFromQuestion } from './resolutionTime.js';

const SUMMARY_SENT_PREFIX = 'weather:summary_sent:';

interface FilledRow {
  entryPrice: number;
  stakeUsd: number | null;
  direction: string;
  question: string;
}

interface ResolvedRow {
  result: 'won' | 'lost' | 'pushed';
  returnPct: number;
  entryPrice: number | null;
  direction: string;
  question: string;
  pnlUsd: number;
  /** ISO close timestamp — used to bucket by city-local weather day. */
  closedAt: string;
}

/**
 * The weather day a resolved row belongs to: the city-local target date parsed
 * from the question ("on June 13"), falling back to the UTC date of closed_at
 * when the question can't be parsed. Grouping by closed_at's UTC date alone is
 * wrong — a "June 13" market in a Western-hemisphere city resolves at local
 * midnight, which lands in the NEXT UTC day.
 */
function weatherDayOf(row: { question: string; closedAt: string }): string {
  // closedAt is a 'YYYY-MM-DD …' string (timestamptz::text); the date-only slice
  // is both the year hint for parsing (a reliable ISO date for `new Date()`) and
  // the fallback bucket when the question can't be parsed.
  const closedDate = row.closedAt.slice(0, 10);
  return weatherTargetDateFromQuestion(row.question, closedDate) ?? closedDate;
}

/** Signed dollar amount, e.g. +$8.65 / -$2.10. */
function fmtMoney(n: number): string {
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

/** Signed percentage, e.g. +0.6% / -100.0%. */
function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** Truncate a market question for a compact one-line entry. */
function shortQuestion(q: string): string {
  const trimmed = q.trim();
  return trimmed.length > 50 ? `${trimmed.slice(0, 49)}…` : trimmed;
}

/** One best/worst trade line. */
function tradeLine(emoji: string, label: string, row: ResolvedRow): string {
  const entry = row.entryPrice != null ? ` @ ${row.entryPrice.toFixed(3)}` : '';
  return (
    `${emoji} <b>${label}:</b> ${escapeHtml(shortQuestion(row.question))} ` +
    `${escapeHtml(row.direction)}${entry} → ${fmtMoney(row.pnlUsd)} (${fmtPct(row.returnPct)})`
  );
}

/**
 * Build, log, and send the weather daily digest for yesterday (UTC). Returns
 * true when a summary was sent this call (used by tests). Never throws on a DB
 * or Telegram failure — callers run it best-effort inside the scan loop.
 *
 * `nowMs` is injectable for deterministic tests; production uses Date.now().
 */
export async function maybeSendWeatherDailySummary(
  redis: Redis,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.WEATHER_DAILY_SUMMARY_ENABLED) return false;

  // Resolve the DB handle BEFORE acquiring the date gate — getSql() throws
  // synchronously when no PG_URL is configured. Doing it first means a
  // misconfiguration can't silently burn the day's one send for 48h (matches
  // the prereq-before-gate discipline in rebateChecker.maybeSendDailySummary).
  const sql = getSql();

  const today = utcDateString(0, nowMs);

  // Defer until late enough in the UTC day that the PREVIOUS weather-day's
  // Western-hemisphere markets have all resolved (they settle at city-local
  // midnight ≈ early-UTC the next day). Checked BEFORE the NX gate so an early
  // scan returns without burning the day's one send. A genuine misconfiguration
  // (hour > 23) can't permanently block — the value is clamped to 0..23 by Zod.
  if (new Date(nowMs).getUTCHours() < cfg.WEATHER_DAILY_SUMMARY_MIN_UTC_HOUR) {
    return false;
  }

  const sentKey = `${SUMMARY_SENT_PREFIX}${today}`;
  // NX + 48h TTL: exactly one summary per UTC day; the key self-expires.
  const acquired = await redis.set(sentKey, '1', 'EX', 48 * 3600, 'NX');
  if (acquired !== 'OK') return false;

  const day = utcDateString(1, nowMs);
  // Explicit UTC bounds for the entry-activity sections — do NOT rely on the DB
  // session timezone (CURRENT_DATE).
  const start = `${day}T00:00:00Z`;
  const end = `${today}T00:00:00Z`;
  // Resolutions are bucketed by city-local weather day (see weatherDayOf), so the
  // SQL scan must span a window wide enough to catch every row whose weather day
  // is `day`: from an early drift-exit a couple of days before, to an Americas
  // local-midnight resolution that lands in the next UTC day. day-2 … day+2.
  const resolvedScanStart = `${utcDateString(3, nowMs)}T00:00:00Z`;
  const resolvedScanEnd = `${utcDateString(-1, nowMs)}T00:00:00Z`;

  // 1. Resting maker orders we worked yesterday (distinct market+side).
  const placedRows = await sql<{ placed: number }[]>`
    SELECT COUNT(DISTINCT market_id || ':' || direction)::int AS placed
    FROM execution_events
    WHERE source = 'weather'
      AND final_execution_path = 'maker_pending'
      AND created_at >= ${start} AND created_at < ${end}
  `;
  const placed = placedRows[0]?.placed ?? 0;

  // 2. Fills that became positions yesterday — entry prices + stake.
  const filled = await sql<FilledRow[]>`
    SELECT entry_price::float8        AS "entryPrice",
           stake_usd::float8          AS "stakeUsd",
           direction,
           question
    FROM positions
    WHERE sourced_from LIKE 'weather%'
      AND opened_at >= ${start} AND opened_at < ${end}
  `;

  // 3. Markets whose weather day is `day` — realised PnL, wins/losses, best/worst.
  // Scanned over a wide closed_at window, then bucketed by city-local weather day
  // (weatherDayOf) and sorted by realised PnL (worst first, best last) in TS.
  const resolvedScan = await sql<ResolvedRow[]>`
    SELECT result,
           return_pct::float8                                AS "returnPct",
           entry_price::float8                               AS "entryPrice",
           direction,
           question,
           (COALESCE(stake_usd, 0) * return_pct / 100.0)::float8 AS "pnlUsd",
           -- Render as a UTC string (not ::text, which uses the session timezone
           -- and would mis-date the weatherDayOf fallback on a non-UTC session;
           -- and not an uncast timestamptz, which postgres.js returns as a JS Date
           -- that weatherDayOf can't slice).
           to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "closedAt"
    FROM outcomes
    WHERE source = 'weather'
      AND closed_at >= ${resolvedScanStart} AND closed_at < ${resolvedScanEnd}
  `;
  const resolved = resolvedScan
    .filter((r) => weatherDayOf(r) === day)
    .sort((a, b) => (a.pnlUsd ?? 0) - (b.pnlUsd ?? 0));

  // ── Aggregate ──────────────────────────────────────────────────────────────
  const filledCount = filled.length;
  const stakedUsd = filled.reduce((s, r) => s + (r.stakeUsd ?? 0), 0);
  const entryPrices = filled.map((r) => r.entryPrice).filter((p) => isFinite(p));
  const avgEntry = entryPrices.length
    ? entryPrices.reduce((s, p) => s + p, 0) / entryPrices.length
    : null;
  const minEntry = entryPrices.length ? Math.min(...entryPrices) : null;
  const maxEntry = entryPrices.length ? Math.max(...entryPrices) : null;

  const wins = resolved.filter((r) => r.result === 'won').length;
  const losses = resolved.filter((r) => r.result === 'lost').length;
  const pushes = resolved.filter((r) => r.result === 'pushed').length;
  const decisive = wins + losses;
  const pnlUsd = resolved.reduce((s, r) => s + (isFinite(r.pnlUsd) ? r.pnlUsd : 0), 0);
  const avgReturn = resolved.length
    ? resolved.reduce((s, r) => s + (isFinite(r.returnPct) ? r.returnPct : 0), 0) / resolved.length
    : null;

  // ── Empty day: one-line heartbeat so the digest is visibly alive ───────────
  if (placed === 0 && filledCount === 0 && resolved.length === 0) {
    const line = `🌤️ Weather Daily Summary — ${day} (UTC): no activity`;
    logger.info('[weather-digest] daily summary (no activity)', { day });
    await notify(line);
    return true;
  }

  // ── Build message ──────────────────────────────────────────────────────────
  const lines: string[] = [
    '🌤️ <b>Weather Daily Summary</b>',
    `Day ${day} (UTC)`,
    `<b>Entries:</b> ${placed} resting order(s) worked → ${filledCount} filled into position(s)`,
  ];

  if (filledCount > 0) {
    const pricePart =
      avgEntry != null
        ? `avg ${avgEntry.toFixed(3)} (range ${minEntry!.toFixed(3)}–${maxEntry!.toFixed(3)})`
        : 'n/a';
    lines.push(`<b>Fill prices:</b> ${pricePart} | staked $${stakedUsd.toFixed(2)}`);
  }

  if (resolved.length > 0) {
    const winRate = decisive > 0 ? `${((wins / decisive) * 100).toFixed(1)}%` : '—';
    const pushPart = pushes > 0 ? ` / ${pushes}P` : '';
    lines.push(
      `<b>Resolved:</b> ${resolved.length} market(s) — ${wins}W / ${losses}L${pushPart} (${winRate})`,
    );
    lines.push(
      `<b>Realized PnL:</b> ${fmtMoney(pnlUsd)}` +
        (avgReturn != null ? ` | avg return ${fmtPct(avgReturn)}` : ''),
    );
    // Best = highest PnL (last row), worst = lowest PnL (first row).
    const worst = resolved[0]!;
    const best = resolved[resolved.length - 1]!;
    lines.push(tradeLine('🏆', 'Best', best));
    if (resolved.length > 1) lines.push(tradeLine('💧', 'Worst', worst));
  } else {
    lines.push('<b>Resolved:</b> none');
  }

  const summary = lines.join('\n');

  logger.info('[weather-digest] daily summary', {
    day,
    placed,
    filled: filledCount,
    stakedUsd: Number(stakedUsd.toFixed(2)),
    resolved: resolved.length,
    wins,
    losses,
    pushes,
    pnlUsd: Number(pnlUsd.toFixed(2)),
  });
  await notify(summary);
  return true;
}
