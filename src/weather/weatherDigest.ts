/**
 * Weather strategy daily digest.
 *
 * Once per UTC day, summarise how the weather strategy performed over the
 * *previous* complete UTC day and send it to Telegram — the weather analogue of
 * the rebate farmer's daily summary (`src/rebate/rebateChecker.ts`).
 *
 * Yesterday (not today) is used because weather PnL is only realised when a
 * market resolves at the end of its local day; today's resolutions are still
 * moving. The window is the same for every section so the report is one coherent
 * UTC day.
 *
 * Data sources (all populated in Postgres; `signal_decisions` is intentionally
 * NOT used — the weather path never writes it):
 *   - execution_events  source='weather', final_execution_path='maker_pending'
 *                       → resting maker orders we worked  ("bets placed")
 *   - positions         sourced_from LIKE 'weather%'      → fills that became
 *                       positions, entry prices, stake     ("filled")
 *   - outcomes          source='weather'                  → realised PnL,
 *                       wins/losses, return %, best/worst
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
  const sentKey = `${SUMMARY_SENT_PREFIX}${today}`;
  // NX + 48h TTL: exactly one summary per UTC day; the key self-expires.
  const acquired = await redis.set(sentKey, '1', 'EX', 48 * 3600, 'NX');
  if (acquired !== 'OK') return false;

  const day = utcDateString(1, nowMs);
  // Explicit UTC bounds — do NOT rely on the DB session timezone (CURRENT_DATE).
  const start = `${day}T00:00:00Z`;
  const end = `${today}T00:00:00Z`;

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

  // 3. Markets that resolved yesterday — realised PnL, wins/losses, best/worst.
  // Ordered by realised PnL so the first row is the worst, the last the best.
  const resolved = await sql<ResolvedRow[]>`
    SELECT result,
           return_pct::float8                                AS "returnPct",
           entry_price::float8                               AS "entryPrice",
           direction,
           question,
           (COALESCE(stake_usd, 0) * return_pct / 100.0)::float8 AS "pnlUsd"
    FROM outcomes
    WHERE source = 'weather'
      AND closed_at >= ${start} AND closed_at < ${end}
    ORDER BY (COALESCE(stake_usd, 0) * return_pct / 100.0) ASC
  `;

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
