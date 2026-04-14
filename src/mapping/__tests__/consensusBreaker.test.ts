import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockCfg = {
  CONSENSUS_BREAKER_ENABLED: true,
  CONSENSUS_BREAKER_FAILURE_THRESHOLD: 3,
  CONSENSUS_BREAKER_WINDOW_S: 120,
  CONSENSUS_BREAKER_COOLDOWN_S: 600,
};
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => mockCfg),
}));

const {
  isProviderOpen,
  recordProviderFailure,
  recordProviderSuccess,
} = await import('../consensusBreaker.js');

/** Minimal in-memory Redis stub covering the ops the breaker uses. */
function makeFakeRedis(): Redis {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const now = () => Date.now();
  const active = (k: string) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.expiresAt !== null && e.expiresAt <= now()) {
      store.delete(k);
      return null;
    }
    return e;
  };
  const fake = {
    async incr(key: string) {
      const e = active(key);
      const v = (e ? parseInt(e.value, 10) : 0) + 1;
      store.set(key, { value: String(v), expiresAt: e?.expiresAt ?? null });
      return v;
    },
    async expire(key: string, seconds: number) {
      const e = active(key);
      if (!e) return 0;
      e.expiresAt = now() + seconds * 1000;
      return 1;
    },
    async set(
      key: string,
      value: string,
      _mode?: string,
      seconds?: number,
    ) {
      store.set(key, {
        value,
        expiresAt: typeof seconds === 'number' ? now() + seconds * 1000 : null,
      });
      return 'OK';
    },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    async exists(key: string) {
      return active(key) ? 1 : 0;
    },
    async get(key: string) {
      return active(key)?.value ?? null;
    },
    async _force(key: string, value: string, ttlMs: number | null) {
      store.set(key, { value, expiresAt: ttlMs === null ? null : now() + ttlMs });
    },
  };
  return fake as unknown as Redis;
}

describe('consensusBreaker', () => {
  let redis: Redis;

  beforeEach(() => {
    redis = makeFakeRedis();
    mockCfg.CONSENSUS_BREAKER_ENABLED = true;
    mockCfg.CONSENSUS_BREAKER_FAILURE_THRESHOLD = 3;
    mockCfg.CONSENSUS_BREAKER_WINDOW_S = 120;
    mockCfg.CONSENSUS_BREAKER_COOLDOWN_S = 600;
  });

  it('starts closed', async () => {
    expect(await isProviderOpen(redis, 'anthropic')).toBe(false);
  });

  it('opens after threshold failures and auto-retries after cooldown', async () => {
    await recordProviderFailure(redis, 'anthropic');
    await recordProviderFailure(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(false);
    await recordProviderFailure(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(true);

    // Simulate cooldown TTL expiring — provider is retried on next estimate.
    await redis.del('consensus:breaker:anthropic:open');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(false);
  });

  it('success clears both counter and open marker', async () => {
    await recordProviderFailure(redis, 'anthropic');
    await recordProviderFailure(redis, 'anthropic');
    await recordProviderFailure(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(true);

    await recordProviderSuccess(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(false);
    // Next failure starts a fresh window — need a full threshold again.
    await recordProviderFailure(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(false);
  });

  it('per-provider isolation: opening anthropic does not affect openai', async () => {
    for (let i = 0; i < 3; i++) await recordProviderFailure(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(true);
    expect(await isProviderOpen(redis, 'openai')).toBe(false);
  });

  it('disabled flag bypasses the breaker', async () => {
    mockCfg.CONSENSUS_BREAKER_ENABLED = false;
    for (let i = 0; i < 10; i++) await recordProviderFailure(redis, 'anthropic');
    expect(await isProviderOpen(redis, 'anthropic')).toBe(false);
  });

  it('fails open when Redis throws (never blocks all providers on infra blip)', async () => {
    const brokenRedis = {
      exists: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as Redis;
    expect(await isProviderOpen(brokenRedis, 'anthropic')).toBe(false);
  });
});
