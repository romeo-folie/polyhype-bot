/**
 * Simmer API client.
 *
 * Calls the Simmer hosted API (https://api.simmer.markets) directly.
 * No local skill server required — runs standalone on any machine (including Raspberry Pi).
 *
 * API reference: https://docs.simmer.markets
 *
 * Auth: Bearer token via SIMMER_API_KEY env var.
 * Venue: "polymarket" for real USDC trades (requires claimed agent + wallet allowances).
 *
 * Trade endpoint: POST /api/sdk/trade
 * Sell endpoint:  POST /api/sdk/trade (action: "sell", shares instead of amount)
 */

import { z } from 'zod';
import { loadConfig } from './config.js';

const SIMMER_BASE_URL = 'https://api.simmer.markets';
const TRADE_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/trade`;
const MARKETS_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/markets`;
const REQUEST_TIMEOUT_MS = 30_000;

// ── Request / response types ──────────────────────────────────────────────────

/** Input to POST /api/sdk/trade (buy). */
export interface SimmerTradeInput {
  /** Polymarket market ID. */
  market_id: string;
  /** Trade direction — 'yes' or 'no' (lowercase per Simmer API). */
  side: 'yes' | 'no';
  /** USDC amount to spend. */
  amount: number;
  /** Human-readable reasoning (displayed publicly on market page). */
  reasoning: string;
  /** Source tag for P&L tracking and rebuy protection. */
  source?: string;
  /** Venue — 'polymarket' for real USDC, 'sim' for virtual $SIM. */
  venue?: 'polymarket' | 'sim';
  /** If true, validate and calculate without executing. */
  dry_run?: boolean;
}

/** Input to POST /api/sdk/trade (sell). */
export interface SimmerSellInput {
  market_id: string;
  side: 'yes' | 'no';
  action: 'sell';
  /** Number of shares to sell (not USDC amount). */
  shares: number;
  reasoning: string;
  source?: string;
  venue?: 'polymarket' | 'sim';
}

/** Zod schema for Simmer trade response. */
const SimmerTradeResultSchema = z.object({
  success: z.boolean(),
  tx_hash: z.string().optional(),
  shares_bought: z.number().optional(),
  shares_sold: z.number().optional(),
  cost: z.number().optional(),
  price: z.number().optional(),
  warnings: z.array(z.string()).optional(),
  error: z.string().optional(),
  raw: z.unknown().optional(),
});

export type SimmerTradeResult = z.infer<typeof SimmerTradeResultSchema>;

/** Simmer API error with HTTP context. */
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

// ── HTTP helper ───────────────────────────────────────────────────────────────

async function postToSimmer(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<SimmerTradeResult> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let responseBody: unknown;
  try {
    responseBody = await resp.json();
  } catch {
    responseBody = await resp.text().catch(() => '(unreadable body)');
  }

  if (!resp.ok) {
    throw new SimmerError(
      `Simmer API returned HTTP ${resp.status.toString()}`,
      resp.status,
      responseBody,
    );
  }

  const parsed = SimmerTradeResultSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new SimmerError(
      `Simmer API response failed validation: ${parsed.error.message}`,
      resp.status,
      responseBody,
    );
  }

  return parsed.data;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a buy trade to Simmer.
 *
 * Uses venue="polymarket" by default for real USDC trades.
 * Requires a claimed Simmer agent with wallet allowances set up.
 *
 * @throws {SimmerError} on HTTP 4xx/5xx or network failure
 */
export async function submitTrade(input: SimmerTradeInput): Promise<SimmerTradeResult> {
  return postToSimmer(TRADE_ENDPOINT, {
    market_id: input.market_id,
    side: input.side,
    amount: input.amount,
    reasoning: input.reasoning,
    source: input.source ?? 'sdk:polymarket-geopolitical-agent',
    venue: input.venue ?? 'polymarket',
    ...(input.dry_run !== undefined && { dry_run: input.dry_run }),
  });
}

/**
 * Submit a sell order to Simmer.
 *
 * Pass shares (not USDC amount). Venue defaults to "polymarket".
 *
 * @throws {SimmerError} on HTTP 4xx/5xx or network failure
 */
export async function submitSell(input: SimmerSellInput): Promise<SimmerTradeResult> {
  return postToSimmer(TRADE_ENDPOINT, {
    market_id: input.market_id,
    side: input.side,
    action: 'sell',
    shares: input.shares,
    reasoning: input.reasoning,
    source: input.source ?? 'sdk:polymarket-geopolitical-agent',
    venue: input.venue ?? 'polymarket',
  });
}

/**
 * Resolve a Gamma/Polymarket numeric market ID to a Simmer UUID.
 *
 * Simmer uses its own internal UUIDs — passing a Gamma numeric ID directly
 * to the trade endpoint returns "Market not found". This function searches
 * Simmer's market catalogue by question text and returns the matching UUID.
 *
 * Returns null if:
 * - No match found in Simmer (market not in Simmer's catalogue)
 * - Network/API failure
 *
 * @param question  The market question text from Gamma (used as search query)
 */
export async function resolveSimmerMarketId(question: string): Promise<string | null> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  // Use the first 6+ meaningful words as the search query (better recall than full question)
  const searchQuery = question.split(' ').slice(0, 8).join(' ');
  const url = `${MARKETS_ENDPOINT}?q=${encodeURIComponent(searchQuery)}&limit=5`;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { markets?: Array<{ id: string; question: string }> };
    const markets = data.markets ?? [];

    // Require a strong match — exact case-insensitive question match only.
    // Loose substring matching or markets[0] fallback risks mapping to the
    // wrong market and triggering incorrect live trades.
    const exactMatch = markets.find(
      (m) => m.question.toLowerCase().trim() === question.toLowerCase().trim(),
    );

    return exactMatch?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Lightweight connectivity probe — sends a dry_run trade with an obviously
 * invalid market ID so Simmer rejects it cleanly without executing anything.
 *
 * Returns reachable=true even on 4xx (auth issues surface here).
 */
export async function probeSimmerSkill(): Promise<{
  reachable: boolean;
  body: unknown;
  statusCode: number;
}> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  try {
    const resp = await fetch(TRADE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        market_id: '__probe__',
        side: 'yes',
        amount: 0,
        reasoning: 'connectivity probe',
        venue: 'sim',
        dry_run: true,
      }),
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
    return {
      reachable: false,
      body: err instanceof Error ? err.message : String(err),
      statusCode: 0,
    };
  }
}
