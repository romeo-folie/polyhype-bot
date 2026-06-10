#!/usr/bin/env tsx
/**
 * Backtest the conditional weather oracle against the May–Jun 2026 cohort of
 * closed weather positions.
 *
 * Usage:
 *   npx tsx scripts/backtest-cond-oracle.ts [--since 2026-05-01] [--city chicago]
 *
 * Data sources:
 *   DB  — positions + weather_ground_truth (already on disk)
 *   ERA5 hourly archive (Open-Meteo archive API) — used as running-max proxy
 *   Climo exceedance table (src/weather/data/climoExceedance.json)
 *
 * Since historical GFS ensemble forecasts are not available from Open-Meteo,
 * the oracle falls back to the climo estimator for every evaluation. Run AFTER
 * scripts/build-climo-exceedance.ts has populated the climo table.
 *
 * Phase A gates addressed:
 *   A.2  Brier calibration — oracle Brier ≤ market-bid Brier
 *   A.3  Counterfactual PnL — 3-policy comparison (hold / #470 drops / oracle exit)
 *   A.5  Dead-at-20% recovery rate
 *   A.7  Estimator coverage and clamp rate
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import pg from 'pg';
import { lookupCity } from '../src/weather/noaaClient.js';
import { parseBracketLabel } from '../src/weather/weatherScanner.js';
import { conditionalHeldProbability, loadClimoTable, type ClimoExceedanceTable } from '../src/weather/conditionalOracle.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const sinceArg = args[args.indexOf('--since') + 1] ?? '2026-02-01';
const cityFilter = args.indexOf('--city') >= 0 ? args[args.indexOf('--city') + 1] : null;

// ── Config ────────────────────────────────────────────────────────────────────
const EXIT_COST_BUFFER = 0.05;   // mirrors WEATHER_COND_ORACLE_EXIT_COST_BUFFER default
const TIER2_DROP_THRESH = 0.20;  // #470 Tier 2: exit if bid ≤ entryPrice * (1 - 0.20)
// In backtest mode we use a large maxObsAgeMin so historical observations are never
// marked stale — we're reconstructing what the oracle WOULD have said, not acting live.
const MAX_OBS_AGE_MIN = 365 * 24 * 60;
const MIN_MEMBERS = 10;
const ESTIMATOR_MAX_GAP = 0.25;
const SCAN_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const ERA5_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const RATE_LIMIT_MS = 600; // ms between ERA5 archive API calls

// ── DB connection ─────────────────────────────────────────────────────────────
// Load .env for local runs (containers have PG_URL injected via docker compose).
if (!process.env.PG_URL) {
  try {
    const envFile = readFileSync(resolve('.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]!.trim();
    }
  } catch { /* no .env */ }
}
const pool = new pg.Pool({ connectionString: process.env.PG_URL });

// ── Climo table ───────────────────────────────────────────────────────────────
const climoTable: ClimoExceedanceTable | null = loadClimoTable();

// ── Types ─────────────────────────────────────────────────────────────────────
interface PositionRow {
  id: number;
  marketId: string;
  direction: 'YES' | 'NO';
  entryPrice: number;
  stakeUsd: number;
  openedAt: Date;
  bracketLabel: string;
  city: string;
  targetDate: string;
  resolutionHigh: number | null;
}

interface ScanPoint {
  localHour: number;
  runningMax: number;
  conditionalP: number | null;
  isStale: boolean;
  estimator: string | null;
  clampedByClimo: boolean;
}

interface PositionResult {
  pos: PositionRow;
  outcome: 'win' | 'loss' | 'unknown';
  scans: ScanPoint[];
  policyA_pnl: number;    // hold to resolution
  policyB_exitHour: number | null;   // first hour Tier2 drop triggers
  policyB_pnl: number;
  policyC_exitHour: number | null;   // first hour oracle says exit
  policyC_pnl: number;
  sharesHeld: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function determinOutcome(
  resolutionHigh: number,
  bracket: { low: number | null; high: number | null },
  direction: 'YES' | 'NO',
): 'win' | 'loss' {
  const HALF = 0.5;
  let yesWins: boolean;
  if (bracket.low === null && bracket.high !== null) {
    // LOW_TAIL: YES wins if high ≤ threshold + 0.5
    yesWins = resolutionHigh <= bracket.high + HALF;
  } else if (bracket.high === null && bracket.low !== null) {
    // HIGH_TAIL: YES wins if high ≥ threshold - 0.5
    yesWins = resolutionHigh >= bracket.low - HALF;
  } else if (bracket.low !== null && bracket.high !== null) {
    // INTERIOR (incl. single celsius): YES wins if in [low-0.5, high+0.5]
    yesWins = resolutionHigh >= bracket.low - HALF && resolutionHigh <= bracket.high + HALF;
  } else {
    return 'loss'; // degenerate
  }
  const heldSideWins = direction === 'YES' ? yesWins : !yesWins;
  return heldSideWins ? 'win' : 'loss';
}

async function fetchEra5Hourly(
  lat: number, lon: number, date: string, unit: 'fahrenheit' | 'celsius',
): Promise<{ timeS: number[]; temps: number[] } | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m',
    temperature_unit: unit,
    timezone: 'auto',
    timeformat: 'unixtime',
    start_date: date,
    end_date: date,
  });
  try {
    const res = await fetch(`${ERA5_BASE}?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json() as { hourly?: { time?: number[]; temperature_2m?: number[] } };
    const timeS = data.hourly?.time;
    const temps = data.hourly?.temperature_2m;
    if (!Array.isArray(timeS) || !Array.isArray(temps) || timeS.length === 0) return null;
    return { timeS, temps };
  } catch {
    return null;
  }
}

function localHourFromEpochS(epochS: number, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', hour12: false });
    const parts = fmt.formatToParts(new Date(epochS * 1000));
    const h = parts.find(p => p.type === 'hour');
    return h ? parseInt(h.value, 10) : 0;
  } catch { return 0; }
}

function estimateExitPrice(conditionalP: number): number {
  // Conservative: sell at conditionalP minus half the buffer (maker)
  return Math.max(conditionalP - EXIT_COST_BUFFER / 2, 0.01);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Conditional Oracle Backtest ===');
  console.log(`Since: ${sinceArg}${cityFilter ? ` | City filter: ${cityFilter}` : ''}`);
  const climoCities = climoTable ? Object.keys(climoTable) : [];
  console.log(`Climo table: ${climoTable ? `loaded (${climoCities.length} cities: ${climoCities.join(', ')})` : 'EMPTY — oracle will return null for all positions'}`);
  if (!climoTable) {
    console.warn('WARNING: climo table is empty. Run scripts/build-climo-exceedance.ts first.');
    console.warn('Continuing in coverage-only mode (Gates A.5 / A.7 partial).\n');
  }

  // ── 1. Load closed weather positions with ground truth ──────────────────────
  const client = await pool.connect();
  let rows: PositionRow[];
  try {
    const { rows: raw } = await client.query<{
      id: number; market_id: string; direction: string; entry_price: string;
      stake_usd: string; opened_at: Date; sourced_from: string; resolution_high: string | null;
    }>(`
      SELECT p.id, p.market_id, p.direction, p.entry_price, p.stake_usd, p.opened_at,
             p.sourced_from,
             gt.resolution_high
      FROM positions p
      JOIN weather_ground_truth gt
        ON trim(split_part(p.sourced_from, ':', 2)) = gt.city
        AND split_part(p.sourced_from, ':', 3)::date = gt.target_date
      WHERE p.sourced_from LIKE 'weather:%'
        AND p.closed_at IS NOT NULL
        AND gt.resolution_high IS NOT NULL
        AND p.opened_at >= $1
        ${cityFilter ? `AND trim(split_part(p.sourced_from, ':', 2)) = $2` : ''}
      ORDER BY p.opened_at
    `, cityFilter ? [sinceArg, cityFilter] : [sinceArg]);

    rows = raw
      .map(r => ({
        id: r.id,
        marketId: r.market_id,
        direction: r.direction as 'YES' | 'NO',
        entryPrice: parseFloat(r.entry_price),
        stakeUsd: parseFloat(r.stake_usd),
        openedAt: r.opened_at,
        bracketLabel: r.sourced_from.split(':').slice(3).join(':'),
        city: r.sourced_from.split(':')[1].trim(),
        targetDate: r.sourced_from.split(':')[2].trim(),
        resolutionHigh: r.resolution_high !== null ? parseFloat(r.resolution_high) : null,
      }))
      .filter(r => isFinite(r.entryPrice) && r.entryPrice > 0 && isFinite(r.stakeUsd) && r.stakeUsd > 0);
  } finally {
    client.release();
  }

  console.log(`\nLoaded ${rows.length} positions with ground truth.`);
  if (rows.length === 0) { await pool.end(); return; }

  // ── 2. Group by (city, targetDate) to batch ERA5 fetches ───────────────────
  const cityDateMap = new Map<string, PositionRow[]>();
  for (const row of rows) {
    const key = `${row.city}|${row.targetDate}`;
    if (!cityDateMap.has(key)) cityDateMap.set(key, []);
    cityDateMap.get(key)!.push(row);
  }
  console.log(`City-date groups: ${cityDateMap.size}`);

  // ── 3. Per-group: fetch ERA5, simulate hourly scans ─────────────────────────
  const results: PositionResult[] = [];
  let era5Fetched = 0, era5Failed = 0;
  let groupIdx = 0;

  for (const [key, groupPositions] of cityDateMap.entries()) {
    groupIdx++;
    const [city, targetDate] = key.split('|');
    const cityCoords = lookupCity(city);

    if (!cityCoords) {
      console.log(`  [${groupIdx}/${cityDateMap.size}] ${city} ${targetDate} — unknown city, skipping`);
      for (const pos of groupPositions) {
        const bracket = parseBracketLabel(pos.bracketLabel);
        const outcome = (bracket && pos.resolutionHigh !== null)
          ? determinOutcome(pos.resolutionHigh, bracket, pos.direction) : 'unknown';
        const sharesHeld = pos.stakeUsd / pos.entryPrice;
        results.push({ pos, outcome, scans: [], policyA_pnl: policyAPnl(outcome, pos.entryPrice, sharesHeld), policyB_exitHour: null, policyB_pnl: policyAPnl(outcome, pos.entryPrice, sharesHeld), policyC_exitHour: null, policyC_pnl: policyAPnl(outcome, pos.entryPrice, sharesHeld), sharesHeld });
      }
      continue;
    }

    await sleep(RATE_LIMIT_MS);
    const era5 = await fetchEra5Hourly(cityCoords.lat, cityCoords.lon, targetDate, cityCoords.unit);
    if (!era5) {
      era5Failed++;
      console.log(`  [${groupIdx}/${cityDateMap.size}] ${city} ${targetDate} — ERA5 fetch failed`);
    } else {
      era5Fetched++;
    }

    for (const pos of groupPositions) {
      const bracket = parseBracketLabel(pos.bracketLabel);
      if (!bracket) {
        console.log(`    skipping pos ${pos.id}: unparseable bracket "${pos.bracketLabel}"`);
        continue;
      }
      const outcome = pos.resolutionHigh !== null
        ? determinOutcome(pos.resolutionHigh, bracket, pos.direction) : 'unknown';
      const sharesHeld = pos.stakeUsd / pos.entryPrice;

      // Build hourly scan points
      const scans: ScanPoint[] = [];
      let policyB_exitHour: number | null = null;
      let policyB_pnl = policyAPnl(outcome, pos.entryPrice, sharesHeld);
      let policyC_exitHour: number | null = null;
      let policyC_pnl = policyAPnl(outcome, pos.entryPrice, sharesHeld);

      if (era5) {
        const { timeS, temps } = era5;
        for (const localHour of SCAN_HOURS) {
          // Find the ERA5 index corresponding to this local hour
          const hIdx = timeS.findIndex(t => localHourFromEpochS(t, cityCoords.tz) === localHour);
          if (hIdx < 0) continue;

          // Running max = max of all hourly temps up to and including this index
          const runningMax = Math.max(...temps.slice(0, hIdx + 1).filter(v => isFinite(v)));
          if (!isFinite(runningMax)) continue;

          // observedAt = the ERA5 timestamp for this local hour
          const observedAtMs = timeS[hIdx] * 1000;
          const observedAt = new Date(observedAtMs).toISOString();

          const oracleResult = climoTable ? conditionalHeldProbability({
            city,
            direction: pos.direction,
            bracket: { low: bracket.low, high: bracket.high },
            observedMax: runningMax,
            observedAt,
            tz: cityCoords.tz,
            remainingHourlyMembers: null, // no historical ensemble
            climoTable,
            biasCorrection: 0,
            spreadInflation: 1.0,
            minMembers: MIN_MEMBERS,
            maxObsAgeMin: MAX_OBS_AGE_MIN,
            estimatorMaxGap: ESTIMATOR_MAX_GAP,
          }) : null;

          scans.push({
            localHour,
            runningMax,
            conditionalP: oracleResult?.heldProb ?? null,
            isStale: oracleResult?.isStale ?? false,
            estimator: oracleResult?.estimator ?? null,
            clampedByClimo: oracleResult?.clampedByClimo ?? false,
          });

          // Policy B: exit on Tier2 drop (conditionalP proxy for bid movement)
          if (policyB_exitHour === null && oracleResult && !oracleResult.isStale) {
            if (oracleResult.heldProb <= pos.entryPrice * (1 - TIER2_DROP_THRESH)) {
              policyB_exitHour = localHour;
              policyB_pnl = (sharesHeld * estimateExitPrice(oracleResult.heldProb)) - pos.stakeUsd;
            }
          }

          // Policy C: oracle exit (heldProb < entryPrice - buffer)
          if (policyC_exitHour === null && oracleResult && !oracleResult.isStale) {
            if (oracleResult.heldProb < pos.entryPrice - EXIT_COST_BUFFER) {
              policyC_exitHour = localHour;
              policyC_pnl = (sharesHeld * estimateExitPrice(oracleResult.heldProb)) - pos.stakeUsd;
            }
          }
        }
      }

      results.push({
        pos, outcome, scans,
        policyA_pnl: policyAPnl(outcome, pos.entryPrice, sharesHeld),
        policyB_exitHour, policyB_pnl,
        policyC_exitHour, policyC_pnl,
        sharesHeld,
      });
    }

    if (groupIdx % 10 === 0) {
      process.stdout.write(`  processed ${groupIdx}/${cityDateMap.size} city-dates...\r`);
    }
  }
  console.log(`\nERA5: fetched=${era5Fetched}, failed=${era5Failed}`);

  // ── 4. Compute metrics ───────────────────────────────────────────────────────
  const known = results.filter(r => r.outcome !== 'unknown');
  const wins = known.filter(r => r.outcome === 'win').length;

  console.log(`\n--- Position Outcomes ---`);
  console.log(`Total:   ${results.length}  (known: ${known.length})`);
  console.log(`Wins:    ${wins}  (${pct(wins, known.length)})`);
  console.log(`Losses:  ${known.length - wins}  (${pct(known.length - wins, known.length)})`);

  // A.2 — Brier score (proxy: entry_price as market baseline, not live bid at scan time)
  // NOTE: this is a PROXY metric. The real Gate A.2 verdict uses live Phase A shadow rows
  // where currentHeldBid is recorded at each scan. Entry price is adverse-selection-biased
  // on cap-clamped fills and does not match the doc's "market bid at the same timestamps."
  console.log(`\n--- Proxy A.2 (entry-price baseline — NOT the live gate): Brier Calibration ---`);
  const brierPoints: Array<{ pred: number; actual: number }> = [];
  const marketBrierPoints: Array<{ pred: number; actual: number }> = [];
  for (const r of known) {
    const actualOutcome = r.outcome === 'win' ? 1 : 0;
    for (const scan of r.scans) {
      if (scan.conditionalP !== null && !scan.isStale) {
        brierPoints.push({ pred: scan.conditionalP, actual: actualOutcome });
      }
    }
    marketBrierPoints.push({ pred: r.pos.entryPrice, actual: actualOutcome });
  }
  const oracleBrier = brierScore(brierPoints);
  const marketBrier = brierScore(marketBrierPoints);
  const naiveBrier = 0.25; // always-0.5 baseline
  console.log(`Oracle (climo) Brier:              ${fmt3(oracleBrier)} (${brierPoints.length} scan points)`);
  console.log(`Market-bid proxy Brier (entryPrice): ${fmt3(marketBrier)} (${marketBrierPoints.length} positions)`);
  console.log(`Naive 0.5 baseline Brier:            ${fmt3(naiveBrier)}`);
  if (brierPoints.length > 0) {
    const verdict = oracleBrier <= marketBrier ? '✅ PROXY PASS (oracle ≤ entry-price proxy)' : '❌ PROXY FAIL (oracle > entry-price proxy)';
    console.log(`Proxy A.2: ${verdict}`);
  } else {
    console.log(`Proxy A.2: ⚠️  SKIP — no oracle scan points (climo table empty?)`);
  }

  // A.3 — Counterfactual PnL (proxy: oracle heldProb as both exit trigger and exit price proxy)
  // NOTE: this is a PROXY metric. Both Policy B trigger (heldProb ≤ entry×0.8) and Policy C
  // exit price (estimateExitPrice(heldProb)) use the oracle's own beliefs. If the oracle is
  // miscalibrated the simulation pays itself fantasy prices. Real Gate A.3 uses live shadow
  // rows where currentHeldBid is the actual market bid, not the oracle's estimate.
  console.log(`\n--- Proxy A.3 (oracle-heldProb as bid proxy — NOT the live gate): Counterfactual PnL ---`);
  const policyA = sumPnl(results, r => r.policyA_pnl);
  const policyB_exits = results.filter(r => r.policyB_exitHour !== null).length;
  const policyB = sumPnl(results, r => r.policyB_pnl);
  const policyC_exits = results.filter(r => r.policyC_exitHour !== null).length;
  const policyC = sumPnl(results, r => r.policyC_pnl);

  console.log(`Policy A (hold all):                  ${fmtPnl(policyA)}`);
  console.log(`Policy B (#470 Tier2 drops, n=${policyB_exits}):   ${fmtPnl(policyB)}`);
  console.log(`Policy C (oracle exit rule, n=${policyC_exits}):    ${fmtPnl(policyC)}`);
  console.log(`C vs B incremental:                   ${fmtPnl(policyC - policyB)}`);
  if (policyC_exits > 0) {
    const cOverB = policyC - policyB;
    const verdict = cOverB > 0 ? '✅ PROXY PASS (C saves over B)' : '❌ PROXY FAIL (C worse than B)';
    console.log(`Proxy A.3: ${verdict}`);
  } else {
    console.log(`Proxy A.3: ⚠️  SKIP — oracle issued 0 exits (climo table empty?)`);
  }

  // Quality of oracle exits: what fraction of C-exited positions were losses?
  if (policyC_exits > 0) {
    const cExited = results.filter(r => r.policyC_exitHour !== null && r.outcome !== 'unknown');
    const cExitedLosses = cExited.filter(r => r.outcome === 'loss').length;
    console.log(`  Oracle-exited positions: ${cExited.length}  (${cExitedLosses} were losses = ${pct(cExitedLosses, cExited.length)} correct)`);
  }

  // A.5 — Dead-at-20% recovery (proxy: same oracle-heldProb caveat as A.3)
  console.log(`\n--- Proxy A.5 (oracle-heldProb proxy — NOT the live gate): Dead-at-20% Recovery Rate ---`);
  const dropped20 = results.filter(r => {
    return r.scans.some(s => s.conditionalP !== null && !s.isStale &&
      s.conditionalP <= r.pos.entryPrice * (1 - TIER2_DROP_THRESH));
  });
  const dropped20Known = dropped20.filter(r => r.outcome !== 'unknown');
  const dropped20Wins = dropped20Known.filter(r => r.outcome === 'win').length;
  console.log(`Positions where oracle P dropped below entry-20%: ${dropped20.length}`);
  if (dropped20Known.length > 0) {
    console.log(`Of those, fraction that won: ${dropped20Wins}/${dropped20Known.length} = ${pct(dropped20Wins, dropped20Known.length)}`);
    const verdict = (dropped20Wins / dropped20Known.length) < 0.10
      ? '✅ PROXY PASS (<10% recover — Tier2 stays un-vetoable)'
      : '⚠️  PROXY REVIEW (>10% recover — check Tier2 veto table)';
    console.log(`Proxy A.5: ${verdict}`);
  } else {
    console.log(`Proxy A.5: ⚠️  SKIP — no oracle P drops observed`);
  }

  // A.7 — Estimator statistics
  console.log(`\n--- Gate A.7: Estimator Statistics ---`);
  const allScans = results.flatMap(r => r.scans);
  const nonNullScans = allScans.filter(s => s.conditionalP !== null);
  const climoScans = nonNullScans.filter(s => s.estimator === 'climo');
  const ensembleScans = nonNullScans.filter(s => s.estimator === 'ensemble');
  const clampedScans = nonNullScans.filter(s => s.clampedByClimo);
  const coverage = allScans.length > 0 ? nonNullScans.length / allScans.length : 0;
  console.log(`Total scan points:    ${allScans.length}`);
  console.log(`Non-null oracle:      ${nonNullScans.length} (coverage ${pct(nonNullScans.length, allScans.length)})`);
  console.log(`  Climo estimator:    ${climoScans.length}`);
  console.log(`  Ensemble estimator: ${ensembleScans.length} (0 expected — no historical ensemble)`);
  console.log(`  Clamped by climo:   ${clampedScans.length} (${pct(clampedScans.length, nonNullScans.length)} of non-null)`);
  const coverageVerdict = coverage >= 0.8 ? '✅ PASS (≥80%)' : `⚠️  ${(coverage * 100).toFixed(0)}% — needs WU/HKO live obs for live coverage`;
  console.log(`Gate A.7 coverage: ${coverageVerdict}`);

  // Per-city breakdown
  console.log(`\n--- Per-City Breakdown ---`);
  const byCityMap = new Map<string, PositionResult[]>();
  for (const r of results) {
    if (!byCityMap.has(r.pos.city)) byCityMap.set(r.pos.city, []);
    byCityMap.get(r.pos.city)!.push(r);
  }
  const cityRows: string[] = [];
  for (const [city, cityResults] of [...byCityMap.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const k = cityResults.filter(r => r.outcome !== 'unknown');
    const w = k.filter(r => r.outcome === 'win').length;
    const c_exits = cityResults.filter(r => r.policyC_exitHour !== null).length;
    cityRows.push(`  ${city.padEnd(18)} n=${String(k.length).padStart(3)}  W=${String(w).padStart(3)} (${pct(w,k.length).padStart(6)})  oracle_exits=${String(c_exits).padStart(3)}  pnl_A=${fmtPnl(sumPnl(cityResults, r => r.policyA_pnl))}  pnl_C=${fmtPnl(sumPnl(cityResults, r => r.policyC_pnl))}`);
  }
  cityRows.forEach(r => console.log(r));

  // Reliability curve (Brier bucketing)
  if (brierPoints.length > 0) {
    console.log(`\n--- Reliability Curve (oracle calibration) ---`);
    const buckets: Array<{lo: number; hi: number; preds: number[]; actuals: number[]}> = [
      {lo:0.0,hi:0.2,preds:[],actuals:[]}, {lo:0.2,hi:0.4,preds:[],actuals:[]},
      {lo:0.4,hi:0.6,preds:[],actuals:[]}, {lo:0.6,hi:0.8,preds:[],actuals:[]},
      {lo:0.8,hi:1.0,preds:[],actuals:[]},
    ];
    for (const {pred, actual} of brierPoints) {
      const b = buckets.find(bk => pred >= bk.lo && pred < bk.hi) ?? buckets[buckets.length - 1];
      b.preds.push(pred); b.actuals.push(actual);
    }
    for (const b of buckets) {
      if (b.preds.length === 0) continue;
      const meanPred = b.preds.reduce((s, v) => s + v, 0) / b.preds.length;
      const meanActual = b.actuals.reduce((s, v) => s + v, 0) / b.actuals.length;
      const bar = '█'.repeat(Math.round(meanActual * 20));
      console.log(`  [${b.lo.toFixed(1)}-${b.hi.toFixed(1)}] n=${String(b.preds.length).padStart(4)}  pred=${fmt3(meanPred)}  actual=${fmt3(meanActual)}  ${bar}`);
    }
  }

  await pool.end();
  console.log('\n--- NOTE ---');
  console.log('Proxy A.2/A.3/A.5 above use oracle heldProb as a bid proxy and entry_price as');
  console.log('the market baseline. These are useful for direction-of-effect checks only.');
  console.log('Real Gate A.2/A.3/A.5 verdicts require live Phase A shadow rows where');
  console.log('currentHeldBid is recorded at each scan. Query weather_cond_oracle table once');
  console.log('sufficient shadow data has accumulated.');
  console.log('\nDone.');
}

// ── Utility ───────────────────────────────────────────────────────────────────

function policyAPnl(outcome: string, entryPrice: number, shares: number): number {
  if (outcome === 'win') return shares * (1 - entryPrice); // net gain
  if (outcome === 'loss') return -shares * entryPrice;     // net loss
  return 0;
}

function brierScore(points: Array<{ pred: number; actual: number }>): number {
  if (points.length === 0) return NaN;
  return points.reduce((s, p) => s + (p.pred - p.actual) ** 2, 0) / points.length;
}

function sumPnl(results: PositionResult[], getter: (r: PositionResult) => number): number {
  return results.reduce((s, r) => s + getter(r), 0);
}

function fmt3(n: number): string { return isNaN(n) ? 'N/A' : n.toFixed(3); }
function fmtPnl(n: number): string { return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`; }
function pct(n: number, d: number): string { return d === 0 ? 'N/A' : `${(100 * n / d).toFixed(1)}%`; }

main().catch(err => { console.error(err); process.exit(1); });
