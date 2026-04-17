/**
 * Thin Redis store for recently ingested OSINT items.
 *
 * Scored items flow in-memory through the execution pipeline today; this
 * module writes a lightweight snapshot to `osint:recent_items` so the
 * near-zero NO-side injector cron can read them in a separate process.
 */

import type { Redis } from 'ioredis';
import type { ScoredItem } from './scorer.js';

const RECENT_ITEMS_KEY = 'osint:recent_items';
// 48h — same window as near_zero:osint_signals so signals derived from an
// item and the item itself age out together.
const RECENT_ITEMS_TTL_S = 172_800;

export interface OsintStoredItem {
  title: string;
  keywords: string[];
  urgencyScore: number;
  categoryId: string;
}

/**
 * Persist a batch of high-urgency scored items to the recent-items ZSET.
 * Idempotent: duplicate titles overwrite the score (last-write-wins via zadd).
 * Prunes entries older than TTL on every write.
 */
export async function persistOsintItems(items: ScoredItem[], redis: Redis): Promise<void> {
  if (items.length === 0) return;
  const nowS = Math.floor(Date.now() / 1000);
  const pipeline = redis.pipeline();
  for (const item of items) {
    const member = JSON.stringify({
      title: item.title.slice(0, 300),
      keywords: item.keywords,
      urgencyScore: item.urgencyScore,
      categoryId: item.categoryId,
    } satisfies OsintStoredItem);
    pipeline.zadd(RECENT_ITEMS_KEY, nowS, member);
  }
  pipeline.zremrangebyscore(RECENT_ITEMS_KEY, '-inf', String(nowS - RECENT_ITEMS_TTL_S));
  await pipeline.exec();
}

/**
 * Read recent OSINT items from the last `maxAgeS` seconds.
 * Defaults to 24h so the injector sees a full day of news.
 */
export async function getRecentOsintItems(
  redis: Redis,
  maxAgeS = 86_400,
): Promise<OsintStoredItem[]> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeS;
  const raw = await redis.zrangebyscore(RECENT_ITEMS_KEY, cutoff, '+inf');
  return raw.flatMap((r) => {
    try {
      return [JSON.parse(r) as OsintStoredItem];
    } catch {
      return [];
    }
  });
}
