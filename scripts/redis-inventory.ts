/**
 * Redis inventory pass — Phase 0 of Epic #142.
 *
 * One-shot diagnostic that buckets the entire Redis keyspace by prefix and
 * reports count + memory + TTL distribution per bucket. Used to baseline
 * Redis composition before the durable analytics layer (Postgres + Timescale)
 * starts offloading data, so we can prove the offload reduced pressure.
 *
 * Outputs:
 *   - JSON snapshot to /tmp/redis-inventory-<epoch>.json
 *   - Human summary table to stdout
 *
 * Usage:
 *   set -a && source .env && set +a && node --import tsx/esm scripts/redis-inventory.ts
 *
 * Notes:
 *   - SCAN with COUNT 1000 to keep latency bounded.
 *   - MEMORY USAGE is sampled 1-in-N for large buckets to avoid hammering CPU
 *     on a multi-thousand-key prefix. Sample size scales with bucket size.
 *   - Prefix derivation: split on ':' and take the first 2 segments
 *     (e.g., 'spot:klines:btcusdt:1m' → 'spot:klines'), with fallback to the
 *     first segment for single-segment keys.
 *   - Specifically tracked prefixes are listed in TRACKED_PREFIXES — anything
 *     matching one of these is bucketed by the full tracked string regardless
 *     of depth. Everything else falls back to the depth-2 derivation.
 */

import { writeFileSync } from 'node:fs';
import { getRedis, closeRedis } from '../src/shared/redis.js';

// Prefixes we explicitly want to track regardless of natural bucket depth.
// Order matters — longest match wins, so list more-specific prefixes first.
const TRACKED_PREFIXES = [
  'metrics:arb_latency',
  'execution:metric',
  'spot:klines',
  'spot:prices',
  'spot:last',
  'watchlist:market_cache',
  'watchlist',
  'calibration',
  'positions:index',
  'position',
  'outcomes',
  'outcome',
  'telemetry',
  'idempotency',
  'dedup',
  'lock',
  'hwm',
  'stale',
  'shadow',
  'cache',
] as const;

interface BucketStats {
  prefix: string;
  count: number;
  sampledKeys: number;
  estimatedBytes: number;       // sum of (per-sample bytes / sample fraction)
  observedSampleBytes: number;  // raw bytes summed across samples
  ttlBuckets: {
    none: number;       // -1 (no expiry)
    pending: number;    // -2 (key gone before TTL read)
    lt1h: number;
    lt1d: number;
    lt7d: number;
    lt30d: number;
    gt30d: number;
  };
}

function freshBucket(prefix: string): BucketStats {
  return {
    prefix,
    count: 0,
    sampledKeys: 0,
    estimatedBytes: 0,
    observedSampleBytes: 0,
    ttlBuckets: { none: 0, pending: 0, lt1h: 0, lt1d: 0, lt7d: 0, lt30d: 0, gt30d: 0 },
  };
}

function bucketKey(key: string): string {
  // First, longest-prefix match against the explicit list — anything in
  // TRACKED_PREFIXES gets bucketed at exactly that depth.
  for (const tracked of TRACKED_PREFIXES) {
    if (key === tracked || key.startsWith(`${tracked}:`)) return tracked;
  }
  // Fallback: depth-1 only. Depth-2 explodes for content-addressed keys
  // (e.g. `relevance:<sha256>`, `scored:<sha256>`, `dedup:<hash>`) where each
  // hash would become its own bucket. Anything that legitimately needs depth-2
  // bucketing should be added to TRACKED_PREFIXES above.
  const firstColon = key.indexOf(':');
  if (firstColon === -1) return key;
  return key.slice(0, firstColon);
}

function classifyTtl(bucket: BucketStats['ttlBuckets'], ttlSec: number): void {
  if (ttlSec === -1) bucket.none++;
  else if (ttlSec === -2) bucket.pending++;
  else if (ttlSec < 3600) bucket.lt1h++;
  else if (ttlSec < 86_400) bucket.lt1d++;
  else if (ttlSec < 7 * 86_400) bucket.lt7d++;
  else if (ttlSec < 30 * 86_400) bucket.lt30d++;
  else bucket.gt30d++;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n.toString()} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

async function main(): Promise<void> {
  const redis = getRedis();
  const startedAt = Date.now();

  // Pre-flight: total dbsize, server version, used_memory.
  const dbsize = (await redis.dbsize());
  const memoryInfoRaw = (await redis.info('memory'));
  const usedMemoryMatch = /^used_memory_human:(.*)$/m.exec(memoryInfoRaw);
  const usedMemory = usedMemoryMatch?.[1]?.trim() ?? 'unknown';
  const peakMemoryMatch = /^used_memory_peak_human:(.*)$/m.exec(memoryInfoRaw);
  const peakMemory = peakMemoryMatch?.[1]?.trim() ?? 'unknown';

  console.log(`=== Redis inventory @ ${new Date().toISOString()} ===`);
  console.log(`DBSIZE: ${fmtCount(dbsize)} keys`);
  console.log(`used_memory_human: ${usedMemory} (peak ${peakMemory})`);
  console.log('');

  const buckets = new Map<string, BucketStats>();

  // Phase 1 — full SCAN to count keys per bucket, no MEMORY USAGE yet
  let cursor = '0';
  let totalSeen = 0;
  do {
    // ioredis returns [cursor, keys[]]
    const [next, keys] = (await redis.scan(cursor, 'COUNT', 1000)) as [string, string[]];
    cursor = next;
    for (const key of keys) {
      const prefix = bucketKey(key);
      let bucket = buckets.get(prefix);
      if (!bucket) {
        bucket = freshBucket(prefix);
        buckets.set(prefix, bucket);
      }
      bucket.count++;
      totalSeen++;
    }
  } while (cursor !== '0');

  console.log(`Phase 1 done: scanned ${fmtCount(totalSeen)} keys into ${buckets.size.toString()} buckets`);
  console.log('Phase 2: sampling MEMORY USAGE + TTL per bucket...');
  console.log('');

  // Phase 2 — for each bucket, sample MEMORY USAGE + TTL
  // Sample fraction: scales inversely with bucket size, capped at min/max.
  // - <100 keys: sample all
  // - 100-1000: sample ~10%
  // - 1000-10000: sample ~1%
  // - >10000: sample ~0.1%, minimum 50 keys
  function sampleSizeFor(count: number): number {
    if (count <= 100) return count;
    if (count <= 1000) return Math.max(50, Math.ceil(count * 0.1));
    if (count <= 10_000) return Math.max(100, Math.ceil(count * 0.01));
    return Math.max(50, Math.ceil(count * 0.001));
  }

  // Re-scan to actually pick samples — we need a second pass because phase 1
  // didn't materialize the keys (they'd blow memory on large keyspaces).
  // For each key, decide stochastically whether to sample based on the bucket's
  // target sample fraction.
  const targetSamples = new Map<string, number>();
  for (const [prefix, bucket] of buckets) {
    targetSamples.set(prefix, sampleSizeFor(bucket.count));
  }

  cursor = '0';
  do {
    const [next, keys] = (await redis.scan(cursor, 'COUNT', 1000)) as [string, string[]];
    cursor = next;
    for (const key of keys) {
      const prefix = bucketKey(key);
      const bucket = buckets.get(prefix);
      if (!bucket) continue;
      const target = targetSamples.get(prefix) ?? 0;
      const remaining = target - bucket.sampledKeys;
      if (remaining <= 0) continue;
      // Probability of sampling = remaining / (count remaining to scan in bucket)
      // Approximation: just use remaining / target * 1.5 (bias slightly to fill quota)
      const prob = Math.min(1, (remaining * 1.5) / Math.max(1, target));
      if (Math.random() > prob) continue;
      try {
        const [memUsage, ttl] = (await Promise.all([
          redis.memory('USAGE', key),
          redis.ttl(key),
        ]));
        if (memUsage !== null && memUsage !== undefined) {
          bucket.observedSampleBytes += memUsage;
          bucket.sampledKeys++;
        }
        classifyTtl(bucket.ttlBuckets, ttl);
      } catch {
        // key vanished mid-scan; skip
      }
    }
  } while (cursor !== '0');

  // Compute estimated total bytes per bucket from samples
  for (const bucket of buckets.values()) {
    if (bucket.sampledKeys === 0) {
      bucket.estimatedBytes = 0;
      continue;
    }
    const avgPerKey = bucket.observedSampleBytes / bucket.sampledKeys;
    bucket.estimatedBytes = Math.round(avgPerKey * bucket.count);
  }

  // Sort by estimated bytes desc for the summary
  const sorted = [...buckets.values()].sort((a, b) => b.estimatedBytes - a.estimatedBytes);

  // Human summary
  console.log('=== TOP BUCKETS BY ESTIMATED MEMORY ===');
  console.log('');
  console.log(
    'PREFIX'.padEnd(28) +
      'COUNT'.padStart(10) +
      'SAMPLED'.padStart(10) +
      'EST BYTES'.padStart(14) +
      'AVG/KEY'.padStart(12) +
      '  TTL DISTRIBUTION (none/<1h/<1d/<7d/<30d/>30d)',
  );
  console.log('-'.repeat(120));

  let totalEstBytes = 0;
  for (const b of sorted) {
    totalEstBytes += b.estimatedBytes;
    const avg = b.sampledKeys > 0 ? b.observedSampleBytes / b.sampledKeys : 0;
    const ttl = b.ttlBuckets;
    const ttlStr = `${ttl.none.toString()}/${ttl.lt1h.toString()}/${ttl.lt1d.toString()}/${ttl.lt7d.toString()}/${ttl.lt30d.toString()}/${ttl.gt30d.toString()}`;
    console.log(
      b.prefix.padEnd(28) +
        fmtCount(b.count).padStart(10) +
        fmtCount(b.sampledKeys).padStart(10) +
        fmtBytes(b.estimatedBytes).padStart(14) +
        fmtBytes(Math.round(avg)).padStart(12) +
        '  ' +
        ttlStr,
    );
  }

  console.log('-'.repeat(120));
  console.log(
    'TOTALS'.padEnd(28) +
      fmtCount(totalSeen).padStart(10) +
      ''.padStart(10) +
      fmtBytes(totalEstBytes).padStart(14),
  );
  console.log('');
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  // JSON snapshot
  const snapshot = {
    capturedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    dbsize,
    usedMemoryHuman: usedMemory,
    peakMemoryHuman: peakMemory,
    buckets: sorted.map((b) => ({
      prefix: b.prefix,
      count: b.count,
      sampledKeys: b.sampledKeys,
      estimatedBytes: b.estimatedBytes,
      observedSampleBytes: b.observedSampleBytes,
      ttlBuckets: b.ttlBuckets,
    })),
  };
  const outPath = `/tmp/redis-inventory-${Math.floor(startedAt / 1000).toString()}.json`;
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`JSON snapshot: ${outPath}`);

  await closeRedis();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
