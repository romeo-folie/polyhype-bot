import { getRedis, closeRedis } from '../src/shared/redis.js';
import { getPosition } from '../src/execution/positionLedger.js';
import { enqueueWrite } from '../src/db/writeQueue.js';

const marketId = process.argv[2] ?? '2383814';
const direction = (process.argv[3] ?? 'NO') as 'YES' | 'NO';
const endDate = process.argv[4]; // optional: ISO string to patch into position hash

const redis = getRedis();
const key = `position:${marketId}:${direction}`;

const before = await redis.hgetall(key);
console.log('BEFORE:', JSON.stringify({ pendingSettlement: before?.pendingSettlement, endDate: before?.endDate }));

if (!before || Object.keys(before).length === 0) {
  console.error('Position not found in Redis:', key);
  await closeRedis();
  process.exit(1);
}

const patch: Record<string, string> = { pendingSettlement: 'false' };
if (endDate) patch.endDate = endDate;

await redis.hset(key, patch);
console.log('Redis patched:', patch);

const pos = await getPosition(redis, marketId, direction);
if (pos) {
  await enqueueWrite('positions', pos as unknown as Record<string, unknown>);
  console.log('Postgres write queued');
}

const after = await redis.hgetall(key);
console.log('AFTER:', JSON.stringify({ pendingSettlement: after?.pendingSettlement, endDate: after?.endDate }));

await closeRedis();
