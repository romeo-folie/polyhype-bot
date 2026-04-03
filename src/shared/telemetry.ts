import type { Redis } from 'ioredis';

const BASE_KEY = 'telemetry';

async function hincrby(redis: Redis, key: string, field: string, amount = 1): Promise<void> {
  await redis.hincrby(key, field, amount);
}

export async function recordCryptoArbGate(redis: Redis, reason: string): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:crypto-arb:gates`, reason);
}

export async function recordCryptoArbEvent(redis: Redis, event: string): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:crypto-arb:events`, event);
}

export async function recordCryptoArbMetric(
  redis: Redis,
  metric: string,
  label = 'count',
): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:crypto-arb:${metric}`, label);
}

export async function recordCopytradeFilter(redis: Redis, reason: string): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:copytrade:filters`, reason);
}

export async function recordCopytradeMalformed(redis: Redis, reason: string): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:copytrade:malformed`, reason);
}

export async function recordCopytradeMetric(
  redis: Redis,
  metric: string,
  label = 'count',
): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:copytrade:${metric}`, label);
}

export async function recordExecutionMetric(
  redis: Redis,
  metric: string,
  label = 'count',
): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:execution:${metric}`, label);
}

export async function recordExecutionTiming(
  redis: Redis,
  metric: string,
  ms: number,
): Promise<void> {
  const rounded = Math.max(0, Math.round(ms));
  await hincrby(redis, `${BASE_KEY}:execution:${metric}`, 'sum_ms', rounded);
  await hincrby(redis, `${BASE_KEY}:execution:${metric}`, 'count', 1);
}

export async function recordExecutionEvent(
  redis: Redis,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const key = `${BASE_KEY}:execution:events`;
  const entry = JSON.stringify({ event, ...payload });
  await redis.lpush(key, entry);
  await redis.ltrim(key, 0, 499);
}
