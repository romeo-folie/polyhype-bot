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
import { logger } from './logger.js';

const SIMMER_BASE_URL = 'https://api.simmer.markets';
const TRADE_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/trade`;
const MARKETS_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/markets`;
const POSITIONS_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/positions`;
const REDEEM_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/redeem`;
const CONTEXT_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/context`;
const OPPORTUNITIES_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/markets/opportunities`;
const PORTFOLIO_ENDPOINT = `${SIMMER_BASE_URL}/api/sdk/portfolio`;
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
  // Simmer sometimes returns `error: null` on HTTP 200 responses.
  error: z.string().nullish(),
  raw: z.unknown().optional(),
});

export type SimmerTradeResult = z.infer<typeof SimmerTradeResultSchema>;

/** Zod schema for Simmer position response. */
const SimmerPositionSchema = z.object({
  market_id: z.string(),
  side: z.enum(['yes', 'no']),
  redeemable: z.boolean(),
  question: z.string().optional(),
  shares: z.number().optional(),
  value_usdc: z.number().optional(),
});

function deriveSide(raw: Record<string, unknown>): 'yes' | 'no' | null {
  const yes = Number(raw.shares_yes ?? 0);
  const no = Number(raw.shares_no ?? 0);
  if (Number.isFinite(yes) && yes > 0 && (!Number.isFinite(no) || no <= 0)) return 'yes';
  if (Number.isFinite(no) && no > 0 && (!Number.isFinite(yes) || yes <= 0)) return 'no';
  return null;
}

function normalisePosition(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };

  if (!('side' in next)) {
    const inferred = deriveSide(next);
    if (inferred) {
      next.side = inferred;
      logger.info('[simmer] inferred missing side from shares', {
        market_id: next.market_id,
        side: inferred,
      });
    }
  }

  if (!('redeemable' in next)) {
    next.redeemable = false;
  }

  if (!('shares' in next)) {
    const yes = Number(next.shares_yes ?? 0);
    const no = Number(next.shares_no ?? 0);
    const side = typeof next.side === 'string' ? next.side : null;

    if (side === 'yes' && Number.isFinite(yes) && yes > 0) {
      next.shares = yes;
    } else if (side === 'no' && Number.isFinite(no) && no > 0) {
      next.shares = no;
    } else if (!side) {
      if (Number.isFinite(yes) && yes > 0 && (!Number.isFinite(no) || no <= 0)) {
        next.shares = yes;
      } else if (Number.isFinite(no) && no > 0 && (!Number.isFinite(yes) || yes <= 0)) {
        next.shares = no;
      } else if (Number.isFinite(yes) && yes > 0 && Number.isFinite(no) && no > 0) {
        logger.warn('[simmer] ambiguous shares (both yes/no set) — skipping derived shares', {
          market_id: next.market_id,
          shares_yes: yes,
          shares_no: no,
        });
      }
    }
  }

  if (!('value_usdc' in next)) {
    const price = Number(next.current_price ?? NaN);
    const shares = Number(next.shares ?? NaN);
    if (Number.isFinite(price) && Number.isFinite(shares)) {
      next.value_usdc = price * shares;
    }
  }

  return next;
}

export type SimmerPosition = z.infer<typeof SimmerPositionSchema>;

/** Response from POST /api/sdk/redeem. */
const SimmerRedeemResultSchema = z.object({
  success: z.boolean(),
  tx_hash: z.string().optional().nullable(),
  unsigned_tx: z.unknown().optional().nullable(),
  error: z.string().optional().nullable(),
});

export type SimmerRedeemResult = z.infer<typeof SimmerRedeemResultSchema>;

/** Zod schema for Simmer portfolio response. */
const SimmerPortfolioSchema = z.object({
  balance_usdc: z.number(),
  sim_balance: z.number().optional(),
  total_exposure: z.number().optional(),
  positions_count: z.number().optional(),
  pnl_total: z.number().optional(),
});

export type SimmerPortfolio = z.infer<typeof SimmerPortfolioSchema>;

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
 * Resolve a Gamma/Polymarket market question to a Simmer UUID.
 *
 * Safety requirement: mapping must be deterministic and high-confidence.
 * We only accept normalized full-question equality (no fuzzy fallback).
 */
export async function resolveSimmerMarketId(question: string): Promise<string | null> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  // Query using full question text for maximum precision.
  const url = `${MARKETS_ENDPOINT}?q=${encodeURIComponent(question)}&limit=20`;

  const normalizeQuestion = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;

    const data = (await resp.json()) as { markets?: { id: string; question: string }[] };
    const markets = data.markets ?? [];

    const target = normalizeQuestion(question);
    const exactMatch = markets.find((m) => normalizeQuestion(m.question) === target);

    return exactMatch?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch positions from Simmer filtered by status and venue.
 *
 * Use status="resolved" to find positions ready for redemption.
 * Filters to venue="polymarket" by default — PGA only trades there.
 *
 * @throws {SimmerError} on HTTP 4xx/5xx or network failure
 */
export async function getSimmerPositions(opts: {
  status?: 'active' | 'resolved' | 'closed' | 'all';
  venue?: 'polymarket' | 'sim' | 'kalshi';
  source?: string;
} = {}): Promise<SimmerPosition[]> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();
  const { status = 'active', venue = 'polymarket', source } = opts;

  const params = new URLSearchParams({ status, venue });
  if (source) params.set('source', source);

  const resp = await fetch(`${POSITIONS_ENDPOINT}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.json().catch(() => resp.text());
    throw new SimmerError(`Simmer positions API returned HTTP ${resp.status.toString()}`, resp.status, body);
  }

  const raw = (await resp.json());
  // API may return { positions: [...] } or a bare array
  const arr = Array.isArray(raw) ? raw : ((raw as Record<string, unknown>).positions ?? []);
  const positions: SimmerPosition[] = [];
  for (const item of arr as unknown[]) {
    const candidate = typeof item === 'object' && item !== null
      ? normalisePosition(item as Record<string, unknown>)
      : item;
    const parsed = SimmerPositionSchema.safeParse(candidate);
    if (parsed.success) {
      positions.push(parsed.data);
    } else {
      logger.warn('[simmer] skipping malformed position entry', {
        error: parsed.error.message,
        raw: JSON.stringify(item).slice(0, 200),
      });
    }
  }
  return positions;
}

/**
 * Redeem a winning Polymarket position for USDC.e on Polygon.
 *
 * For managed wallets: Simmer signs and submits server-side, returns tx_hash.
 * For external wallets: returns unsigned_tx (not handled here — PGA uses managed wallets).
 *
 * @throws {SimmerError} on HTTP 4xx/5xx or network failure
 */
export async function submitRedeem(input: {
  market_id: string;
  side: 'yes' | 'no';
}): Promise<SimmerRedeemResult> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  const resp = await fetch(REDEEM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ market_id: input.market_id, side: input.side }),
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
      `Simmer redeem API returned HTTP ${resp.status.toString()}`,
      resp.status,
      responseBody,
    );
  }

  const parsed = SimmerRedeemResultSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new SimmerError(
      `Simmer redeem response failed validation: ${parsed.error.message}`,
      resp.status,
      responseBody,
    );
  }

  return parsed.data;
}

/** Trading discipline returned by GET /api/sdk/context/{market_id}. */
export interface SimmerContextDiscipline {
  last_action?: string | null;
  last_action_at?: string | null;
  direction_changes_24h: number;
  flip_flop_warning?: string | null;
  /** 'none' | 'caution' | 'severe' */
  warning_level: string;
}

/** Concise context response — only fields PGA cares about. */
export interface SimmerMarketContext {
  market: {
    id: string;
    question: string;
    current_price: number;
    status: string;
    resolution_criteria?: string | null;
    fee_rate_bps: number;
    spread?: number | null;
    resolves_at?: string | null;
    ai_consensus?: number | null;
    divergence?: number | null;
  };
  position: {
    has_position: boolean;
    side?: string | null;
  };
  discipline: SimmerContextDiscipline;
  warnings: string[];
}

/**
 * Fetch context for a single market — safeguards, resolution criteria, discipline.
 *
 * Pass myProbability to get a TRADE/HOLD recommendation from Simmer's edge engine.
 * Rate limited: 300/min. Returns null on any error (never throws).
 */
export async function getMarketContext(
  marketId: string,
  myProbability?: number,
): Promise<SimmerMarketContext | null> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  const url = new URL(`${CONTEXT_ENDPOINT}/${marketId}`);
  if (myProbability !== undefined) {
    url.searchParams.set('my_probability', myProbability.toString());
  }

  try {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;
    return (await resp.json()) as SimmerMarketContext;
  } catch {
    return null;
  }
}

/** A single opportunity from GET /api/sdk/markets/opportunities. */
export interface SimmerOpportunity {
  id: string;
  question: string;
  current_price: number;
  ai_consensus?: number | null;
  external_price?: number | null;
  divergence: number;
  recommended_side: 'yes' | 'no';
  signal_source?: 'oracle' | 'crowd' | null;
  fee_rate_bps?: number;
  [key: string]: unknown;
}

/**
 * Fetch Simmer's ranked opportunity list — markets where AI diverges from market price.
 *
 * signal_source "oracle" = AI multi-model forecast; "crowd" = sim agent activity.
 * Returns empty array on any error (never throws).
 */
export async function getOpportunities(opts: {
  venue?: 'polymarket' | 'kalshi' | 'sim';
  limit?: number;
  minDivergence?: number;
} = {}): Promise<SimmerOpportunity[]> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();
  const { venue = 'polymarket', limit = 50, minDivergence = 0.03 } = opts;

  const params = new URLSearchParams({
    venue,
    limit: limit.toString(),
    min_divergence: minDivergence.toString(),
  });

  try {
    const resp = await fetch(`${OPPORTUNITIES_ENDPOINT}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) return [];
    const data = (await resp.json()) as { opportunities?: SimmerOpportunity[] } | SimmerOpportunity[];
    return Array.isArray(data) ? data : (data.opportunities ?? []);
  } catch {
    return [];
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

/**
 * Fetch the Simmer wallet portfolio — live USDC balance and summary stats.
 *
 * Used by bankroll module to replace the Redis-seeded counter with the
 * actual wallet balance tracked by Simmer.
 *
 * @throws {SimmerError} on HTTP 4xx/5xx or network failure
 */
export async function getPortfolio(): Promise<SimmerPortfolio> {
  const { SIMMER_API_KEY: apiKey } = loadConfig();

  const resp = await fetch(PORTFOLIO_ENDPOINT, {
    headers: { Authorization: `Bearer ${apiKey}` },
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
      `Simmer portfolio API returned HTTP ${resp.status.toString()}`,
      resp.status,
      responseBody,
    );
  }

  const parsed = SimmerPortfolioSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new SimmerError(
      `Simmer portfolio response failed validation: ${parsed.error.message}`,
      resp.status,
      responseBody,
    );
  }

  return parsed.data;
}
