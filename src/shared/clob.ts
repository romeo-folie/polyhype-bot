/**
 * Polymarket CLOB execution client.
 *
 * Used as fallback when a signal market is not available in Simmer's catalogue.
 * Trades are signed locally with POLYGON_WALLET_PRIVATE_KEY.
 */

/**
 * ethers v5 ↔ v6 bridge note:
 *
 * The project uses ethers v6, but @polymarket/clob-client expects an ethers v5
 * Wallet (specifically the `_signTypedData` method). ethers v6 renamed this to
 * `signTypedData`. We create a v6 Wallet and patch `_signTypedData` onto it in
 * getClobClient() to satisfy the SDK's interface without downgrading ethers.
 *
 * @ethersproject/wallet (v5) is retained as a direct dependency because
 * src/shared/clobProbe.ts still imports it for Simmer's signing flow.
 * It can be removed once clobProbe.ts is migrated to ethers v6.
 */

import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client';
import type { OrderBookSummary, OpenOrder, TickSize } from '@polymarket/clob-client';
import { Wallet, Contract, Interface, JsonRpcProvider, Network, FetchRequest } from 'ethers';
import { loadConfig, CTF_ADDRESS, USDC_E_ADDRESS, POLYGON_FALLBACK_RPCS } from './config.js';
import { logger } from './logger.js';
import { getRedis } from './redis.js';
import type { ApiKeyCreds } from '@polymarket/clob-client';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
// Hard timeout for CLOB order submission. The SDK has no built-in timeout;
// without this a hung connection would keep the cron process alive indefinitely.
const CLOB_ORDER_TIMEOUT_MS = 30_000;
/** Polymarket CLOB protocol minimum — orders below this are rejected with "not enough balance / order amount". */
export const CLOB_MIN_ORDER_USD = 1.0;

// Cached Polygon provider — reused across fetchClobTokenBalance and redeemClobOutcome
// calls to avoid spinning up a new JsonRpcProvider per invocation.
let _polygonProvider: JsonRpcProvider | null = null;
let _polygonProviderRpcUrl: string | null = null;

/** Per-RPC timeout — bounds total failover to ~40s for 4 RPCs. */
const RPC_TIMEOUT_MS = 10_000;

export function getPolygonProvider(rpcUrl: string): JsonRpcProvider {
  if (!_polygonProvider || _polygonProviderRpcUrl !== rpcUrl) {
    // Pass staticNetwork to skip ethers v6 auto-detection — without this, a slow or
    // temporarily unreachable RPC causes JsonRpcProvider to spin in an infinite 1s
    // retry loop that never resolves and keeps the process alive forever.
    // FetchRequest timeout caps each RPC call to 10s.
    const polygonNetwork = new Network('matic', 137);
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = RPC_TIMEOUT_MS;
    _polygonProvider = new JsonRpcProvider(fetchReq, polygonNetwork, { staticNetwork: polygonNetwork });
    _polygonProviderRpcUrl = rpcUrl;
  }
  return _polygonProvider;
}

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

/**
 * Polymarket ProxyWalletFactory — deployed at a fixed address on Polygon mainnet.
 * All sigType=1 (Polymarket Magic proxy wallet) transactions are routed through this
 * factory, which forwards calls to the user's EIP-1167 proxy wallet.
 *
 * ABI reverse-engineered from on-chain txs: selector 0x34ee9791 =
 *   proxy((bool delegateCall, address to, uint256 value, bytes data)[] calls)
 *
 * The factory verifies the caller owns the proxy and executes the ProxyCalls.
 * delegateCall=true is used in all observed Polymarket redemption transactions.
 */
const PROXY_WALLET_FACTORY_ADDRESS = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const PROXY_WALLET_FACTORY_ABI = [
  'function proxy((bool delegateCall, address to, uint256 value, bytes data)[] calls) external payable',
];

export interface ClobBuyInput {
  tokenId: string;
  amountUsd: number;
  /** Override order type. Defaults to CLOB_ORDER_TYPE config. Use FOK for arb legs. */
  orderType?: 'FOK' | 'FAK';
}

export interface ClobLimitBuyInput {
  tokenId: string;
  price: number;
  size: number;
  tickSize: TickSize;
  negRisk: boolean;
  orderType?: 'GTC';
  postOnly?: boolean;
}

export interface ClobSellInput {
  tokenId: string;
  /** Number of conditional tokens to sell */
  shares: number;
  orderType?: 'FOK' | 'FAK';
}

export interface ClobTradeResult {
  success: boolean;
  tx_hash?: string | undefined;
  shares_bought?: number;
  price?: number;
  cost?: number;
  order_id?: string | undefined;
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

const USDC_RAW_RE = /balance:\s*(\d+),\s*order amount:\s*(\d+)/i;

/** Force provider reset — called when the current RPC fails. */
export function resetPolygonProvider(): void {
  _polygonProvider = null;
  _polygonProviderRpcUrl = null;
}

/**
 * Build an ordered RPC URL list: user-configured first, then public fallbacks (deduped).
 */
function buildRpcList(): string[] {
  const userRpc = loadConfig().POLYGON_RPC_URL;
  const rpcUrls: string[] = [];
  if (userRpc) rpcUrls.push(userRpc);
  for (const rpc of POLYGON_FALLBACK_RPCS) {
    if (!rpcUrls.includes(rpc)) rpcUrls.push(rpc);
  }
  return rpcUrls;
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
  const match = USDC_RAW_RE.exec(errorMsg);
  if (!match?.[1]) return null;
  const rawBalance = parseInt(match[1], 10);
  if (!isFinite(rawBalance) || rawBalance < 0) return null;
  return rawBalance / 1_000_000;
}

function normaliseError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // CLOB API returns raw 6-decimal USDC values in error messages (e.g. "balance: 4922880, order amount: 5000000").
  // Translate them to human-readable USDC so logs are not misleading.
  return msg.replace(USDC_RAW_RE, (_match, bal: string, amt: string) => {
    const balUsdc = (parseInt(bal, 10) / 1_000_000).toFixed(2);
    const amtUsdc = (parseInt(amt, 10) / 1_000_000).toFixed(2);
    return `balance: $${balUsdc}, order amount: $${amtUsdc}`;
  });
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

    // @polymarket/clob-client detects ethers signers via `typeof signer._signTypedData === "function"`.
    // In ethers v6, `_signTypedData` was renamed to `signTypedData` (no underscore). Patch it back
    // so the SDK's signer detector works correctly for both order placement and SELL signing.
    // Without this, the SDK falls through to the viem walletClient path and throws
    // "wallet client is missing account address".
    //
    // Robustness: verify the source method exists before patching. If a future ethers
    // version removes `signTypedData`, fail loudly here rather than silently passing a
    // broken signer that would produce invalid signatures at trade time.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const signerAny = signer as any;
    if (typeof signerAny._signTypedData !== 'function') {
      if (typeof signer.signTypedData !== 'function') {
        throw new Error(
          'ethers Wallet has neither _signTypedData nor signTypedData — ' +
          'incompatible ethers version; check @polymarket/clob-client peer deps',
        );
      }
      signerAny._signTypedData = signer.signTypedData.bind(signer);
    }

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
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
        signer as any, // TODO: Replace with proper SignerV6 interface when SDK is updated
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
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      signer as any, // TODO: Replace with proper SignerV6 interface when SDK is updated
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
      () => { reject(new Error(`CLOB order timed out after ${String(CLOB_ORDER_TIMEOUT_MS)}ms`)); },
      CLOB_ORDER_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => { clearTimeout(timer); });
}

function parseOrderResponse(raw: unknown): ClobTradeResult {
  if (raw == null || typeof raw !== 'object') {
    return { success: false, error: `CLOB returned unexpected response: ${JSON.stringify(raw)}`, raw };
  }

  const resp = raw as OrderResponse;

  if (!resp.success) {
    return {
      success: false,
      error: resp.errorMsg || 'CLOB order rejected',
      raw,
    };
  }

  const txHash = Array.isArray(resp.transactionsHashes) ? resp.transactionsHashes[0] : undefined;
  const takingAmount = parseFloat(resp.takingAmount);
  const makingAmount = parseFloat(resp.makingAmount);
  const price = takingAmount > 0 ? makingAmount / takingAmount : undefined;

  return {
    success: true,
    ...(txHash ? { tx_hash: txHash } : {}),
    ...(resp.orderID ? { order_id: resp.orderID } : {}),
    ...(isFinite(takingAmount) && takingAmount > 0 ? { shares_bought: takingAmount } : {}),
    ...(price !== undefined && isFinite(price) ? { price } : {}),
    ...(isFinite(makingAmount) && makingAmount > 0 ? { cost: makingAmount } : {}),
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
    if (input.amountUsd < CLOB_MIN_ORDER_USD) {
      return {
        success: false,
        error: `CLOB order below minimum size: ${String(input.amountUsd)} USDC < ${String(CLOB_MIN_ORDER_USD)} USDC minimum`,
      };
    }

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

    const raw: unknown = await orderWithTimeout(client.createAndPostMarketOrder(
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
 * Fetch the current CLOB order book for a given token.
 */
export async function getClobOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
  try {
    const client = await getClobClient();
    const book = await orderWithTimeout(client.getOrderBook(tokenId));
    return book ?? null;
  } catch (err) {
    logger.warn('[clob] failed to fetch order book', {
      tokenId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Submit a post-only limit buy on the CLOB.
 */
export async function submitClobLimitBuy(input: ClobLimitBuyInput): Promise<ClobTradeResult> {
  const cfg = loadConfig();
  if (!cfg.CLOB_FALLBACK_ENABLED) {
    return { success: false, error: 'CLOB fallback disabled (CLOB_FALLBACK_ENABLED=false)' };
  }

  try {
    const client = await getClobClient();
    const raw: unknown = await orderWithTimeout(client.createAndPostOrder(
      {
        tokenID: input.tokenId,
        price: input.price,
        side: Side.BUY,
        size: input.size,
      },
      { tickSize: input.tickSize, negRisk: input.negRisk },
      OrderType.GTC,
      false,
      input.postOnly ?? false,
    ));

    return parseOrderResponse(raw);
  } catch (err) {
    return { success: false, error: normaliseError(err) };
  }
}

/**
 * Fetch a specific CLOB order by ID.
 */
export async function getClobOrder(orderId: string): Promise<OpenOrder | null> {
  try {
    const client = await getClobClient();
    const order = await orderWithTimeout(client.getOrder(orderId));
    return order ?? null;
  } catch (err) {
    logger.warn('[clob] failed to fetch order', { orderId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/**
 * Cancel a CLOB order by ID.
 */
export async function cancelClobOrder(orderId: string): Promise<boolean> {
  try {
    const client = await getClobClient();
    await orderWithTimeout(client.cancelOrder({ orderID: orderId }));
    return true;
  } catch (err) {
    logger.warn('[clob] failed to cancel order', { orderId, error: err instanceof Error ? err.message : String(err) });
    return false;
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

    const raw: unknown = await orderWithTimeout(client.createAndPostMarketOrder(
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
    const USDC_BASE = 1_000_000;
    const balance = parseFloat(result.balance ?? '0') / USDC_BASE;
    const allowance = parseFloat(result.allowance ?? '0') / USDC_BASE;
    if (!isFinite(balance) || !isFinite(allowance)) return null;
    return { balance, allowance };
  } catch {
    return null;
  }
}

/**
 * Fetch actual on-chain ERC-1155 balance for a CLOB token.
 * Used to sync sharesToSell against the real fill amount (Redis records order size, not fill size).
 */
export type ClobBalanceResult =
  | { ok: true; balance: number }
  | { ok: false; error: string };

/**
 * Fetch the on-chain ERC-1155 token balance for a CLOB outcome token.
 *
 * Returns a discriminated result so callers can distinguish a genuine zero
 * balance (ok:true, balance:0) from a fetch error (ok:false) — these require
 * different handling: zero balance triggers ghost cleanup, errors should degrade
 * gracefully without touching the ledger.
 */
export async function fetchClobTokenBalance(tokenId: string): Promise<ClobBalanceResult> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    return { ok: false, error: 'wallet key missing' };
  }

  const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY).address;
  const rpcUrls = buildRpcList();
  const ctfAbi = ['function balanceOf(address account, uint256 id) view returns (uint256)'];
  let lastError = '';

  for (const rpcUrl of rpcUrls) {
    try {
      const provider = getPolygonProvider(rpcUrl);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctf = new Contract(CTF_ADDRESS, ctfAbi, provider) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const balance: bigint = await ctf.balanceOf(funderAddress, tokenId);
      // Polymarket conditional tokens use 6 decimal places (CONDITIONAL_TOKEN_DECIMALS = 6).
      // balanceOf() returns raw ERC-1155 units — divide by 1e6 to get human-readable shares.
      return { ok: true, balance: Number(balance) / 1_000_000 };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('[clob] RPC balance fetch failed — trying next', { rpcUrl, tokenId, error: lastError });
      resetPolygonProvider();
    }
  }

  logger.warn('[clob] all RPCs failed for token balance', { tokenId, error: lastError });
  return { ok: false, error: lastError };
}

/**
 * Redeem winning outcome tokens for USDC.e on-chain.
 *
 * Supports both standard EOA wallets (sigType 0) and Proxy/Gnosis Safe wallets (sigType 1).
 */
export async function redeemClobOutcome(input: {
  conditionId: string;
  direction: 'YES' | 'NO';
}): Promise<ClobTradeResult> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    return { success: false, error: 'POLYGON_WALLET_PRIVATE_KEY required' };
  }

  const rpcUrls = buildRpcList();
  let lastError = '';

  for (const rpcUrl of rpcUrls) {
    try {
      const result = await redeemClobOutcomeWithRpc(input, cfg, rpcUrl);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn('[clob] RPC redemption failed — trying next', { rpcUrl, conditionId: input.conditionId, error: lastError });
      resetPolygonProvider();
    }
  }

  logger.error('[clob] all RPCs failed for redemption', { conditionId: input.conditionId, error: lastError });
  return { success: false, error: lastError };
}

async function redeemClobOutcomeWithRpc(
  input: { conditionId: string; direction: 'YES' | 'NO' },
  cfg: ReturnType<typeof loadConfig>,
  rpcUrl: string,
): Promise<ClobTradeResult> {
  const provider = getPolygonProvider(rpcUrl);
  const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY!, provider);
  const sigType = cfg.POLYMARKET_SIGNATURE_TYPE;
  const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;

  const ctfInterface = new Interface(CTF_ABI);
  // Pass both indexSets [1, 2] — the CTF contract redeems whichever outcome tokens
  // the wallet actually holds (i.e. the winning side). Using both avoids needing to
  // know which specific index won; the contract ignores zero-balance outcomes.
  const data = ctfInterface.encodeFunctionData('redeemPositions', [
    USDC_E_ADDRESS,
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    input.conditionId,
    [1, 2],
  ]);

  if (sigType === 1) {
    // Polymarket Magic Proxy Wallet — redemptions go through the Builder Relayer.
    // API: POST https://relayer-v2.polymarket.com/submit
    // Auth: RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS headers (simplest path)
    //    or Builder API Key HMAC headers (POLY_BUILDER_* headers)
    // Signing: GSN-style struct hash over (from, to, data, txFee, gasPrice, gasLimit, nonce, relayHub, relay)

    const hasRelayerKey = cfg.POLYMARKET_RELAYER_API_KEY && cfg.POLYMARKET_RELAYER_API_KEY_ADDRESS;
    const hasBuilderKey = cfg.POLYMARKET_BUILDER_API_KEY && cfg.POLYMARKET_BUILDER_SECRET && cfg.POLYMARKET_BUILDER_PASSPHRASE;

    if (!hasRelayerKey && !hasBuilderKey) {
      logger.warn('[clob] sigType=1: no relayer or builder credentials configured — manual redemption required', {
        conditionId: input.conditionId,
        instruction: 'Set POLYMARKET_RELAYER_API_KEY + POLYMARKET_RELAYER_API_KEY_ADDRESS in .env',
      });
      return { success: false, error: 'MAGIC_PROXY_MANUAL_REDEEM_REQUIRED' };
    }

    const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { createWalletClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');

    const relayerUrl = cfg.POLYMARKET_RELAYER_URL ?? 'https://relayer-v2.polymarket.com';
    const account = privateKeyToAccount(cfg.POLYGON_WALLET_PRIVATE_KEY! as `0x${string}`);
    const wallet = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

    // Build BuilderConfig only if builder keys are present
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let builderConfig: any = undefined;
    if (hasBuilderKey) {
      const { BuilderConfig } = await import('@polymarket/builder-relayer-client/node_modules/@polymarket/builder-signing-sdk/dist/index.js' as string);
      builderConfig = new BuilderConfig({
        localBuilderCreds: {
          key: cfg.POLYMARKET_BUILDER_API_KEY!,
          secret: cfg.POLYMARKET_BUILDER_SECRET!,
          passphrase: cfg.POLYMARKET_BUILDER_PASSPHRASE!,
        },
      });
    }

    // When using Relayer API Key auth, patch the httpClient to inject the headers.
    // The RelayClient uses builderConfig for auth; for relayer key auth we override
    // the send method to inject RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS headers.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    const relayClient = new RelayClient(relayerUrl, 137, wallet as any, builderConfig, RelayerTxType.PROXY);

    if (hasRelayerKey && !hasBuilderKey) {
      // Monkey-patch: inject relayer key headers into every request
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const originalSend = (relayClient as any).httpClient.send.bind((relayClient as any).httpClient);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (relayClient as any).httpClient.send = async (url: string, method: string, options: any) => {
        options = options ?? {};
        options.headers = {
          ...(options.headers ?? {}),
          'RELAYER_API_KEY': cfg.POLYMARKET_RELAYER_API_KEY!,
          'RELAYER_API_KEY_ADDRESS': cfg.POLYMARKET_RELAYER_API_KEY_ADDRESS!,
        };
        return originalSend(url, method, options);
      };
    }

    logger.info('[clob] executing redemption via Polymarket Relayer (sigType=1)', {
      conditionId: input.conditionId,
      funderAddress,
      relayerUrl,
      authType: hasRelayerKey ? 'relayer-key' : 'builder-key',
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const response = await relayClient.execute([{ to: CTF_ADDRESS as `0x${string}`, data, value: '0' }]);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const txHash: string | undefined = (response as any).transactionHash ?? undefined;

    logger.info('[clob] Relayer redemption submitted', {
      conditionId: input.conditionId,
      txHash,
    });

    return { success: true, ...(txHash ? { tx_hash: txHash } : {}), raw: response };
  } else {
    // Standard EOA logic
    logger.info('[clob] executing redemption via EOA wallet', {
      conditionId: input.conditionId,
      address: signer.address,
    });
    const tx = await signer.sendTransaction({
      to: CTF_ADDRESS,
      data,
    });
    const receipt = await tx.wait();
    return { success: true, tx_hash: receipt?.hash ?? undefined, raw: receipt };
  }
}
