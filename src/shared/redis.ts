/**
 * Shared Redis client utility.
 *
 * Single shared instance. Callers should NOT create their own Redis instances.
 * Exported as a lazy singleton — connection only established when first used.
 */

import { Redis } from 'ioredis';
import { logger } from './logger.js';

let _client: Redis | null = null;
let _subscriber: Redis | null = null;

export function getRedis(): Redis {
  if (_client) return _client;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL environment variable is not set');
  }

  _client = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  _client.on('error', (err: Error) => {
    logger.error('[redis] connection error', { message: err.message });
  });

  return _client;
}

export function getSubscriberRedis(): Redis {
  if (_subscriber) return _subscriber;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL environment variable is not set');
  }

  _subscriber = new Redis(url, {
    maxRetriesPerRequest: null, // Subscriptions stay open
    enableReadyCheck: true,
    lazyConnect: true,
  });

  return _subscriber;
}

/** Gracefully disconnect. Call on process exit. */
export async function closeRedis(): Promise<void> {
  if (_client) {
    await _client.quit();
    _client = null;
  }
  if (_subscriber) {
    await _subscriber.quit();
    _subscriber = null;
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

/**
 * Acquire a named lock with a unique token (ownership-safe).
 *
 * Returns the token string if the lock was acquired, or null if the lock is
 * already held by another run. Callers must pass the returned token to
 * releaseLock() so only the owner can release it.
 *
 * @param key       Redis key for the lock
 * @param ttlSec    Lock expiry (set conservatively: cron interval - 30s buffer)
 */
export async function acquireLock(key: string, ttlSec: number): Promise<string | null> {
  const redis = getRedis();
  const token = `${Date.now().toString()}-${Math.random().toString(36).slice(2)}`;
  const result = await redis.set(key, token, 'EX', ttlSec, 'NX');
  return result === 'OK' ? token : null;
}

/**
 * Release a named lock only if this process owns it (compare-and-delete via Lua).
 *
 * This prevents a long-running process from releasing a lock that has already
 * expired and been reacquired by a newer run.
 */
export async function releaseLock(key: string, token: string): Promise<void> {
  const redis = getRedis();
  // Atomic compare-and-delete: only DEL if the stored value matches our token.
  await redis.eval(
    `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
    1,
    key,
    token,
  );
}

/**
 * Refresh a lock's TTL, distinguishing "key missing" from "stolen by another".
 *
 * Returns:
 *   'refreshed' — our token is still there, TTL bumped. Continue normally.
 *   'expired'   — the key is gone. Our own TTL lapsed (cycle too slow,
 *                 network blip, Redis pause, GC stall). Caller should
 *                 re-acquire the lock with SET NX and continue, not abort.
 *   'stolen'    — the key holds a DIFFERENT token. Another instance owns
 *                 this lock. Caller MUST abort to avoid duplicate actions.
 *
 * This replaces the old `eval(... return 0 else)` pattern that conflated
 * "expired" and "stolen" — the conflation caused silent worker deaths
 * whenever a cycle ran longer than the lock TTL, with no actual second
 * instance present.
 */
export async function refreshLock(
  key: string,
  token: string,
  ttlSec: number,
): Promise<'refreshed' | 'expired' | 'stolen'> {
  const redis = getRedis();
  const result = (await redis.eval(
    `local v = redis.call("get", KEYS[1])
     if v == false then return -1 end
     if v == ARGV[1] then return redis.call("expire", KEYS[1], ARGV[2]) end
     return 0`,
    1,
    key,
    token,
    String(ttlSec),
  )) as number;
  if (result === -1) return 'expired';
  if (result === 0) return 'stolen';
  return 'refreshed';
}

/**
 * Re-acquire a lock after our own TTL expired. Uses SET NX so if another
 * process sneaked in between expiry and re-acquire, we detect it and return
 * null (caller should then shut down). On success the caller holds the lock
 * under the SAME token, so existing release/refresh calls keep working.
 */
export async function reacquireLockAfterExpiry(
  key: string,
  token: string,
  ttlSec: number,
): Promise<boolean> {
  const redis = getRedis();
  const result = await redis.set(key, token, 'EX', ttlSec, 'NX');
  return result === 'OK';
}

// NOTE: Redis shutdown is handled by each worker's own SIGTERM/SIGINT handler.
// Workers must: (1) release their lock, (2) call closeRedis(), (3) process.exit().
// We do NOT register signal handlers here because closeRedis() would race the
// worker's lock-release Lua eval, closing the connection before the lock is freed.
