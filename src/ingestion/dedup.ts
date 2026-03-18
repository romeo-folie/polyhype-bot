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
 */
export async function filterSeen(items: RssItem[], redis: Redis): Promise<RssItem[]> {
  if (items.length === 0) return [];

  const newItems: RssItem[] = [];

  for (const item of items) {
    const key = `dedup:${itemKey(item)}`;
    const result = await redis.set(key, '1', 'EX', DEDUP_TTL, 'NX');
    if (result === 'OK') {
      newItems.push(item);
    }
  }

  return newItems;
}
