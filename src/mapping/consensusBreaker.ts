/**
 * Per-provider circuit breaker for consensus LLM calls.
 *
 * State lives in Redis so it survives restarts and is shared across workers.
 * Two keys per provider:
 *   consensus:breaker:{provider}:fails  — consecutive failure counter, EX = window
 *   consensus:breaker:{provider}:open   — open-circuit marker, EX = cooldown
 *
 * Cooldown expiry is the auto-retry mechanism: when the `:open` key TTLs out,
 * the next estimate will include the provider again. If it succeeds, we clear
 * state. If it fails, the fails counter starts over and a fresh window begins.
 *
 * Redis errors are swallowed and treated as "breaker closed" (fail-open), so
 * a Redis blip never silently drops all providers.
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';

export type ProviderName = 'openai' | 'gemini' | 'anthropic' | 'deepseek';

const KEY_PREFIX = 'consensus:breaker:';

function failsKey(provider: ProviderName): string {
  return `${KEY_PREFIX}${provider}:fails`;
}

function openKey(provider: ProviderName): string {
  return `${KEY_PREFIX}${provider}:open`;
}

/**
 * Returns true if the circuit for this provider is currently open —
 * i.e. the caller should skip this provider on this estimate.
 *
 * On Redis error: returns false (fail-open). Better to over-call a flapping
 * provider than to silently skip all providers because Redis is down.
 */
export async function isProviderOpen(redis: Redis, provider: ProviderName): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg.CONSENSUS_BREAKER_ENABLED) return false;
  try {
    return (await redis.exists(openKey(provider))) === 1;
  } catch {
    return false;
  }
}

/**
 * Record a successful call. Clears both the failure counter and the open
 * marker, so a provider coming back online immediately resumes normal use.
 */
export async function recordProviderSuccess(redis: Redis, provider: ProviderName): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.CONSENSUS_BREAKER_ENABLED) return;
  try {
    await redis.del(failsKey(provider), openKey(provider));
  } catch {
    // Non-fatal — state is self-healing via TTLs.
  }
}

/**
 * Record a failed call. Increments the failure counter (with a window TTL on
 * first failure) and opens the circuit once the threshold is hit. The open
 * marker's TTL is the cooldown — when it expires, the provider is retried
 * automatically.
 */
export async function recordProviderFailure(redis: Redis, provider: ProviderName): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.CONSENSUS_BREAKER_ENABLED) return;
  const threshold = cfg.CONSENSUS_BREAKER_FAILURE_THRESHOLD;
  const windowS = cfg.CONSENSUS_BREAKER_WINDOW_S;
  const cooldownS = cfg.CONSENSUS_BREAKER_COOLDOWN_S;
  try {
    const key = failsKey(provider);
    const fails = await redis.incr(key);
    if (fails === 1) {
      // First failure in a fresh window — set the window TTL.
      await redis.expire(key, windowS);
    }
    if (fails >= threshold) {
      await redis.set(openKey(provider), '1', 'EX', cooldownS);
      // Reset the counter so the next window after cooldown starts fresh.
      await redis.del(key);
      logger.warn('[consensus-breaker] circuit opened', {
        provider,
        fails,
        cooldownS,
      });
    }
  } catch {
    // Non-fatal — state is self-healing via TTLs.
  }
}
