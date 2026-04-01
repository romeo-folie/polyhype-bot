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

export async function recordCryptoArbMetric(redis: Redis, metric: string, label = 'count'): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:crypto-arb:${metric}`, label);
}

export async function recordCopytradeFilter(redis: Redis, reason: string): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:copytrade:filters`, reason);
}

export async function recordCopytradeMalformed(redis: Redis, reason: string): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:copytrade:malformed`, reason);
}

export async function recordCopytradeMetric(redis: Redis, metric: string, label = 'count'): Promise<void> {
  await hincrby(redis, `${BASE_KEY}:copytrade:${metric}`, label);
}
*** End of File
