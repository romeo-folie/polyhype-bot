/**
 * Simmer SDK wrapper.
 *
 * Wraps the `polymarket-ai-divergence` Simmer skill with typed input/output.
 * Uses native fetch (no heavy wrappers); assumes Node 20+ fetch is available.
 *
 * The Simmer skill URL and API key are loaded from environment configuration
 * via `loadConfig()`.
 */

import { z } from 'zod';
import { loadConfig } from './config.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Input to the polymarket-ai-divergence skill. */
export interface SimmerTradeInput {
  /** Polymarket market ID (CLOB market address). */
  market_id: string;
  /** Trade direction. */
  direction: 'YES' | 'NO';
  /** USDC amount to spend (before gas). */
  amount_usdc: number;
}

/** Zod schema for validating Simmer skill responses. */
const SimmerTradeResultSchema = z.object({
  success: z.boolean(),
  tx_hash: z.string().optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
});

/** Result from the polymarket-ai-divergence skill. */
export type SimmerTradeResult = z.infer<typeof SimmerTradeResultSchema>;

/** Simmer skill error with HTTP context. */
export class SimmerError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'SimmerError';
  }
}

// ── Client ─────────────────────────────────────────────────────────────────

/**
 * Calls the Simmer `polymarket-ai-divergence` skill with the given trade input.
 *
 * @throws {SimmerError} on HTTP 4xx/5xx or network failure
 */
export async function submitTrade(input: SimmerTradeInput): Promise<SimmerTradeResult> {
  const { SIMMER_SKILL_URL: skillUrl, SIMMER_API_KEY: apiKey } = loadConfig();

  const resp = await fetch(skillUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000), // 30 s hard timeout
  });

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    body = await resp.text().catch(() => '(unreadable body)');
  }

  if (!resp.ok) {
    throw new SimmerError(
      `Simmer skill returned HTTP ${resp.status.toString()}`,
      resp.status,
      body,
    );
  }

  const parsed = SimmerTradeResultSchema.safeParse(body);
  if (!parsed.success) {
    throw new SimmerError(
      `Simmer skill response failed validation: ${parsed.error.message}`,
      resp.status,
      body,
    );
  }
  return parsed.data;
}

/**
 * Lightweight connectivity check — sends a dry-run probe to the skill.
 * Returns the raw response body for schema inspection.
 *
 * This does NOT submit a real trade; the probe payload uses an obviously
 * invalid market ID so the skill should reject it cleanly.
 */
export async function probeSimmerSkill(): Promise<{ reachable: boolean; body: unknown; statusCode: number }> {
  let skillUrl: string;
  let apiKey: string;
  try {
    const cfg = loadConfig();
    skillUrl = cfg.SIMMER_SKILL_URL;
    apiKey = cfg.SIMMER_API_KEY;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, body: message, statusCode: 0 };
  }

  try {
    const resp = await fetch(skillUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        market_id: '__probe__',
        direction: 'YES',
        amount_usdc: 0,
      } satisfies SimmerTradeInput),
      signal: AbortSignal.timeout(10_000),
    });

    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      body = await resp.text().catch(() => '(unreadable body)');
    }

    return { reachable: true, body, statusCode: resp.status };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, body: message, statusCode: 0 };
  }
}
