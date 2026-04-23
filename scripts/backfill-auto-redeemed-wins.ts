/**
 * Backfill auto-redeemed wins from a Polymarket history CSV export.
 *
 * Usage:
 *   docker compose exec pga-db-writer bash -c \
 *     'PG_URL="$PG_URL_NOPASS" npx tsx scripts/backfill-auto-redeemed-wins.ts <csv-path> [--apply]'
 *
 * Fixes the silent-wins bug caused by Polymarket's account-level auto-redeemer:
 * when PM's backend pays out a winning position the CTF burns the shares,
 * our on-chain balance query returns 0, and our resolutionRedeemer previously
 * wrote a -100% loss. PR #309 fixes this prospectively; this script repairs
 * the backlog.
 *
 * Approach (per (question, direction) pair):
 *   1. Aggregate all Buy / Sell / Redeem CSV rows into cost vs proceeds.
 *   2. Only consider pairs where a Redeem event with usdcAmount > 0 exists
 *      (confirms an auto-redeem happened that we may have missed).
 *   3. Find the matching outcomes row(s) in DB by question + direction.
 *   4. If no DB row already says 'won', propose an UPDATE that:
 *        - flips result → 'won'
 *        - sets return_pct from realized net P&L (proceeds − cost) / cost
 *        - sets exit_reason → 'auto_redeemed_win_backfill'
 *        - stashes the previous values in raw.backfill_* for audit
 *
 * Dry-run by default. Pass --apply to commit UPDATEs.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { getSql, closeSql } from '../src/db/client.js';
import { inferCategory } from '../src/shared/outcomeRecorder.js';

type Action = 'Buy' | 'Sell' | 'Redeem' | 'Deposit';

interface CsvRow {
  action: Action;
  question: string;
  direction: 'YES' | 'NO';
  usdcAmount: number;
  tokenAmount: number;
  timestamp: number;
  hash: string;
}

// Minimal RFC-4180 CSV line parser: handles quoted fields and escaped quotes
// (""). Expects caller to have already stripped the trailing \r (or to not have
// one). Suitable for the single-line Polymarket export where questions may
// contain commas but don't embed raw quotes.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++; // skip the escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur || line.endsWith(',')) out.push(cur);
  return out;
}

// Polymarket token-name conventions in the CSV export:
//   Yes/Up/Over/<team-or-bracket-name> → YES side
//   No/Down/Under                      → NO side
//   Empty (always on Redeem rows)      → infer from the latest Buy/Sell
// Returns null when we cannot confidently map the label.
function normalizeDirection(tokenName: string): 'YES' | 'NO' | null {
  const u = tokenName.trim().toUpperCase();
  if (u === '') return null;
  if (u === 'YES' || u === 'UP' || u === 'OVER') return 'YES';
  if (u === 'NO' || u === 'DOWN' || u === 'UNDER') return 'NO';
  // Named outcome (team / bracket label). Polymarket encodes these as the
  // YES side of a sub-market, so they always map to YES.
  return 'YES';
}

function parseCsv(path: string): { rows: CsvRow[]; skipped: number } {
  // Strip BOM, normalize CRLF → LF, then split.
  const raw = readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n').filter((l) => l.trim());
  // Two-pass parse: first collect direction per (question) from Buy/Sell rows,
  // then resolve empty-tokenName Redeem rows by lookup.
  type Raw = {
    question: string;
    action: Action;
    usdc: number;
    tokens: number;
    tokenName: string;
    timestamp: number;
    hash: string;
  };
  const rawRows: Raw[] = [];
  let skipped = 0;
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]!);
    if (fields.length < 7) {
      skipped++;
      continue;
    }
    const [question, action, usdcStr, tokenAmountStr, tokenName, tsStr, hash] = fields;
    if (action !== 'Buy' && action !== 'Sell' && action !== 'Redeem') continue;
    const usdc = parseFloat(usdcStr ?? '0');
    const tokens = parseFloat(tokenAmountStr ?? '0');
    const ts = parseInt(tsStr ?? '0', 10);
    rawRows.push({
      question: question ?? '',
      action: action as Action,
      usdc: Number.isFinite(usdc) ? usdc : 0,
      tokens: Number.isFinite(tokens) ? tokens : 0,
      tokenName: tokenName ?? '',
      timestamp: Number.isFinite(ts) ? ts : 0,
      hash: hash ?? '',
    });
  }

  // Pass 1: latest observed direction per (question) from Buy/Sell rows.
  // When the account has traded both sides of a market, the latest Buy/Sell
  // before a given Redeem is the best hint for which side was being redeemed.
  const directionByQuestion = new Map<string, { dir: 'YES' | 'NO'; ts: number }[]>();
  for (const r of rawRows) {
    if (r.action === 'Redeem') continue;
    const dir = normalizeDirection(r.tokenName);
    if (!dir) continue;
    const existing = directionByQuestion.get(r.question) ?? [];
    existing.push({ dir, ts: r.timestamp });
    directionByQuestion.set(r.question, existing);
  }

  // Pass 2: build output rows, resolving direction for Redeems.
  const rows: CsvRow[] = [];
  for (const r of rawRows) {
    let dir: 'YES' | 'NO' | null = normalizeDirection(r.tokenName);
    if (!dir && r.action === 'Redeem') {
      // Use the latest Buy/Sell direction at or before this Redeem's timestamp.
      const buys = directionByQuestion.get(r.question) ?? [];
      const priorSorted = buys
        .filter((b) => b.ts <= r.timestamp)
        .sort((a, b) => b.ts - a.ts);
      if (priorSorted.length > 0) {
        dir = priorSorted[0]!.dir;
      } else if (buys.length > 0) {
        // No prior direction but we have some from later rows — use earliest.
        dir = buys.sort((a, b) => a.ts - b.ts)[0]!.dir;
      }
    }
    if (!dir) {
      skipped++;
      continue;
    }
    rows.push({
      action: r.action,
      question: r.question,
      direction: dir,
      usdcAmount: r.usdc,
      tokenAmount: r.tokens,
      timestamp: r.timestamp,
      hash: r.hash,
    });
  }
  return { rows, skipped };
}

interface Aggregate {
  question: string;
  direction: 'YES' | 'NO';
  buyUsdc: number;
  sellUsdc: number;
  redeemUsdc: number;
  hasRedeemPayout: boolean;
  eventCount: number;
  latestTs: number;
}

function aggregate(rows: CsvRow[]): Map<string, Aggregate> {
  const out = new Map<string, Aggregate>();
  for (const r of rows) {
    const key = `${r.question}||${r.direction}`;
    const agg = out.get(key) ?? {
      question: r.question,
      direction: r.direction,
      buyUsdc: 0,
      sellUsdc: 0,
      redeemUsdc: 0,
      hasRedeemPayout: false,
      eventCount: 0,
      latestTs: 0,
    };
    if (r.action === 'Buy') agg.buyUsdc += r.usdcAmount;
    else if (r.action === 'Sell') agg.sellUsdc += r.usdcAmount;
    else if (r.action === 'Redeem') {
      agg.redeemUsdc += r.usdcAmount;
      if (r.usdcAmount > 0) agg.hasRedeemPayout = true;
    }
    agg.eventCount += 1;
    if (r.timestamp > agg.latestTs) agg.latestTs = r.timestamp;
    out.set(key, agg);
  }
  return out;
}

interface Correction {
  outcomeId: string;
  question: string;
  direction: 'YES' | 'NO';
  dbResult: string;
  dbReturnPct: number;
  dbExitReason: string | null;
  dbStakeUsd: number;
  pmBuyUsdc: number;
  pmSellUsdc: number;
  pmRedeemUsdc: number;
  pmNetProceeds: number;
  correctedReturnPct: number;
  correctedResult: 'won' | 'lost';
}

function pickClosestBefore<
  T extends { closed_at: Date },
>(rows: T[], targetMs: number): T | null {
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const r of rows) {
    const ts = new Date(r.closed_at).getTime();
    if (!Number.isFinite(ts)) continue;
    if (ts > targetMs) continue; // closed after the redeem — unlikely match
    const delta = targetMs - ts;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = r;
    }
  }
  return best;
}

// Exit reasons that previously produced incorrect loss attribution on
// auto-redeemed positions. Used to rank DB candidates when multiple outcomes
// exist for the same (question, direction) — a bug-shaped row is preferred
// over one that resolved normally (e.g. a legitimate trailing_stop exit).
const BUG_SHAPED_EXIT_REASONS = new Set([
  'expired_dust',
  'expired_unresolvable',
  'expired_unresolvable_redeemed',
  'no_end_date_on_chain_resolved',
  'resolved_as_loss',
]);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith('--'));
  const apply = args.includes('--apply');
  if (!csvPath) {
    console.error(
      'Usage: npx tsx scripts/backfill-auto-redeemed-wins.ts <csv-path> [--apply]',
    );
    process.exit(1);
  }

  console.log(`Reading CSV: ${csvPath}`);
  const { rows, skipped } = parseCsv(csvPath);
  console.log(
    `Parsed ${rows.length} Buy/Sell/Redeem rows` +
      (skipped > 0 ? ` (${skipped} rows skipped: unknown direction or malformed)` : ''),
  );

  const aggregates = aggregate(rows);
  const autoRedeems = [...aggregates.values()].filter((a) => a.hasRedeemPayout);
  console.log(
    `Unique (market, direction) pairs: ${aggregates.size}, with Redeem payout: ${autoRedeems.length}`,
  );

  const sql = getSql();
  const corrections: Correction[] = [];
  const noDbRowEntries: Array<{
    question: string;
    direction: 'YES' | 'NO';
    buyUsdc: number;
    sellUsdc: number;
    redeemUsdc: number;
    netPnl: number;
    category: string;
  }> = [];
  let alreadyWon = 0;
  let alreadyCorrectLost = 0;

  for (const agg of autoRedeems) {
    // Match DB direction against the normalized CSV side. Our outcomes table
    // uses YES/NO for most sources and UP/DOWN for oracle-lag, so include the
    // synonym alongside the canonical value.
    const dbDirections =
      agg.direction === 'YES' ? ['YES', 'UP'] : ['NO', 'DOWN'];
    const rowsDb = await sql<
      Array<{
        outcome_id: string;
        result: string;
        return_pct: number;
        stake_usd: number;
        exit_reason: string | null;
        closed_at: Date;
      }>
    >`
      SELECT outcome_id, result, return_pct, stake_usd, exit_reason, closed_at
      FROM outcomes
      WHERE question = ${agg.question} AND direction IN ${sql(dbDirections)}
      ORDER BY closed_at DESC
    `;

    if (rowsDb.length === 0) {
      const netPnl = agg.sellUsdc + agg.redeemUsdc - agg.buyUsdc;
      const category = inferCategory(agg.question);
      noDbRowEntries.push({
        question: agg.question,
        direction: agg.direction,
        buyUsdc: agg.buyUsdc,
        sellUsdc: agg.sellUsdc,
        redeemUsdc: agg.redeemUsdc,
        netPnl,
        category,
      });
      continue;
    }

    // If any outcome row is already 'won', consider this market correctly handled.
    if (rowsDb.some((r) => r.result === 'won')) {
      alreadyWon++;
      continue;
    }

    // Pick the DB row most likely to be the misattributed one. Preference order:
    //   1. result='lost' AND exit_reason ∈ BUG_SHAPED_EXIT_REASONS (direct match
    //      for the auto-redeem bug)
    //   2. result='lost' with closed_at closest-before the redeem timestamp
    //      (for partial-fill cases where SL fired before resolution and residual
    //      shares later auto-redeemed)
    //   3. Most recent 'lost' row, as final fallback
    const redeemTsMs = agg.latestTs * 1000;
    const lostRows = rowsDb.filter((r) => r.result === 'lost');
    if (lostRows.length === 0) {
      // No lost row to correct. Skip silently (already_won path caught the good case).
      continue;
    }
    const bugShaped = lostRows.filter(
      (r) => r.exit_reason != null && BUG_SHAPED_EXIT_REASONS.has(r.exit_reason),
    );
    let target: (typeof lostRows)[number];
    if (bugShaped.length === 1) {
      target = bugShaped[0]!;
    } else if (bugShaped.length > 1) {
      // Multiple bug-shaped rows: pick the one with closed_at closest-before redeem ts.
      target = pickClosestBefore(bugShaped, redeemTsMs) ?? bugShaped[0]!;
    } else {
      // No explicitly-bug-shaped rows; fall back to closest-before across all losses.
      target = pickClosestBefore(lostRows, redeemTsMs) ?? lostRows[0]!;
    }

    // Compute realized net P&L from PM events.
    const cost = agg.buyUsdc;
    const proceeds = agg.sellUsdc + agg.redeemUsdc;
    const netReturnPct = cost > 0 ? ((proceeds - cost) / cost) * 100 : 0;
    const correctedResult: 'won' | 'lost' = proceeds > cost ? 'won' : 'lost';

    // If net P&L is negative, our DB's "lost" may already be roughly correct
    // (just with an inaccurate magnitude). Skip if return_pct is close.
    if (correctedResult === 'lost') {
      const diff = Math.abs(Number(target.return_pct) - netReturnPct);
      if (diff < 1) {
        alreadyCorrectLost++;
        continue;
      }
    }

    corrections.push({
      outcomeId: target.outcome_id,
      question: agg.question,
      direction: agg.direction,
      dbResult: target.result,
      dbReturnPct: Number(target.return_pct),
      dbExitReason: target.exit_reason,
      dbStakeUsd: Number(target.stake_usd),
      pmBuyUsdc: agg.buyUsdc,
      pmSellUsdc: agg.sellUsdc,
      pmRedeemUsdc: agg.redeemUsdc,
      pmNetProceeds: proceeds,
      correctedReturnPct: netReturnPct,
      correctedResult,
    });
  }

  console.log('\n=== Backfill Report ===');
  console.log(`PM redeem-payout pairs:       ${autoRedeems.length}`);
  console.log(`  corrections proposed:       ${corrections.length}`);
  console.log(`  already marked won in DB:   ${alreadyWon}`);
  console.log(`  already correct as lost:    ${alreadyCorrectLost}`);
  console.log(`  no matching DB outcome:     ${noDbRowEntries.length}`);
  console.log();

  if (noDbRowEntries.length > 0) {
    const byCategory = new Map<string, { count: number; netPnl: number }>();
    let totalMissingPnl = 0;
    for (const e of noDbRowEntries) {
      const agg = byCategory.get(e.category) ?? { count: 0, netPnl: 0 };
      agg.count += 1;
      agg.netPnl += e.netPnl;
      byCategory.set(e.category, agg);
      totalMissingPnl += e.netPnl;
    }
    console.log('--- Winning redeems with no matching DB outcome (untracked wins) ---');
    console.log('These need follow-up: likely our system closed/deleted the');
    console.log('position before the outcome was written, or the position was');
    console.log('entered outside this agent. PR 9 (ongoing PM reconciler) will');
    console.log('insert synthetic outcomes using PM activity data.');
    console.log();
    const fmtSigned = (n: number) =>
      `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
    for (const [cat, agg] of [...byCategory.entries()].sort(
      (a, b) => b[1].netPnl - a[1].netPnl,
    )) {
      console.log(
        `  ${cat.padEnd(20)} ${agg.count} wins, ${fmtSigned(agg.netPnl)}`,
      );
    }
    console.log(
      `  ${'TOTAL'.padEnd(20)} ${noDbRowEntries.length} wins, ${fmtSigned(totalMissingPnl)}`,
    );
    console.log();
    console.log('  Detailed list:');
    for (const e of noDbRowEntries) {
      const qShort = e.question.length > 70 ? e.question.slice(0, 67) + '...' : e.question;
      console.log(
        `    [${e.category}/${e.direction}] net=${fmtSigned(e.netPnl).padStart(8)} redeem=$${e.redeemUsdc.toFixed(2).padStart(6)}  ${qShort}`,
      );
    }
    console.log();
  }

  if (corrections.length > 0) {
    const wins = corrections.filter((c) => c.correctedResult === 'won');
    const losses = corrections.filter((c) => c.correctedResult === 'lost');
    console.log(`Proposed win flips:    ${wins.length}`);
    console.log(`Proposed magnitude fixes (stay lost): ${losses.length}`);
    console.log();

    for (const c of wins) {
      const qShort = c.question.length > 65 ? c.question.slice(0, 62) + '...' : c.question;
      console.log(`  [${c.direction}] "${qShort}"`);
      console.log(
        `     DB before:  ${c.dbResult.padEnd(5)} ${c.dbReturnPct.toFixed(1).padStart(7)}%  exit=${c.dbExitReason ?? '-'}  stake=$${c.dbStakeUsd.toFixed(2)}`,
      );
      console.log(
        `     PM events:  buy=$${c.pmBuyUsdc.toFixed(2)}  sell=$${c.pmSellUsdc.toFixed(2)}  redeem=$${c.pmRedeemUsdc.toFixed(2)}`,
      );
      console.log(
        `     DB after:   won   ${c.correctedReturnPct.toFixed(1).padStart(7)}%  exit=auto_redeemed_win_backfill`,
      );
    }

    if (losses.length > 0) {
      console.log('\n--- Magnitude-only fixes (still lost, return_pct changes) ---');
      for (const c of losses) {
        const qShort = c.question.length > 65 ? c.question.slice(0, 62) + '...' : c.question;
        console.log(
          `  [${c.direction}] "${qShort}" ${c.dbReturnPct.toFixed(1)}% → ${c.correctedReturnPct.toFixed(1)}%`,
        );
      }
    }

    const totalDbPnL = corrections.reduce(
      (a, c) => a + (c.dbReturnPct / 100) * c.dbStakeUsd,
      0,
    );
    const totalRealizedPnL = corrections.reduce(
      (a, c) => a + (c.pmNetProceeds - c.pmBuyUsdc),
      0,
    );
    console.log(`\nTotal DB-recorded P&L on these rows: $${totalDbPnL.toFixed(2)}`);
    console.log(`Total realized P&L per PM:           $${totalRealizedPnL.toFixed(2)}`);
    console.log(`Net correction to P&L accounting:    $${(totalRealizedPnL - totalDbPnL).toFixed(2)}`);
  }

  if (apply && corrections.length > 0) {
    console.log('\n=== APPLYING CORRECTIONS ===');
    let applied = 0;
    for (const c of corrections) {
      await sql`
        UPDATE outcomes
        SET
          result = ${c.correctedResult},
          return_pct = ${c.correctedReturnPct},
          exit_reason = ${c.correctedResult === 'won'
            ? 'auto_redeemed_win_backfill'
            : 'auto_redeemed_loss_backfill'},
          raw = COALESCE(raw, '{}'::jsonb) || ${JSON.stringify({
            backfill_source: 'polymarket_csv',
            backfill_csv_path: csvPath,
            backfill_previous_result: c.dbResult,
            backfill_previous_return_pct: c.dbReturnPct,
            backfill_previous_exit_reason: c.dbExitReason,
            backfill_pm_buy_usdc: c.pmBuyUsdc,
            backfill_pm_sell_usdc: c.pmSellUsdc,
            backfill_pm_redeem_usdc: c.pmRedeemUsdc,
            backfill_applied_at: new Date().toISOString(),
          })}::jsonb
        WHERE outcome_id = ${c.outcomeId}
      `;
      applied++;
    }
    console.log(`Applied ${applied} UPDATEs.`);
    console.log(
      'NOTE: bankroll and calibration stats may be stale; rebuild separately.',
    );
  } else if (corrections.length > 0) {
    console.log('\n(Dry run. Re-run with --apply to commit these UPDATEs.)');
  }

  await closeSql();
}

main().catch(async (err) => {
  console.error(err);
  await closeSql().catch(() => {});
  process.exit(1);
});
