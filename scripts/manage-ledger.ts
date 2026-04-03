import 'dotenv/config';
import { getRedis, closeRedis } from '../src/shared/redis.js';
import { getOpenPositions, closePosition, type Position } from '../src/execution/positionLedger.js';

async function main() {
  const redis = getRedis();
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const positions = await getOpenPositions(redis);
    if (positions.length === 0) {
      console.log('No open positions.');
    } else {
      console.table(
        positions.map((p) => ({
          marketId: p.marketId,
          direction: p.direction,
          stake: `$${p.stakeUsd.toFixed(2)}`,
          entry: (p.entryPrice * 100).toFixed(1) + '%',
          shares: p.sharesHeld?.toFixed(4) ?? 'N/A',
          venue: p.executionVenue,
          question: p.question.slice(0, 50) + '...',
        })),
      );
    }
  } else if (args[0] === '--remove' && args[1] && args[2]) {
    const marketId = args[1];
    const direction = args[2].toUpperCase() as Position['direction'];
    await closePosition(redis, marketId, direction);
    console.log(`Successfully removed ${marketId}:${direction} from ledger.`);
  } else {
    console.log('Usage:');
    console.log('  npx tsx scripts/manage-ledger.ts --list');
    console.log('  npx tsx scripts/manage-ledger.ts --remove <marketId> <YES|NO|LONG|SHORT>');
  }

  await closeRedis();
}

const isMain =
  process.argv[1]?.endsWith('manage-ledger.ts') || process.argv[1]?.endsWith('manage-ledger.js');
if (isMain) {
  main().catch((err: unknown) => {
    console.error('CLI Error:', err);
    process.exit(1);
  });
}
