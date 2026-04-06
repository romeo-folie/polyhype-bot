/**
 * Trade Analytics — on-demand summary of all recorded outcomes.
 *
 * Usage: set -a && source .env && set +a && npx tsx scripts/trade-analytics.ts
 *
 * Groups outcomes by source, category, venue, and exitReason.
 * Computes win rate, mean/median return, total P&L, holding time stats.
 */

import 'dotenv/config';
import Redis from 'ioredis';
import { loadConfig } from '../src/shared/config.js';

interface OutcomeRow {
  id: string;
  source: string;
  category: string;
  question: string;
  direction: string;
  result: string;
  returnPct: number;
  holdingHours: number;
  executionVenue: string;
  exitReason: string;
  closedAt: string;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

interface GroupStats {
  count: number;
  wins: number;
  losses: number;
  pushed: number;
  winRate: string;
  meanReturn: string;
  medianReturn: string;
  totalReturn: string;
  meanHoldHrs: string;
  medianHoldHrs: string;
  bestTrade: string;
  worstTrade: string;
}

function computeStats(rows: OutcomeRow[]): GroupStats {
  const wins = rows.filter((r) => r.result === 'won').length;
  const losses = rows.filter((r) => r.result === 'lost').length;
  const pushed = rows.filter((r) => r.result === 'pushed').length;
  const returns = rows.map((r) => r.returnPct);
  const holdTimes = rows.map((r) => r.holdingHours);
  const totalReturn = returns.reduce((a, b) => a + b, 0);

  return {
    count: rows.length,
    wins,
    losses,
    pushed,
    winRate: rows.length > 0 ? `${((wins / rows.length) * 100).toFixed(1)}%` : 'N/A',
    meanReturn: rows.length > 0 ? `${(totalReturn / rows.length).toFixed(2)}%` : 'N/A',
    medianReturn: `${median(returns).toFixed(2)}%`,
    totalReturn: `${totalReturn.toFixed(2)}%`,
    meanHoldHrs:
      holdTimes.length > 0
        ? `${(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length).toFixed(1)}h`
        : 'N/A',
    medianHoldHrs: `${median(holdTimes).toFixed(1)}h`,
    bestTrade: returns.length > 0 ? `${Math.max(...returns).toFixed(2)}%` : 'N/A',
    worstTrade: returns.length > 0 ? `${Math.min(...returns).toFixed(2)}%` : 'N/A',
  };
}

function printGroup(label: string, stats: GroupStats) {
  console.log(
    `  ${label.padEnd(22)} ${String(stats.count).padStart(5)}  ${stats.winRate.padStart(7)}  ${stats.meanReturn.padStart(9)}  ${stats.medianReturn.padStart(9)}  ${stats.totalReturn.padStart(10)}  ${stats.meanHoldHrs.padStart(8)}  ${stats.bestTrade.padStart(9)}  ${stats.worstTrade.padStart(9)}`,
  );
}

function printHeader() {
  console.log(
    `  ${'Group'.padEnd(22)} ${'Count'.padStart(5)}  ${'WinRate'.padStart(7)}  ${'MeanRet'.padStart(9)}  ${'MedRet'.padStart(9)}  ${'TotalRet'.padStart(10)}  ${'AvgHold'.padStart(8)}  ${'Best'.padStart(9)}  ${'Worst'.padStart(9)}`,
  );
  console.log('  ' + '-'.repeat(100));
}

async function main() {
  const cfg = loadConfig();
  const redis = new Redis(cfg.REDIS_URL);

  try {
    // Fetch all outcome IDs
    const ids = await redis.zrevrange('outcomes:all', 0, -1);
    if (ids.length === 0) {
      console.log('No recorded outcomes found.');
      return;
    }

    // Fetch all outcomes
    const outcomes: OutcomeRow[] = [];
    for (const id of ids) {
      const data = await redis.hgetall(`outcome:${id}`);
      if (!data.id) continue;
      outcomes.push({
        id: data.id,
        source: data.source ?? 'unknown',
        category: data.category ?? 'unknown',
        question: data.question ?? '',
        direction: data.direction ?? '',
        result: data.result ?? 'unknown',
        returnPct: parseFloat(data.returnPct ?? '0'),
        holdingHours: parseFloat(data.holdingHours ?? '0'),
        executionVenue: data.executionVenue ?? 'unknown',
        exitReason: data.exitReason ?? '',
        closedAt: data.closedAt ?? '',
      });
    }

    console.log(`\n=== Trade Analytics Report ===`);
    console.log(`Total outcomes: ${outcomes.length}\n`);

    // Overall
    console.log('── Overall ──');
    printHeader();
    printGroup('ALL', computeStats(outcomes));
    console.log();

    // By source
    const sources = [...new Set(outcomes.map((o) => o.source))].sort();
    console.log('── By Source ──');
    printHeader();
    for (const source of sources) {
      printGroup(source, computeStats(outcomes.filter((o) => o.source === source)));
    }
    console.log();

    // By category
    const categories = [...new Set(outcomes.map((o) => o.category))].sort();
    console.log('── By Category ──');
    printHeader();
    for (const cat of categories) {
      printGroup(cat, computeStats(outcomes.filter((o) => o.category === cat)));
    }
    console.log();

    // By venue
    const venues = [...new Set(outcomes.map((o) => o.executionVenue))].sort();
    console.log('── By Venue ──');
    printHeader();
    for (const venue of venues) {
      printGroup(venue, computeStats(outcomes.filter((o) => o.executionVenue === venue)));
    }
    console.log();

    // By exit reason (futures only)
    const futuresOutcomes = outcomes.filter((o) => o.source === 'futures');
    if (futuresOutcomes.length > 0) {
      const exitReasons = [...new Set(futuresOutcomes.map((o) => o.exitReason || '(none)'))].sort();
      console.log('── Futures by Exit Reason ──');
      printHeader();
      for (const reason of exitReasons) {
        const label = reason.length > 22 ? reason.substring(0, 20) + '..' : reason;
        printGroup(
          label,
          computeStats(
            futuresOutcomes.filter((o) => (o.exitReason || '(none)') === reason),
          ),
        );
      }
      console.log();
    }

    // By direction (futures)
    if (futuresOutcomes.length > 0) {
      const directions = [...new Set(futuresOutcomes.map((o) => o.direction))].sort();
      console.log('── Futures by Direction ──');
      printHeader();
      for (const dir of directions) {
        printGroup(dir, computeStats(futuresOutcomes.filter((o) => o.direction === dir)));
      }
      console.log();
    }
  } finally {
    await redis.quit();
  }
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
