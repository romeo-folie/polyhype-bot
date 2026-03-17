/**
 * Shared Redis client utility.
 *
 * Single shared instance. Callers should NOT create their own Redis instances.
 * Exported as a lazy singleton so the connection is only established when first used.
 */

import { Redis } from 'ioredis';

let _client: Redis | null = null;

export function getRedis(): Redis {
  if (_client) return _client;

  const url = process.env['REDIS_URL'];
  if (!url) {
    throw new Error('REDIS_URL environment variable is not set');
  }

  _client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });

  _client.on('error', (err: Error) => {
    console.error('[redis] connection error:', err.message);
  });

  return _client;
}

/** Gracefully disconnect. Call on process exit. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
}

/**
 * Deduplication helper.
 * Returns true if this key has NOT been seen before (i.e. caller should process it).
 * Sets a TTL so old keys expire automatically.
 *
 * @param key   Unique identifier for the item (e.g. article hash)
 * @param ttlSeconds  How long to remember this key (default: 24 hours)
 */
export async function dedup(key: string, ttlSeconds = 86400): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(`dedup:${key}`, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK'; // OK = first time seen, null = already seen
}
