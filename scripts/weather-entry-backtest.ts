#!/usr/bin/env tsx
/**
 * Weather ENTRY backtest + cohort analysis.
 *
 * The companion to weather-calibration-audit.ts. Where that script scores model
 * PROBABILITY calibration, this one scores ENTRY DECISIONS by strategy family —
 * the evidence base for cohort admission (PR5) and for the go-live decision in
 * docs/plans/weather-entry-strategy-refinement-2026-06-29.md ("Backtest and
 * audit plan"). It deliberately runs on data we already have so we don't need a
 * fresh forward-shadow window.
 *
 * Data sources (read-only):
 *   - shadow_observations (kind='weather_bracket') — the weather bracket rows the
 *     scanner SURFACED as shadow/opportunity rows. Re-classified into a strategy
 *     family via the PR1 classifier so HISTORICAL rows (which predate the stored
 *     strategyFamily field) are labelled with one consistent definition.
 *     CAVEAT: historical rows are OPPORTUNITY-BIASED — until the full-bracket
 *     snapshot work (PR2) lands, skipped non-opportunity brackets are not all
 *     persisted, so this is NOT a complete census of every bracket considered.
 *     Read the cohort tables as "rows the scanner surfaced", not "all brackets".
 *   - weather_ground_truth — resolved actual highs/lows, used to recompute
 *     win/loss with the resolver's half-open ±0.5° boundary and
 *     COALESCE(resolution, observed) rule.
 *   - outcomes (source='weather') — REAL executed-trade results, the reality
 *     check against shadow EV (shadow EV is priced at the candidate quote, not a
 *     real fill, so it can be optimistic).
 *
 * The pure scoring / family / aggregation logic lives in
 * src/weather/entryBacktest.ts (unit-tested); this file is DB I/O + printing.
 *
 * Usage:
 *   npx tsx scripts/weather-entry-backtest.ts                 # full report
 *   npx tsx scripts/weather-entry-backtest.ts --since 2026-06-01
 *   npx tsx scripts/weather-entry-backtest.ts --tradable-only # only wouldTrade rows
 *   npx tsx scripts/weather-entry-backtest.ts --json out.json # also dump structured
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getSql, closeSql } from '../src/db/client.js';
import { logger } from '../src/shared/logger.js';
import {
  candidateFromShadowPayload,
  candidateKey,
  groupBy,
  winRate,
  avgPrice,
  realizedEdge,
  attributeExecutedByFamily,
  priceBucket,
  distanceBucket,
  edgeBucket,
  type Candidate,
  type GroundTruth,
  type ExecutedRow,
  type Stat,
} from '../src/weather/entryBacktest.js';

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): boolean { return argv.includes(name); }
function opt(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
}
const SINCE = opt('--since');               // ISO date lower bound on observed_at
const TRADABLE_ONLY = flag('--tradable-only'); // restrict to wouldTrade candidates
const JSON_OUT = opt('--json');

// eslint-disable-next-line no-console
const log = (s = ''): void => console.log(s);
function pct(x: number): string { return `${(x * 100).toFixed(1)}%`; }
function signed(x: number): string { return `${x >= 0 ? '+' : ''}${x.toFixed(3)}`; }

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadGroundTruth(): Promise<GroundTruth> {
  const sql = getSql();
  const gtRows = await sql<{
    city: string; target_date: string;
    resolution_high: number | null; observed_high: number | null;
    resolution_low: number | null; observed_low: number | null;
  }[]>`
    SELECT city, target_date::text AS target_date,
           resolution_high, observed_high, resolution_low, observed_low
    FROM weather_ground_truth`;
  const high = new Map<string, number>();
  const low = new Map<string, number>();
  for (const r of gtRows) {
    const k = `${r.city}|${r.target_date}`;
    const h = r.resolution_high ?? r.observed_high;
    const l = r.resolution_low ?? r.observed_low;
    if (h != null) high.set(k, h);
    if (l != null) low.set(k, l);
  }
  return { high, low };
}

/**
 * Load scored weather bracket candidates in two forms:
 *   - `scored`: deduped to the most-recent prediction per (metric, city, date,
 *     bracket, daysOut) — collapses intra-day rescans while preserving each
 *     forecast horizon. Use for cohort win-rate tables (avoids double-counting
 *     correlated intra-day rescans of the same outcome).
 *   - `history`: EVERY scorable row, undeduped, ordered ASC by observed_at. Use
 *     for executed→family attribution, which must see the family AS IT WAS at
 *     each scan (the dedup would collapse an early native_no res-day row onto a
 *     later resday_lockin_no row sharing the same key and mis-attribute a trade
 *     that executed before live confirmation).
 * ORDER BY observed_at ASC makes "last write wins" the most-recent prediction.
 */
async function loadCandidates(gt: GroundTruth): Promise<{ scored: Candidate[]; history: Candidate[] }> {
  const sql = getSql();
  const rows = SINCE
    ? await sql<{ market_id: string | null; payload: Record<string, unknown>; observed_at: string; metric_value: number | null }[]>`
        SELECT market_id, payload, observed_at::text AS observed_at, metric_value
        FROM shadow_observations
        WHERE kind = 'weather_bracket' AND observed_at >= ${SINCE}
        ORDER BY observed_at ASC`
    : await sql<{ market_id: string | null; payload: Record<string, unknown>; observed_at: string; metric_value: number | null }[]>`
        SELECT market_id, payload, observed_at::text AS observed_at, metric_value
        FROM shadow_observations
        WHERE kind = 'weather_bracket'
        ORDER BY observed_at ASC`;
  const dedup = new Map<string, Candidate>();
  const history: Candidate[] = [];
  for (const row of rows) {
    const c = candidateFromShadowPayload(row.market_id ?? '', row.payload, row.metric_value, row.observed_at, gt);
    if (!c) continue;
    history.push(c);
    dedup.set(candidateKey(c), c);
  }
  return { scored: Array.from(dedup.values()), history };
}

async function loadExecuted(): Promise<ExecutedRow[]> {
  const sql = getSql();
  return SINCE
    ? await sql<ExecutedRow[]>`
        SELECT market_id, question, opened_at::text AS opened_at, result::text AS result,
               return_pct, stake_usd, direction::text AS direction
        FROM outcomes
        WHERE source::text = 'weather' AND is_reconciled = false AND opened_at >= ${SINCE}
        ORDER BY opened_at ASC`
    : await sql<ExecutedRow[]>`
        SELECT market_id, question, opened_at::text AS opened_at, result::text AS result,
               return_pct, stake_usd, direction::text AS direction
        FROM outcomes
        WHERE source::text = 'weather' AND is_reconciled = false
        ORDER BY opened_at ASC`;
}

// ── Printing ──────────────────────────────────────────────────────────────────

function printTable(title: string, m: Map<string, Stat>, opts: { minN?: number; sortByEdge?: boolean } = {}): void {
  const minN = opts.minN ?? 1;
  log(`\n## ${title}`);
  log('cohort'.padEnd(42) + 'n'.padStart(7) + 'win%'.padStart(9) + 'avgEntry'.padStart(10) + 'breakeven'.padStart(11) + 'realEdge'.padStart(10));
  const rows = Array.from(m.entries()).filter(([, s]) => s.n >= minN);
  rows.sort((a, b) => opts.sortByEdge ? realizedEdge(a[1]) - realizedEdge(b[1]) : b[1].n - a[1].n);
  for (const [k, s] of rows) {
    log(
      k.slice(0, 42).padEnd(42) +
      String(s.n).padStart(7) +
      pct(winRate(s)).padStart(9) +
      avgPrice(s).toFixed(3).padStart(10) +
      pct(avgPrice(s)).padStart(11) +
      signed(realizedEdge(s)).padStart(10),
    );
  }
  if (rows.length === 0) log(`  (no cohorts with n >= ${String(minN)})`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const gt = await loadGroundTruth();
  const { scored, history } = await loadCandidates(gt);
  const cands = TRADABLE_ONLY ? scored.filter((c) => c.wouldTrade) : scored;

  log('# Weather entry backtest');
  log(`deduped candidates: ${scored.length} (from ${history.length} shadow rows)${SINCE ? ` (since ${SINCE})` : ''}` +
      `  |  wouldTrade: ${scored.filter((c) => c.wouldTrade).length}` +
      `  |  reporting on: ${TRADABLE_ONLY ? 'wouldTrade only' : 'all surfaced shadow/opportunity rows'}`);
  log('CAVEAT: historical weather_bracket rows are opportunity-biased (skipped non-opportunity');
  log('  brackets are not all persisted until PR2). These cohorts cover surfaced rows, not every');
  log('  bracket considered. Executed-by-family below is the ground-truth realized $ check.');

  // 1. Family × side — the headline cohort table.
  printTable('Family × side performance', groupBy(cands, (c) => `${c.family}|${c.side}`), { sortByEdge: true });

  // 1b. wouldTrade cohort isolated (what the live config would actually enter).
  if (!TRADABLE_ONLY) {
    printTable('Family × side — wouldTrade cohort only', groupBy(cands.filter((c) => c.wouldTrade), (c) => `${c.family}|${c.side}`), { sortByEdge: true });
  }

  // 2. Edge monotonicity — the doc's central worry (high edge underperforming).
  printTable('Edge-bucket monotonicity (NO side)', groupBy(cands.filter((c) => c.side === 'NO' && Number.isFinite(c.edge)), (c) => edgeBucket(c.edge)), {});

  // 3. Distance-from-forecast (adjacent vs far NO).
  printTable('NO distance-from-forecast', groupBy(cands.filter((c) => c.side === 'NO'), (c) => distanceBucket(c.distance)), {});

  // 4. Price bucket (break-even sanity — high-priced NO has thin upside).
  printTable('NO price bucket', groupBy(cands.filter((c) => c.side === 'NO'), (c) => priceBucket(c.entryPrice)), {});

  // 5. Source × metric.
  printTable('Source × metric', groupBy(cands, (c) => `${c.source}|${c.metric}`), {});

  // 6. Modal disagreement split.
  printTable('Model-modal vs market-favorite (NO)', groupBy(cands.filter((c) => c.side === 'NO'), (c) => c.modalDisagreement ? 'modal!=favorite' : 'modal=favorite'), {});

  // 7. Executed-trade reality check: shadow EV is priced at the candidate quote;
  //    real fills can be worse. Compare realized $ outcomes to the shadow set.
  const executed = await loadExecuted();
  const exWins = executed.filter((e) => e.result === 'won').length;
  const exLost = executed.filter((e) => e.result === 'lost').length;
  const exPush = executed.filter((e) => e.result === 'pushed').length;
  const exPnl = executed.reduce((acc, e) => acc + e.stake_usd * e.return_pct / 100, 0);
  const exStake = executed.reduce((acc, e) => acc + e.stake_usd, 0);
  log('\n## Executed weather trades (reality check vs shadow EV)');
  log(`  trades=${executed.length}  won=${exWins} lost=${exLost} pushed=${exPush}` +
      `  realizedPnL=$${exPnl.toFixed(2)}  staked=$${exStake.toFixed(2)}` +
      `  ROI=${exStake ? pct(exPnl / exStake) : 'n/a'}`);
  log('  NOTE: shadow "realEdge" above is priced at the candidate quote (mid/ladder bid),');
  log('  not a real fill. Treat shadow EV as an upper bound; this line is the floor.');

  // Executed performance attributed to the family it entered as. The cohorts
  // that lose REAL money to block first.
  log('\n## Executed trades by family (realized $)');
  log('family'.padEnd(24) + 'n'.padStart(6) + 'win%'.padStart(8) + 'pnl$'.padStart(10) + 'stake$'.padStart(10) + 'roi'.padStart(9));
  const byFam = Array.from(attributeExecutedByFamily(executed, history).entries()).sort((a, b) => a[1].pnl - b[1].pnl);
  for (const [fam, s] of byFam) {
    log(
      fam.slice(0, 24).padEnd(24) +
      String(s.n).padStart(6) +
      pct(s.n ? s.won / s.n : NaN).padStart(8) +
      ('$' + s.pnl.toFixed(2)).padStart(10) +
      ('$' + s.stake.toFixed(2)).padStart(10) +
      (s.stake ? pct(s.pnl / s.stake) : 'n/a').padStart(9),
    );
  }

  if (JSON_OUT) {
    const dump = {
      since: SINCE, tradableOnly: TRADABLE_ONLY, scored: scored.length, shadowRows: history.length,
      candidates: cands,
      executed: { trades: executed.length, won: exWins, lost: exLost, pushed: exPush, pnlUsd: exPnl, stakeUsd: exStake },
      executedByFamily: Object.fromEntries(attributeExecutedByFamily(executed, history)),
    };
    writeFileSync(JSON_OUT, JSON.stringify(dump, null, 2) + '\n');
    log(`\nwrote ${JSON_OUT}`);
  }

  await closeSql();
}

void main().catch((err: unknown) => {
  logger.error('[entry-backtest] fatal', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
