import { closeRedis, getRedis } from '../src/shared/redis.js';
import { getOpenPositions } from '../src/execution/positionLedger.js';
import { getHyperliquid } from '../src/shared/hyperliquid.js';

function isLedgerFutures(p: Awaited<ReturnType<typeof getOpenPositions>>[number]): boolean {
  return p.isFutures === true || p.executionVenue === 'hyperliquid';
}

function directionFromSize(size: number): 'LONG' | 'SHORT' {
  return size > 0 ? 'LONG' : 'SHORT';
}

function keyFor(symbol: string, direction: 'LONG' | 'SHORT'): string {
  return `${symbol}:${direction}`;
}

async function run(): Promise<void> {
  const redis = getRedis();
  const hl = getHyperliquid();

  try {
    const [ledgerPositions, hlPositions] = await Promise.all([
      getOpenPositions(redis),
      hl.getOpenPositions(),
    ]);

    const ledgerFutures = ledgerPositions.filter(isLedgerFutures);
    const liveHl = hlPositions.filter((p) => Math.abs(parseFloat(p.position.szi)) > 0.0001);

    const ledgerMap = new Map(
      ledgerFutures.map((p) => [keyFor(p.symbol ?? p.marketId, p.direction as 'LONG' | 'SHORT'), p]),
    );
    const hlMap = new Map(
      liveHl.map((p) => {
        const szi = parseFloat(p.position.szi);
        return [keyFor(p.symbol, directionFromSize(szi)), p] as const;
      }),
    );

    const missingInLedger: string[] = [];
    const missingOnHl: string[] = [];
    const entryDrift: string[] = [];

    for (const [key, hlPos] of hlMap) {
      const ledgerPos = ledgerMap.get(key);
      if (!ledgerPos) {
        missingInLedger.push(key);
        continue;
      }
      const hlEntry = parseFloat(hlPos.position.entryPx);
      const driftPct = hlEntry > 0
        ? Math.abs(ledgerPos.entryPrice - hlEntry) / hlEntry * 100
        : 0;
      if (driftPct > 1) {
        entryDrift.push(
          `${key} ledger=${ledgerPos.entryPrice.toFixed(6)} hl=${hlEntry.toFixed(6)} drift=${driftPct.toFixed(2)}%`,
        );
      }
    }

    for (const key of ledgerMap.keys()) {
      if (!hlMap.has(key)) missingOnHl.push(key);
    }

    console.log('Futures Ledger Reconciliation');
    console.log(`Ledger futures: ${ledgerMap.size}`);
    console.log(`Hyperliquid live: ${hlMap.size}`);

    if (missingInLedger.length === 0 && missingOnHl.length === 0 && entryDrift.length === 0) {
      console.log('Status: OK');
      return;
    }

    console.log('Status: MISMATCH');
    if (missingInLedger.length > 0) {
      console.log('\nMissing in ledger:');
      for (const key of missingInLedger) console.log(`- ${key}`);
    }
    if (missingOnHl.length > 0) {
      console.log('\nMissing on Hyperliquid:');
      for (const key of missingOnHl) console.log(`- ${key}`);
    }
    if (entryDrift.length > 0) {
      console.log('\nEntry drift > 1%:');
      for (const line of entryDrift) console.log(`- ${line}`);
    }

    process.exitCode = 1;
  } finally {
    await closeRedis().catch(() => {});
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
