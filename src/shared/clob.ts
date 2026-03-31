/**
 * Polymarket CLOB execution client.
 *
 * Used as fallback when a signal market is not available in Simmer's catalogue.
 * Trades are signed locally with POLYGON_WALLET_PRIVATE_KEY.
 */

import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { Wallet as Wallet6, Contract, JsonRpcProvider, Network } from 'ethers';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { getRedis } from './redis.js';
import type { ApiKeyCreds } from '@polymarket/clob-client';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
// Hard timeout for CLOB order submission. The SDK has no built-in timeout;
// without this a hung connection would keep the cron process alive indefinitely.
const CLOB_ORDER_TIMEOUT_MS = 30_000;
/** Polymarket CLOB protocol minimum — orders below this are rejected. */
export const CLOB_MIN_ORDER_USD = 1.0;

const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

// Ordered list of public Polygon RPC endpoints for balance lookups.
// First entry is user-configured (POLYGON_RPC_URL); remaining are free public fallbacks.
const POLYGON_PUBLIC_RPCS = [
  'https://polygon-rpc.com',
  'https://polygon.llamarpc.com',
  'https://polygon-bor-rpc.publicnode.com',
];

// Polymarket ERC-1155 tokens use 6 decimals (1 share = 1,000,000 raw units).
const CLOB_TOKEN_DECIMALS = 6;
const CLOB_TOKEN_DIVISOR = 10 ** CLOB_TOKEN_DECIMALS; // 1_000_000

/**
 * Build the ordered RPC URL list: user-configured first, then public fallbacks (deduped).
 */
function buildRpcList(): string[] {
  const userRpc = process.env['POLYGON_RPC_URL'];
  const rpcUrls: string[] = [];
  if (userRpc) rpcUrls.push(userRpc);
  for (const rpc of POLYGON_PUBLIC_RPCS) {
    if (!rpcUrls.includes(rpc)) rpcUrls.push(rpc);
  }
  return rpcUrls;
}

/**
 * Create a fresh JsonRpcProvider for a given RPC URL.
 * No caching — each failover attempt gets its own provider to avoid stale connections.
 */
function createProvider(rpcUrl: string): JsonRpcProvider {
  const polygonNetwork = new Network('matic', 137);
  return new JsonRpcProvider(rpcUrl, polygonNetwork, { staticNetwork: polygonNetwork });
}

export interface ClobBuyInput {
  tokenId: string;
  amountUsd: number;
  /** Override order type. Defaults to CLOB_ORDER_TYPE config. Use FOK for arb legs. */
  orderType?: 'FOK' | 'FAK';
}

export interface ClobSellInput {
  tokenId: string;
  /** Number of conditional tokens to sell */
  shares: number;
  orderType?: 'FOK' | 'FAK';
}

export interface ClobTradeResult {
  success: boolean;
  tx_hash?: string;
  shares_bought?: number;
  error?: string;
  raw?: unknown;
}

/** SDK OrderResponse shape from createAndPostMarketOrder */
interface OrderResponse {
  success: boolean;
  errorMsg: string;
  orderID: string;
  transactionsHashes: string[];
  status: string;
  takingAmount: string;
  makingAmount: string;
}

let cachedClient: Promise<ClobClient> | null = null;

// Redis key where derived API creds are persisted across process restarts.
// TTL is 23 hours — Polymarket API keys do not expire, but we refresh daily
// as a precaution so stale keys (e.g. after account changes) don't persist forever.
const CLOB_CREDS_REDIS_KEY = 'clob:api_creds';
const CLOB_CREDS_TTL_SECONDS = 23 * 3600;

const BALANCE_RAW_RE = /balance:\s*(\d+),\s*order amount:\s*(\d+)/i;

function normaliseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Parse actual on-chain balance from a CLOB "not enough balance" error.
 *
 * Polymarket's CLOB returns errors like:
 *   "not enough balance / allowance: the balance is not enough → balance: 3266460, order amount: 3280000"
 *
 * The balance value is in 6-decimal raw units (1 share = 1_000_000 raw units).
 * Returns the actual balance in shares (human units), or null if unparseable.
 */
export function parseBalanceFromClobError(errorMsg: string): number | null {
  const match = BALANCE_RAW_RE.exec(errorMsg);
  if (!match?.[1]) return null;
  const rawBalance = parseInt(match[1], 10);
  if (!isFinite(rawBalance) || rawBalance < 0) return null;
  return rawBalance / CLOB_TOKEN_DIVISOR;
}

async function loadPersistedCreds(): Promise<ApiKeyCreds | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(CLOB_CREDS_REDIS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'key' in parsed &&
      'secret' in parsed &&
      'passphrase' in parsed
    ) {
      return parsed as ApiKeyCreds;
    }
    return null;
  } catch {
    return null;
  }
}

async function persistCreds(creds: ApiKeyCreds): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(CLOB_CREDS_REDIS_KEY, JSON.stringify(creds), 'EX', CLOB_CREDS_TTL_SECONDS);
  } catch (err) {
    // Non-fatal: if persist fails, creds are still used in-process; next cold start will re-derive.
    logger.warn('[clob] failed to persist API creds to Redis', { error: normaliseError(err) });
  }
}

export async function getClobClient(): Promise<ClobClient> {
  if (cachedClient) return cachedClient;

  const initPromise = (async () => {
    const cfg = loadConfig();

    if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
      throw new Error('POLYGON_WALLET_PRIVATE_KEY is required for CLOB fallback execution');
    }

    const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
    const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;
    const sigType = cfg.POLYMARKET_SIGNATURE_TYPE;

    // Try to load previously persisted creds first — avoids a round-trip to
    // /auth/api-key on every cold start, which Polymarket rate-limits at ~400/day.
    let creds = await loadPersistedCreds();
    if (creds) {
      logger.info('[clob] loaded API creds from Redis cache');
    } else {
      logger.info('[clob] deriving new API creds from Polymarket');
      // IMPORTANT: the bootstrap client used for key derivation must be initialised
      // with the same signatureType and funderAddress as the final client. Polymarket
      // ties API keys to the account identity (EOA / proxy / gnosis safe). Deriving
      // with a bare EOA client (sig type 0) when the account is a proxy (sig type 1)
      // produces a key bound to the wrong address — causing 400 on all subsequent calls.
      const bootstrap = new ClobClient(
        CLOB_HOST,
        POLYGON_CHAIN_ID,
        signer,
        undefined,     // no creds yet
        sigType,
        funderAddress,
      );
      creds = await bootstrap.createOrDeriveApiKey();
      await persistCreds(creds);
    }

    return new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      signer,
      creds,
      sigType,
      funderAddress,
    );
  })();

  cachedClient = initPromise;

  // Clear the cached promise on rejection so the next call retries fresh
  // instead of returning the same rejected promise forever.
  // Also clear persisted creds on auth failure so the next attempt re-derives.
  initPromise.catch((err: unknown) => {
    if (cachedClient === initPromise) {
      cachedClient = null;
    }
    // If the failure looks like an auth error, evict the cached creds so the
    // next cold start doesn't replay a stale/invalid key set.
    const msg = normaliseError(err).toLowerCase();
    if (msg.includes('api key') || msg.includes('auth') || msg.includes('401') || msg.includes('403')) {
      logger.warn('[clob] auth failure — evicting cached API creds from Redis');
      void getRedis().del(CLOB_CREDS_REDIS_KEY).catch(() => undefined);
    }
  });

  return cachedClient;
}

/**
 * Force re-derivation of CLOB API credentials on next client initialisation.
 * Call this if you suspect stale or revoked credentials.
 */
export async function evictClobCreds(): Promise<void> {
  cachedClient = null;
  try {
    await getRedis().del(CLOB_CREDS_REDIS_KEY);
    logger.info('[clob] API creds evicted from Redis cache');
  } catch {
    // best-effort
  }
}

function orderWithTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`CLOB order timed out after ${CLOB_ORDER_TIMEOUT_MS}ms`)),
      CLOB_ORDER_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function parseOrderResponse(raw: unknown): ClobTradeResult {
  const resp = raw as OrderResponse;

  if (resp.success === false) {
    return {
      success: false,
      error: resp.errorMsg || 'CLOB order rejected',
      raw,
    };
  }

  const txHash = resp.transactionsHashes?.[0];
  const takingAmount = parseFloat(resp.takingAmount);

  return {
    success: true,
    ...(txHash ? { tx_hash: txHash } : {}),
    ...(isFinite(takingAmount) && takingAmount > 0 ? { shares_bought: takingAmount } : {}),
    raw,
  };
}

/**
 * Execute a market BUY on Polymarket CLOB.
 */
export async function submitClobBuy(input: ClobBuyInput): Promise<ClobTradeResult> {
  const cfg = loadConfig();
  if (!cfg.CLOB_FALLBACK_ENABLED) {
    return { success: false, error: 'CLOB fallback disabled (CLOB_FALLBACK_ENABLED=false)' };
  }

  try {
    const client = await getClobClient();

    // Note: POLY_PROXY accounts (sig type 1) do not use the standard ERC20 allowance
    // mechanism — the proxy contract accesses funds directly, bypassing approve().
    // getBalanceAllowance().allowance returns 0 for these accounts even when trading
    // is fully operational. Balance check only: gate on actual USDC balance.
    const bal = await getClobBalance();
    if (bal !== null && bal.balance < input.amountUsd) {
      return {
        success: false,
        error: `Insufficient CLOB balance: ${String(bal.balance)} USDC available, ${String(input.amountUsd)} required`,
      };
    }

    const tickSize = await orderWithTimeout(client.getTickSize(input.tokenId));
    const negRisk = await orderWithTimeout(client.getNegRisk(input.tokenId));

    const resolvedOrderType = input.orderType
      ? (input.orderType === 'FOK' ? OrderType.FOK : OrderType.FAK)
      : (cfg.CLOB_ORDER_TYPE === 'FOK' ? OrderType.FOK : OrderType.FAK);

    const raw = await orderWithTimeout(client.createAndPostMarketOrder(
      {
        tokenID: input.tokenId,
        amount: input.amountUsd,
        side: Side.BUY,
      },
      { tickSize, negRisk },
      resolvedOrderType,
    ));

    return parseOrderResponse(raw);
  } catch (err) {
    return { success: false, error: normaliseError(err) };
  }
}

/**
 * Execute a market SELL on Polymarket CLOB.
 *
 * For SELL orders, `amount` is the number of conditional tokens (shares), not USD.
 */
export async function submitClobSell(input: ClobSellInput): Promise<ClobTradeResult> {
  const cfg = loadConfig();
  if (!cfg.CLOB_FALLBACK_ENABLED) {
    return { success: false, error: 'CLOB fallback disabled (CLOB_FALLBACK_ENABLED=false)' };
  }

  try {
    const client = await getClobClient();

    const tickSize = await orderWithTimeout(client.getTickSize(input.tokenId));
    const negRisk = await orderWithTimeout(client.getNegRisk(input.tokenId));

    const resolvedOrderType = input.orderType
      ? (input.orderType === 'FOK' ? OrderType.FOK : OrderType.FAK)
      : (cfg.CLOB_ORDER_TYPE === 'FOK' ? OrderType.FOK : OrderType.FAK);

    logger.info('[clob] submitting SELL order', {
      tokenId: input.tokenId,
      shares: input.shares,
      orderType: resolvedOrderType,
    });

    const raw = await orderWithTimeout(client.createAndPostMarketOrder(
      {
        tokenID: input.tokenId,
        amount: input.shares,
        side: Side.SELL,
      },
      { tickSize, negRisk },
      resolvedOrderType,
    ));

    return parseOrderResponse(raw);
  } catch (err) {
    return { success: false, error: normaliseError(err) };
  }
}

/**
 * Fetch the USDC balance and allowance for the CLOB wallet.
 *
 * Values are normalised from base units (6 decimals) to whole USDC.
 * Refreshes on-chain allowance state before reading to avoid stale zero.
 *
 * Returns null on failure so callers can degrade gracefully.
 */
export async function getClobBalance(): Promise<{ balance: number; allowance: number } | null> {
  try {
    const client = await getClobClient();
    const typedClient = client as unknown as {
      updateBalanceAllowance(params?: { asset_type?: string }): Promise<void>;
      getBalanceAllowance(params: { asset_type: string }): Promise<{ balance?: string; allowance?: string }>;
    };

    // Refresh on-chain allowance before reading — avoids stale allowance=0.
    await typedClient.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }).catch((err: unknown) => {
      logger.warn('[clob] allowance refresh failed — reading cached value', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const result = await typedClient.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });

    // Values are in USDC base units (6 decimals). Convert to whole USDC.
    const USDC_BASE = CLOB_TOKEN_DIVISOR;
    const balance = parseFloat(result.balance ?? '0') / USDC_BASE;
    const allowance = parseFloat(result.allowance ?? '0') / USDC_BASE;
    if (!isFinite(balance) || !isFinite(allowance)) return null;
    return { balance, allowance };
  } catch {
    return null;
  }
}

// ── On-chain balance & redemption ───────────────────────────────────────────

export type ClobBalanceResult =
  | { ok: true; balance: number }
  | { ok: false; error: string };

/**
 * Fetch the on-chain ERC-1155 token balance for a CLOB outcome token.
 *
 * Tries the user-configured POLYGON_RPC_URL first, then falls back through
 * POLYGON_PUBLIC_RPCS on failure (auth-required, rate-limited, down).
 *
 * Returns a discriminated result so callers can distinguish a genuine zero
 * balance from a fetch error.
 */
export async function fetchClobTokenBalance(tokenId: string): Promise<ClobBalanceResult> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    return { ok: false, error: 'wallet key missing' };
  }

  const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? new Wallet6(cfg.POLYGON_WALLET_PRIVATE_KEY).address;
  const rpcUrls = buildRpcList();

  const ctfAbi = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
  let lastError = '';

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = createProvider(rpcUrl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctf = new Contract(CTF_ADDRESS, ctfAbi, provider) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const rawBalance: bigint = await ctf.balanceOf(funderAddress, tokenId);
      // Convert 6-decimal raw units to human-readable shares (1 share = 1,000,000 raw).
      return { ok: true, balance: Number(rawBalance) / CLOB_TOKEN_DIVISOR };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('[clob] RPC balance fetch failed — trying next', { rpcUrl, tokenId, error: lastError });
    }
  }

  logger.warn('[clob] all RPCs failed for token balance', { tokenId, error: lastError });
  return { ok: false, error: lastError };
}

/**
 * Redeem winning outcome tokens for USDC.e on-chain.
 *
 * Tries the user-configured RPC first, then falls back through public RPCs.
 */
export async function redeemClobOutcome(input: {
  conditionId: string;
  direction: 'YES' | 'NO';
}): Promise<ClobTradeResult> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    return { success: false, error: 'POLYGON_WALLET_PRIVATE_KEY required' };
  }

  const CTF_REDEEM_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  ];

  const rpcUrls = buildRpcList();
  const indexSets = input.direction === 'YES' ? [1] : [2];
  let lastError = '';

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = createProvider(rpcUrl);
      const signer = new Wallet6(cfg.POLYGON_WALLET_PRIVATE_KEY, provider);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctf = new Contract(CTF_ADDRESS, CTF_REDEEM_ABI, signer) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const tx = await ctf.redeemPositions(
        USDC_E_ADDRESS,
        '0x0000000000000000000000000000000000000000000000000000000000000000',
        input.conditionId,
        indexSets,
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const receipt = await tx.wait();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      return { success: true, tx_hash: receipt?.hash ?? undefined, raw: receipt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('[clob] RPC redemption failed — trying next', { rpcUrl, conditionId: input.conditionId, error: lastError });
    }
  }

  logger.error('[clob] all RPCs failed for redemption', { conditionId: input.conditionId, error: lastError });
  return { success: false, error: lastError };
}
