#!/usr/bin/env tsx
/**
 * Score the weather scanner's bracket predictions against ground truth.
 *
 * Sources predictions from BOTH:
 *   1. shadow_observations rows (kind='weather_bracket') — the SSOT going
 *      forward, populated from 2026-04-15 once the writer was wired.
 *   2. Host weather.log* lines (`[weather] bracket opportunity`) — the only
 *      source for 2026-04-13/14, before shadow_observations was wired. Path
 *      configurable via --logs-dir.
 *
 * For each (city, target_date) with both a prediction and a
 * weather_ground_truth row, scores whether the predicted side won, then prints:
 *   - overall accuracy + by trade side
 *   - calibration table (decile-binned predicted prob vs actual win rate)
 *   - edge-bucketed naive ROI
 *   - α-shrinkage sweep (which `0.5 + α*(p-0.5)` minimizes Brier?)
 *   - per-city accuracy table — flags structural / regional bias
 *
 * Read-only. Safe to run anytime. Intended as a recurring calibration check —
 * re-run weekly as ground truth accumulates and decide on
 * WEATHER_STDDEV_MULTIPLIER / shrinkage tweaks based on stable trends.
 *
 * Usage:
 *   npx tsx scripts/analyze-weather-shadow.ts [--logs-dir DIR] [--no-logs]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSql, closeSql } from '../src/db/client.js';
import { logger } from '../src/shared/logger.js';
import { canonicalCityKey } from '../src/weather/noaaClient.js';

interface BracketOpp {
  city: string;
  targetDate: string;
  bracket: string;
  modelProb: number;
  marketPrice: number;
  edge: number;
  tradeSide: 'YES' | 'NO';
}

interface Args { logsDir: string; useLogs: boolean }

function parseArgs(): Args {
  const args = process.argv.slice(2);
  const out: Args = { logsDir: join(homedir(), 'logs', 'pga'), useLogs: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--logs-dir' && args[i + 1]) { out.logsDir = args[++i]!; continue; }
    if (args[i] === '--no-logs') { out.useLogs = false; continue; }
    if (args[i] === '--help' || args[i] === '-h') {
      // eslint-disable-next-line no-console
      console.log('Usage: analyze-weather-shadow.ts [--logs-dir DIR] [--no-logs]');
      process.exit(0);
    }
  }
  return out;
}

/**
 * Parse Polymarket bracket labels into half-open ranges using half-integer
 * boundaries that match the scanner's probability model — Polymarket rounds
 * observed temperatures to whole degrees, so "40-41°F" effectively covers
 * `[39.5, 41.5)`. See `estimateBracketProbability` in noaaClient.ts:
 *   "39°F or below"  → T <= 39  → (-∞, 39.5)
 *   "40-41°F"        → 40 <= T <= 41 → [39.5, 41.5)
 *   "58°F or higher" → T >= 58 → [57.5, ∞)
 *   "28°C"           → T = 28 → [27.5, 28.5)
 * Mismatching this against the scanner's model would misclassify near-edge
 * outcomes (e.g. 41.4°F observed would land in "40-41" per the model but
 * "42-43" under naive integer bounds).
 */
export function parseBracket(label: string): { lo: number; hi: number } | null {
  const upper = /^(-?\d+(?:\.\d+)?)\s*°[FC]\s*or\s*higher$/i.exec(label);
  if (upper) return { lo: parseFloat(upper[1]!) - 0.5, hi: Infinity };
  const lower = /^(-?\d+(?:\.\d+)?)\s*°[FC]\s*or\s*lower$/i.exec(label);
  if (lower) return { lo: -Infinity, hi: parseFloat(lower[1]!) + 0.5 };
  const range = /^(-?\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\s*°[FC]$/.exec(label);
  if (range) return { lo: parseFloat(range[1]!) - 0.5, hi: parseFloat(range[2]!) + 0.5 };
  const single = /^(-?\d+(?:\.\d+)?)\s*°[FC]$/.exec(label);
  if (single) return { lo: parseFloat(single[1]!) - 0.5, hi: parseFloat(single[1]!) + 0.5 };
  return null;
}

function inBracket(observed: number, label: string): boolean | null {
  const r = parseBracket(label);
  if (!r) return null;
  return observed >= r.lo && observed < r.hi;
}

function loadFromLogs(dir: string): BracketOpp[] {
  if (!existsSync(dir)) {
    logger.warn('[analyze] logs dir not found, skipping', { dir });
    return [];
  }
  const files = readdirSync(dir).filter((f) => /^weather\.log(\.\d+)?$/.test(f));
  const out: BracketOpp[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf-8').split('\n')) {
      if (!line.includes('"[weather] bracket opportunity"')) continue;
      try {
        const r = JSON.parse(line);
        // Canonicalize city before storing — ground truth is keyed on canonical
        // city names ("new york"), but scanner emits raw event titles which can
        // be aliases ("nyc"). Drop rows whose city we don't recognize so they
        // don't pollute per-city stats with phantom keys.
        const canonical = canonicalCityKey(r.city);
        if (!canonical) continue;
        out.push({
          city: canonical,
          targetDate: r.targetDate.slice(0, 10),
          bracket: r.bracket,
          modelProb: parseFloat(r.modelProb),
          marketPrice: parseFloat(r.marketPrice),
          edge: parseFloat(r.edge),
          tradeSide: r.tradeSide,
        });
      } catch { /* malformed — skip */ }
    }
  }
  return out;
}

async function loadFromDb(): Promise<BracketOpp[]> {
  const sql = getSql();
  const rows = await sql<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM shadow_observations
    WHERE kind = 'weather_bracket'
  `;
  const out: BracketOpp[] = [];
  for (const r of rows) {
    const p = r.payload;
    const tradeSide = p.tradeSide === 'NO' ? 'NO' : 'YES';
    const targetDate = typeof p.targetDate === 'string' ? p.targetDate.slice(0, 10) : '';
    if (!targetDate || typeof p.city !== 'string' || typeof p.bracket !== 'string') continue;
    // See loadFromLogs: canonicalize so joins against weather_ground_truth
    // (which stores canonical keys) succeed for aliased city names.
    const canonical = canonicalCityKey(p.city);
    if (!canonical) continue;
    out.push({
      city: canonical,
      targetDate,
      bracket: p.bracket,
      modelProb: Number(p.modelProb),
      marketPrice: Number(p.marketPrice ?? p.outcomePrice),
      edge: Number(p.edge ?? 0),
      tradeSide,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dbOpps = await loadFromDb();
  const logOpps = args.useLogs ? loadFromLogs(args.logsDir) : [];

  // De-dupe by (city, targetDate, bracket, tradeSide) — both sources may emit
  // the same opp on rescans. Last writer wins, so process logs first and DB
  // rows last to prefer DB when both sources contain the same opportunity.
  const seen = new Map<string, BracketOpp>();
  for (const o of [...logOpps, ...dbOpps]) {
    seen.set(`${o.city}|${o.targetDate}|${o.bracket}|${o.tradeSide}`, o);
  }
  const opps = Array.from(seen.values());

  // Pull all ground truth rows (typically <1000) and join in-memory.
  const sql = getSql();
  const gtRows = await sql<{ city: string; target_date: string; observed_high: number; unit: string }[]>`
    SELECT city, target_date::text AS target_date, observed_high, unit FROM weather_ground_truth
  `;
  const gt = new Map<string, number>();
  for (const r of gtRows) gt.set(`${r.city}|${r.target_date}`, r.observed_high);

  type Scored = BracketOpp & { observed: number; inBracket: boolean | null; predictionCorrect: boolean | null };
  const scored: Scored[] = [];
  for (const o of opps) {
    const high = gt.get(`${o.city}|${o.targetDate}`);
    if (high === undefined) continue;
    const inBr = inBracket(high, o.bracket);
    const correct = inBr === null ? null : (o.tradeSide === 'YES' ? inBr : !inBr);
    scored.push({ ...o, observed: high, inBracket: inBr, predictionCorrect: correct });
  }

  // eslint-disable-next-line no-console
  const log = (s: string) => console.log(s);

  log(`Loaded ${dbOpps.length} DB + ${logOpps.length} log bracket opportunities`);
  log(`Joined ${scored.length} of ${opps.length} unique opportunities to ground truth`);
  const parsed = scored.filter((s) => s.inBracket !== null);
  log(`Bracket parser succeeded on ${parsed.length}/${scored.length}`);
  if (parsed.length === 0) {
    log('\nNo joinable rows yet — re-run after the next reconciler tick.');
    await closeSql();
    return;
  }

  // ── Overall ───────────────────────────────────────────────────────────────
  const correct = parsed.filter((s) => s.predictionCorrect === true).length;
  log(`\nOVERALL: ${correct}/${parsed.length} correct = ${(100 * correct / parsed.length).toFixed(1)}%`);
  for (const side of ['YES', 'NO'] as const) {
    const sub = parsed.filter((s) => s.tradeSide === side);
    const c = sub.filter((s) => s.predictionCorrect).length;
    log(`  ${side}: ${c}/${sub.length} correct = ${(100 * c / Math.max(1, sub.length)).toFixed(1)}%`);
  }

  // ── Calibration table ─────────────────────────────────────────────────────
  log(`\nCALIBRATION (predicted prob of side traded vs actual win rate):`);
  log(`  bin       n    avg_pred   actual_win_rate   gap`);
  const bins = Array.from({ length: 10 }, () => ({ n: 0, predSum: 0, wins: 0 }));
  for (const s of parsed) {
    if (s.predictionCorrect === null) continue;
    const predP = s.tradeSide === 'YES' ? s.modelProb : 1 - s.modelProb;
    const idx = Math.min(9, Math.floor(predP * 10));
    bins[idx]!.n++;
    bins[idx]!.predSum += predP;
    if (s.predictionCorrect) bins[idx]!.wins++;
  }
  for (let i = 0; i < bins.length; i++) {
    const b = bins[i]!;
    if (b.n === 0) continue;
    const avgPred = b.predSum / b.n;
    const winRate = b.wins / b.n;
    const gap = winRate - avgPred;
    log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}   ${String(b.n).padStart(3)}    ${avgPred.toFixed(3)}      ${winRate.toFixed(3)}            ${(gap >= 0 ? '+' : '') + gap.toFixed(3)}`);
  }

  // ── Edge buckets (naive ROI) ─────────────────────────────────────────────
  log(`\nEDGE BUCKETS (naive ROI = win_rate / avg_market_price - 1):`);
  log(`  edge_bucket    n    avg_market_price   win_rate   roi_pct`);
  for (const eb of [
    { lo: 0,    hi: 0.1, label: '0.0-0.1' },
    { lo: 0.1,  hi: 0.2, label: '0.1-0.2' },
    { lo: 0.2,  hi: 0.3, label: '0.2-0.3' },
    { lo: 0.3,  hi: 0.5, label: '0.3-0.5' },
    { lo: 0.5,  hi: 1.0, label: '0.5-1.0' },
  ]) {
    const sub = parsed.filter((s) => s.edge >= eb.lo && s.edge < eb.hi);
    if (sub.length === 0) continue;
    const wins = sub.filter((s) => s.predictionCorrect).length;
    const winRate = wins / sub.length;
    const avgPrice = sub.reduce((a, s) => a + s.marketPrice, 0) / sub.length;
    const roi = winRate / avgPrice - 1;
    log(`  ${eb.label}        ${String(sub.length).padStart(3)}    ${avgPrice.toFixed(3)}             ${winRate.toFixed(3)}      ${(roi * 100).toFixed(1)}%`);
  }

  // ── α-shrinkage sweep ─────────────────────────────────────────────────────
  // adjustedYesProb = 0.5 + α*(modelProb - 0.5). Side stays as originally chosen
  // (shrinkage rarely flips edge sign for trades the scanner already accepted).
  // Drop trades whose adjusted side-prob falls below marketPrice — those wouldn't
  // have been taken at this α.
  log(`\nALPHA SWEEP (linear shrinkage):`);
  log(`  α      n_trades  YES_acc   NO_acc   overall  brier    avg_calib_gap`);
  for (const alpha of [1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.5, 0.4]) {
    let yesN = 0, yesWin = 0, noN = 0, noWin = 0, brierSum = 0, brierN = 0;
    const swBins = Array.from({ length: 10 }, () => ({ n: 0, predSum: 0, wins: 0 }));
    for (const s of parsed) {
      if (s.predictionCorrect === null) continue;
      const yesProbAdj = 0.5 + alpha * (s.modelProb - 0.5);
      const sideProbAdj = s.tradeSide === 'YES' ? yesProbAdj : 1 - yesProbAdj;
      if (sideProbAdj <= s.marketPrice) continue;
      const won = s.predictionCorrect ? 1 : 0;
      brierSum += (sideProbAdj - won) ** 2;
      brierN++;
      if (s.tradeSide === 'YES') { yesN++; yesWin += won; }
      else { noN++; noWin += won; }
      const idx = Math.min(9, Math.floor(sideProbAdj * 10));
      swBins[idx]!.n++;
      swBins[idx]!.predSum += sideProbAdj;
      swBins[idx]!.wins += won;
    }
    const totalN = yesN + noN;
    const totalWin = yesWin + noWin;
    let gapSum = 0, gapN = 0;
    for (const b of swBins) {
      if (b.n < 3) continue;
      gapSum += Math.abs(b.wins / b.n - b.predSum / b.n);
      gapN++;
    }
    log(
      `  ${alpha.toFixed(2)}   ${String(totalN).padStart(4)}      ` +
      `${(100 * yesWin / Math.max(1, yesN)).toFixed(1).padStart(5)}%   ` +
      `${(100 * noWin / Math.max(1, noN)).toFixed(1).padStart(5)}%   ` +
      `${(100 * totalWin / Math.max(1, totalN)).toFixed(1).padStart(5)}%   ` +
      `${(brierSum / Math.max(1, brierN)).toFixed(4)}   ` +
      (gapSum / Math.max(1, gapN)).toFixed(3),
    );
  }

  // ── Per-city accuracy ─────────────────────────────────────────────────────
  log(`\nPER-CITY ACCURACY (sorted by overall, min n=4):`);
  log(`  city              n    YES_n  YES_acc   NO_n  NO_acc   overall`);
  const byCity = new Map<string, { n: number; yesN: number; yesWin: number; noN: number; noWin: number }>();
  for (const s of parsed) {
    if (s.predictionCorrect === null) continue;
    if (!byCity.has(s.city)) byCity.set(s.city, { n: 0, yesN: 0, yesWin: 0, noN: 0, noWin: 0 });
    const c = byCity.get(s.city)!;
    c.n++;
    if (s.tradeSide === 'YES') { c.yesN++; if (s.predictionCorrect) c.yesWin++; }
    else { c.noN++; if (s.predictionCorrect) c.noWin++; }
  }
  for (const r of Array.from(byCity.entries())
    .filter(([, v]) => v.n >= 4)
    .map(([city, v]) => ({
      city, n: v.n, yesN: v.yesN, noN: v.noN,
      yesAcc: v.yesN > 0 ? v.yesWin / v.yesN : NaN,
      noAcc: v.noN > 0 ? v.noWin / v.noN : NaN,
      overall: (v.yesWin + v.noWin) / v.n,
    }))
    .sort((a, b) => a.overall - b.overall)) {
    const yAcc = isNaN(r.yesAcc) ? '   -' : `${(100 * r.yesAcc).toFixed(0).padStart(3)}%`;
    const nAcc = isNaN(r.noAcc) ? '   -' : `${(100 * r.noAcc).toFixed(0).padStart(3)}%`;
    log(`  ${r.city.padEnd(15)}  ${String(r.n).padStart(3)}  ${String(r.yesN).padStart(5)}    ${yAcc}  ${String(r.noN).padStart(5)}    ${nAcc}    ${(100 * r.overall).toFixed(1)}%`);
  }

  await closeSql();
}

void main().catch((err: unknown) => {
  logger.error('[analyze] fatal error', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
