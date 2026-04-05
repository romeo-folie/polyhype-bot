/**
 * Verification script: compares Simmer's raw position data against ledger entries.
 *
 * For each active Simmer position, shows:
 *   - Simmer's raw fields (avg_cost, cost_basis, current_value, current_price, average_price)
 *   - Ledger's entryPrice and stakeUsd
 *   - Mismatch flags when ledger entryPrice doesn't match Simmer's avg_cost/average_price
 *
 * Usage: npx tsx scripts/verify-ledger.ts
 */

import { loadConfig } from '../src/shared/config.js';
import { getRedis } from '../src/shared/redis.js';
import { getOpenPositions } from '../src/execution/positionLedger.js';

const SIMMER_BASE_URL = 'https://api.simmer.markets';
const POSITIONS_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/positions`;

interface RawSimmerPosition {
  market_id: string;
  side: string;
  question?: string;
  shares?: number;
  shares_yes?: number;
  shares_no?: number;
  average_price?: number;
  avg_cost?: number;
  cost_basis?: number;
  current_value?: number;
  current_price?: number;
  value_usdc?: number;
  pnl?: number;
  condition_id?: string;
  [key: string]: unknown;
}

async function fetchRawSimmerPositions(): Promise<RawSimmerPosition[]> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();
  const params = new URLSearchParams({ status: 'active', venue: 'polymarket' });

  const resp = await fetch(`${POSITIONS_ENDPOINT}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Simmer API returned HTTP ${resp.status}`);
  }

  const raw = await resp.json() as Record<string, unknown>;
  const arr = Array.isArray(raw) ? raw : ((raw.positions ?? []) as unknown[]);
  return arr as RawSimmerPosition[];
}

function normalize(q: string): string {
  return q?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
}

async function run() {
  const redis = getRedis();

  try {
    const [simmerRaw, ledgerPositions] = await Promise.all([
      fetchRawSimmerPositions(),
      getOpenPositions(redis),
    ]);

    console.log(`\x1b[1mLedger vs Simmer Verification\x1b[0m`);
    console.log(`Simmer positions: ${simmerRaw.length}  |  Ledger positions: ${ledgerPositions.length}`);
    console.log('='.repeat(120));

    // Dump ledger positions for debugging match failures
    console.log(`\n\x1b[1m--- Ledger Dump (Simmer-venue only) ---\x1b[0m`);
    for (const lp of ledgerPositions.filter(p => p.executionVenue === 'simmer')) {
      console.log(`  [${lp.direction}] mktId=${lp.marketId}  entry=${lp.entryPrice}  src=${lp.sourcedFrom}  q="${lp.question.slice(0, 60)}"`);
    }
    console.log('');

    // Build ledger lookup by normalized question + direction
    const ledgerByQuestion = new Map<string, typeof ledgerPositions[number]>();
    for (const lp of ledgerPositions) {
      const key = `${normalize(lp.question)}:${lp.direction}`;
      ledgerByQuestion.set(key, lp);
    }

    // Also build by condition_id
    const ledgerByCondition = new Map<string, typeof ledgerPositions[number]>();
    for (const lp of ledgerPositions) {
      if (lp.conditionId) {
        ledgerByCondition.set(`${lp.conditionId}:${lp.direction}`, lp);
      }
    }

    let mismatches = 0;
    const repairList: {
      marketId: string; direction: string; question: string; shares: number;
      correctEntryPrice: number; oldEntryPrice: number; oldStakeUsd: number;
    }[] = [];

    for (const sp of simmerRaw) {
      // Derive side the same way simmer.ts normalisePosition does
      const yesShares = Number(sp.shares_yes ?? 0);
      const noShares = Number(sp.shares_no ?? 0);
      let direction = (sp.side ?? '').toUpperCase();
      if (!direction) {
        if (yesShares > 0 && noShares <= 0) direction = 'YES';
        else if (noShares > 0 && yesShares <= 0) direction = 'NO';
        else direction = '??';
      }
      const question = sp.question ?? sp.market_id ?? '(unknown)';
      const shares = sp.shares ?? (yesShares || noShares || 0);

      // Find matching ledger entry
      const qKey = `${normalize(question)}:${direction}`;
      let ledger = ledgerByQuestion.get(qKey);
      if (!ledger && sp.condition_id) {
        ledger = ledgerByCondition.get(`${sp.condition_id}:${direction}`);
      }

      // Simmer's entry price fields
      const simmerAvgCost = sp.avg_cost ?? null;
      const simmerAvgPrice = sp.average_price ?? null;
      const simmerCostBasis = sp.cost_basis ?? null;
      const simmerCurrentValue = sp.current_value ?? sp.value_usdc ?? null;
      const simmerCurrentPrice = sp.current_price ?? null;
      const simmerPnl = sp.pnl ?? null;

      // Best entry price from Simmer
      const simmerEntryPrice = simmerAvgCost
        ?? simmerAvgPrice
        ?? (simmerCostBasis && shares > 0 ? simmerCostBasis / shares : null);

      // Simmer's own P&L %
      const simmerCost = simmerCostBasis ?? (simmerEntryPrice && shares > 0 ? simmerEntryPrice * shares : null);
      const simmerPnlPct = simmerCost && simmerCost > 0 && simmerCurrentValue !== null
        ? ((simmerCurrentValue - simmerCost) / simmerCost) * 100
        : null;

      const ledgerEntry = ledger?.entryPrice ?? null;
      const ledgerStake = ledger?.stakeUsd ?? null;
      const ledgerSource = ledger?.sourcedFrom ?? null;

      // Detect mismatch
      const entryMismatch = ledgerEntry !== null && simmerEntryPrice !== null
        ? Math.abs(ledgerEntry - simmerEntryPrice) / Math.max(simmerEntryPrice, 0.001) > 0.05
        : false;

      // Compute ledger P&L for comparison
      const ledgerPnlPct = ledgerEntry && ledgerEntry > 0 && simmerCurrentPrice !== null
        ? (((direction === 'YES' ? simmerCurrentPrice : 1 - simmerCurrentPrice) - ledgerEntry) / ledgerEntry) * 100
        : null;

      const flag = entryMismatch ? '\x1b[31m*** MISMATCH ***\x1b[0m' : '\x1b[32mOK\x1b[0m';
      if (entryMismatch) mismatches++;

      const truncQ = question.length > 60 ? question.slice(0, 57) + '...' : question;

      console.log(`\n${flag}  ${truncQ}  [${direction}]`);
      console.log(`  Simmer raw fields:`);
      console.log(`    avg_cost:       ${simmerAvgCost ?? 'N/A'}`);
      console.log(`    average_price:  ${simmerAvgPrice ?? 'N/A'}`);
      console.log(`    cost_basis:     ${simmerCostBasis ?? 'N/A'}`);
      console.log(`    current_value:  ${simmerCurrentValue ?? 'N/A'}`);
      console.log(`    current_price:  ${simmerCurrentPrice ?? 'N/A'}`);
      console.log(`    shares:         ${shares}`);
      console.log(`    pnl (raw):      ${simmerPnl ?? 'N/A'}`);
      console.log(`    Simmer P&L %:   ${simmerPnlPct !== null ? simmerPnlPct.toFixed(1) + '%' : 'N/A'}`);
      console.log(`  Ledger:`);
      console.log(`    entryPrice:     ${ledgerEntry ?? 'NOT IN LEDGER'}`);
      console.log(`    stakeUsd:       ${ledgerStake ?? 'N/A'}`);
      console.log(`    sourcedFrom:    ${ledgerSource ?? 'N/A'}`);
      console.log(`    Ledger P&L %:   ${ledgerPnlPct !== null ? ledgerPnlPct.toFixed(1) + '%' : 'N/A'}`);

      if (entryMismatch && ledger && simmerEntryPrice) {
        console.log(`  \x1b[31mEntry price divergence: Simmer=${simmerEntryPrice.toFixed(4)} vs Ledger=${ledgerEntry?.toFixed(4)}\x1b[0m`);
        repairList.push({
          marketId: ledger.marketId,
          direction: ledger.direction,
          question: question,
          shares,
          correctEntryPrice: simmerEntryPrice,
          oldEntryPrice: ledgerEntry ?? 0,
          oldStakeUsd: ledgerStake ?? 0,
        });
      } else if (entryMismatch) {
        console.log(`  \x1b[31mEntry price divergence: Simmer=${simmerEntryPrice?.toFixed(4)} vs Ledger=${ledgerEntry?.toFixed(4)}\x1b[0m`);
      }
    }

    // Repair pass: fix mismatched entry prices using Simmer's avg_cost
    const dryRun = !process.argv.includes('--fix');
    if (repairList.length > 0) {
      console.log(`\n\x1b[1m--- Repair Pass (${dryRun ? 'DRY RUN — pass --fix to apply' : 'APPLYING FIXES'}) ---\x1b[0m`);
      for (const repair of repairList) {
        const posKey = `position:${repair.marketId}:${repair.direction}`;
        const newStake = repair.shares * repair.correctEntryPrice;
        console.log(`  ${repair.question.slice(0, 55)}`);
        console.log(`    entryPrice: ${repair.oldEntryPrice} → ${repair.correctEntryPrice}`);
        console.log(`    stakeUsd:   ${repair.oldStakeUsd} → ${newStake.toFixed(6)}`);
        if (!dryRun) {
          await redis.hset(posKey,
            'entryPrice', String(repair.correctEntryPrice),
            'stakeUsd', String(newStake),
            'reconciliationStatus', `repaired_entry:${new Date().toISOString()}`
          );
          console.log(`    \x1b[32mFIXED\x1b[0m`);
        }
      }
    }

    // Check for ledger positions not on Simmer (Simmer-venue only)
    const simmerQuestions = new Set(simmerRaw.map(sp => normalize(sp.question ?? sp.market_id ?? '')));
    const simmerConditions = new Set(simmerRaw.map(sp => sp.condition_id).filter(Boolean));
    for (const lp of ledgerPositions) {
      if (lp.executionVenue !== 'simmer') continue;
      const inSimmer = simmerQuestions.has(normalize(lp.question))
        || (lp.conditionId && simmerConditions.has(lp.conditionId));
      if (!inSimmer) {
        console.log(`\n\x1b[33m*** GHOST ***\x1b[0m  ${lp.question.slice(0, 60)}  [${lp.direction}]`);
        console.log(`  In ledger but NOT found on Simmer (marketId: ${lp.marketId})`);
      }
    }

    console.log('\n' + '='.repeat(120));
    console.log(`Summary: ${simmerRaw.length} Simmer positions checked, ${mismatches} entry price mismatches found`);

  } finally {
    process.exit(0);
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
