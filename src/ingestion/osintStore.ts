/**
 * Thin Redis store for recently ingested OSINT items.
 *
 * Scored items flow in-memory through the execution pipeline today; this
 * module writes a lightweight snapshot so the near-zero NO-side injector
 * cron can read them in a separate process.
 *
 * Storage layout (two structures for true idempotency):
 *   osint:recent_item_scores  — ZSET: member = title hash, score = unix seconds
 *   osint:item:{hash}         — STRING: JSON payload, EX = RECENT_ITEMS_TTL_S
 *
 * ZADD with the title hash as member means re-scoring the same article
 * updates the score (last-write-wins) instead of accumulating duplicate
 * members that differ only in urgencyScore or keywords.
 */

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ScoredItem } from './scorer.js';

const RECENT_ITEMS_SCORES_KEY = 'osint:recent_item_scores';
const RECENT_ITEM_PREFIX = 'osint:item:';
// 48h — same window as near_zero:osint_signals so signals derived from an
// item and the item itself age out together.
const RECENT_ITEMS_TTL_S = 172_800;

export interface OsintStoredItem {
  title: string;
  keywords: string[];
  urgencyScore: number;
  categoryId: string;
}

function titleHash(title: string): string {
  return createHash('sha1').update(title).digest('hex').slice(0, 16);
}

/**
 * Persist a batch of scored items. Uses stable title-hash member keys so
 * re-scores of the same article overwrite the ZSET entry and the payload.
 * Prunes ZSET entries older than TTL on every write.
 */
export async function persistOsintItems(items: ScoredItem[], redis: Redis): Promise<void> {
  if (items.length === 0) return;
  const nowS = Math.floor(Date.now() / 1000);
  const pipeline = redis.pipeline();
  for (const item of items) {
    const hash = titleHash(item.title);
    const payload: OsintStoredItem = {
      title: item.title.slice(0, 300),
      keywords: item.keywords,
      urgencyScore: item.urgencyScore,
      categoryId: item.categoryId,
    };
    pipeline.zadd(RECENT_ITEMS_SCORES_KEY, nowS, hash);
    pipeline.set(`${RECENT_ITEM_PREFIX}${hash}`, JSON.stringify(payload), 'EX', RECENT_ITEMS_TTL_S);
  }
  pipeline.zremrangebyscore(RECENT_ITEMS_SCORES_KEY, '-inf', String(nowS - RECENT_ITEMS_TTL_S));
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
  const hashes = await redis.zrangebyscore(RECENT_ITEMS_SCORES_KEY, cutoff, '+inf');
  if (hashes.length === 0) return [];
  const payloads = await redis.mget(hashes.map((h) => `${RECENT_ITEM_PREFIX}${h}`));
  return payloads.flatMap((p) => {
    if (!p) return [];
    try {
      return [JSON.parse(p) as OsintStoredItem];
    } catch {
      return [];
    }
  });
}
