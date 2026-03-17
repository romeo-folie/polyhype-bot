/**
 * Simmer SDK wrapper.
 *
 * Wraps the `polymarket-ai-divergence` Simmer skill with typed input/output.
 * Uses native fetch (no heavy wrappers); assumes Node 20+ fetch is available.
 *
 * The Simmer skill URL and API key are loaded from environment variables:
 *   SIMMER_SKILL_URL  — base URL of the skill endpoint
 *   SIMMER_API_KEY    — bearer token for authentication
 */

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

/** Result from the polymarket-ai-divergence skill. */
export interface SimmerTradeResult {
  /** Whether the trade was submitted successfully. */
  success: boolean;
  /** On-chain transaction hash (present when success=true). */
  tx_hash?: string;
  /** Human-readable error message (present when success=false). */
  error?: string;
  /** Raw response data from the skill (for debugging). */
  raw?: unknown;
}

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
  const skillUrl = process.env['SIMMER_SKILL_URL'];
  const apiKey = process.env['SIMMER_API_KEY'];

  if (!skillUrl) throw new Error('SIMMER_SKILL_URL is not set');
  if (!apiKey) throw new Error('SIMMER_API_KEY is not set');

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

  return body as SimmerTradeResult;
}

/**
 * Lightweight connectivity check — sends a dry-run probe to the skill.
 * Returns the raw response body for schema inspection.
 *
 * This does NOT submit a real trade; the probe payload uses an obviously
 * invalid market ID so the skill should reject it cleanly.
 */
export async function probeSimmerSkill(): Promise<{ reachable: boolean; body: unknown; statusCode: number }> {
  const skillUrl = process.env['SIMMER_SKILL_URL'];
  const apiKey = process.env['SIMMER_API_KEY'];

  if (!skillUrl) {
    return { reachable: false, body: 'SIMMER_SKILL_URL is not set', statusCode: 0 };
  }

  try {
    const resp = await fetch(skillUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
