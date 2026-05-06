/**
 * Redis-backed deduplication for ingested news items.
 *
 * Uses SHA-256 hash of URL as the dedup key with a 24-hour TTL.
 * Leverages the shared dedup() helper from src/shared/redis.ts.
 */

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { RssItem } from './rss.js';

const DEDUP_TTL = 86_400; // 24 hours

function itemKey(item: RssItem): string {
  return createHash('sha256').update(item.url).digest('hex');
}

/**
 * Filters out items that have already been seen within the TTL window.
 * Marks new items as seen in Redis before returning them.
 *
 * Pass a `namespace` to give a category its own dedup keyspace — useful when
 * two categories share the same RSS feeds and both need to score each item
 * independently (e.g. crypto-regulatory vs crypto-futures).
 */
export async function filterSeen(items: RssItem[], redis: Redis, namespace?: string): Promise<RssItem[]> {
  if (items.length === 0) return [];

  const prefix = namespace ? `dedup:${namespace}:` : 'dedup:';
  const results = await Promise.allSettled(
    items.map((item) => {
      const key = `${prefix}${itemKey(item)}`;
      return redis.set(key, '1', 'EX', DEDUP_TTL, 'NX');
    }),
  );

  return items.filter((_, i) => {
    const r = results[i]!;
    return r.status === 'fulfilled' && r.value === 'OK';
  });
}
