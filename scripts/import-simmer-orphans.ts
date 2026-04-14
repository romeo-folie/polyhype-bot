/**
 * One-shot: import Simmer positions that never made it into our ledger.
 *
 * Why: reconciliation's dust guard + Zod ambiguous-shares drop silently skipped
 * legitimate positions (most sub-$1 and any with both sides held). Phase D fixes
 * those, but existing orphans still need a backfill so the monitor can track
 * them to resolution.
 *
 * Usage:
 *   npx tsx scripts/import-simmer-orphans.ts              # dry-run (default)
 *   npx tsx scripts/import-simmer-orphans.ts --apply      # actually write
 *   npx tsx scripts/import-simmer-orphans.ts --apply --status resolved  # also import resolved
 */
import 'dotenv/config';
import { getRedis, closeRedis } from '../src/shared/redis.js';
import { getSimmerPositions, type SimmerPosition } from '../src/shared/simmer.js';
import { fetchMarketByConditionId, type GammaMarket } from '../src/shared/polymarketGamma.js';
import {
  getPosition,
  recordPosition,
  type Position,
} from '../src/execution/positionLedger.js';

interface Plan {
  status: 'import' | 'skip_already_in_ledger' | 'skip_no_metadata' | 'skip_zero_shares';
  position?: Position;
  source: {
    market_id: string;
    question: string;
    side: string;
    shares: number;
    avg_cost: number | null;
    current_value: number;
    condition_id: string;
  };
  reason?: string;
}

async function buildPlans(
  simmerPositions: SimmerPosition[],
  redis: ReturnType<typeof getRedis>,
): Promise<Plan[]> {
  const plans: Plan[] = [];

  for (const pos of simmerPositions) {
    const source = {
      market_id: pos.market_id,
      question: pos.question ?? '',
      side: pos.side,
      shares: pos.shares ?? 0,
      avg_cost: pos.average_price ?? null,
      current_value: pos.value_usdc ?? 0,
      condition_id: pos.condition_id ?? '',
    };

    if (!pos.shares || pos.shares <= 0) {
      plans.push({ status: 'skip_zero_shares', source, reason: 'shares <= 0' });
      continue;
    }

    if (!pos.condition_id) {
      plans.push({
        status: 'skip_no_metadata',
        source,
        reason: 'missing condition_id',
      });
      continue;
    }

    let metadata: GammaMarket | null = null;
    try {
      metadata = await fetchMarketByConditionId(pos.condition_id);
    } catch (err) {
      plans.push({
        status: 'skip_no_metadata',
        source,
        reason: `gamma error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    if (!metadata) {
      plans.push({
        status: 'skip_no_metadata',
        source,
        reason: 'gamma returned null (market may have resolved and been purged)',
      });
      continue;
    }

    const direction: 'YES' | 'NO' = pos.side === 'yes' ? 'YES' : 'NO';
    const existing = await getPosition(redis, metadata.id, direction);
    if (existing) {
      plans.push({
        status: 'skip_already_in_ledger',
        source,
        reason: `ledger has ${metadata.id}:${direction}`,
      });
      continue;
    }

    const avgPrice = pos.average_price && pos.average_price > 0 ? pos.average_price : 0;
    const stakeUsd = avgPrice > 0 ? pos.shares * avgPrice : pos.value_usdc ?? 0;

    const newPos: Position = {
      marketId: metadata.id,
      conditionId: metadata.conditionId,
      clobTokenIds: metadata.clobTokenIds,
      question: pos.question || metadata.question || 'Backfilled position',
      direction,
      entryPrice: avgPrice,
      stakeUsd,
      sharesHeld: pos.shares,
      openedAt: new Date().toISOString(),
      executionVenue: 'simmer',
      sourcedFrom: 'simmer-orphan-import:2026-04-14',
      edgeMagnitude: 0,
      reconciliationStatus: `imported:${new Date().toISOString()}`,
    };

    plans.push({ status: 'import', source, position: newPos });
  }

  return plans;
}

function fmt(p: Plan): string {
  const s = p.source;
  const short = `${s.market_id.slice(0, 8)} ${s.side.toUpperCase().padEnd(3)} shares=${s.shares.toFixed(4).padStart(8)} avg=${(s.avg_cost ?? 0).toFixed(4)} val=$${s.current_value.toFixed(2).padStart(6)}`;
  const q = s.question.slice(0, 60);
  if (p.status === 'import' && p.position) {
    return `  IMPORT   | ${short} | marketId=${p.position.marketId} | ${q}`;
  }
  return `  ${p.status.padEnd(24)} | ${short} | ${q} | ${p.reason ?? ''}`;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const includeResolved = args.includes('--status=resolved') || args.includes('--resolved');

  const redis = getRedis();
  try {
    console.log(`\n=== Simmer Orphan Import — ${apply ? 'APPLY' : 'DRY RUN'} ===\n`);

    const statuses: ('active' | 'resolved')[] = includeResolved
      ? ['active', 'resolved']
      : ['active'];

    for (const status of statuses) {
      console.log(`\n── Fetching Simmer positions (status=${status}) ──`);
      const simmerPositions = await getSimmerPositions({ status });
      console.log(`  Fetched ${simmerPositions.length.toString()} positions from Simmer\n`);

      const plans = await buildPlans(simmerPositions, redis);

      for (const plan of plans) console.log(fmt(plan));

      const counts = {
        import: plans.filter((p) => p.status === 'import').length,
        already_in_ledger: plans.filter((p) => p.status === 'skip_already_in_ledger').length,
        no_metadata: plans.filter((p) => p.status === 'skip_no_metadata').length,
        zero_shares: plans.filter((p) => p.status === 'skip_zero_shares').length,
      };
      console.log(`\n  Summary (${status}): import=${counts.import.toString()} skip_in_ledger=${counts.already_in_ledger.toString()} skip_no_metadata=${counts.no_metadata.toString()} skip_zero=${counts.zero_shares.toString()}`);

      if (apply) {
        const toImport = plans.filter((p) => p.status === 'import' && p.position);
        console.log(`\n  Applying ${toImport.length.toString()} imports...`);
        for (const p of toImport) {
          if (!p.position) continue;
          try {
            await recordPosition(redis, p.position);
            console.log(`    ✓ ${p.position.marketId}:${p.position.direction}`);
          } catch (err) {
            console.error(`    ✗ ${p.position.marketId}:${p.position.direction} — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    if (!apply) {
      console.log('\n(dry run — no changes written. re-run with --apply to commit)');
    }
  } finally {
    await closeRedis();
  }
}

main().catch((err: unknown) => {
  console.error('Import failed:', err);
  process.exit(1);
});
