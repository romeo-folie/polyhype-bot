/**
 * Polymarket CLOB execution client.
 *
 * Used as fallback when a signal market is not available in Simmer's catalogue.
 * Trades are signed locally with POLYGON_WALLET_PRIVATE_KEY.
 */

import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client';
import { Wallet, Contract, Interface, JsonRpcProvider } from 'ethers';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { getRedis } from './redis.js';
import type { ApiKeyCreds } from '@polymarket/clob-client';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
// Hard timeout for CLOB order submission. The SDK has no built-in timeout;
// without this a hung connection would keep the cron process alive indefinitely.
const CLOB_ORDER_TIMEOUT_MS = 30_000;

const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address refundReceiver, bytes calldata signatures) external returns (bool success)',
  'function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address refundReceiver, uint256 _nonce) public view returns (bytes32)',
  'function nonce() public view returns (uint256)',
];

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
  tx_hash?: string | undefined;
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

function normaliseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (signer as any)._signTypedData = signer.signTypedData.bind(signer);

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
  const resp = raw as OrderResponse;

  if (!resp.success) {
    return {
      success: false,
      error: resp.errorMsg || 'CLOB order rejected',
      raw,
    };
  }

  const txHash = resp.transactionsHashes[0];
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

  try {
    const provider = new JsonRpcProvider('https://polygon-rpc.com');
    const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY, provider);
    const sigType = cfg.POLYMARKET_SIGNATURE_TYPE;
    const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;

    const ctfInterface = new Interface(CTF_ABI);
    const indexSets = input.direction === 'YES' ? [1] : [2];
    const data = ctfInterface.encodeFunctionData('redeemPositions', [
      USDC_E_ADDRESS,
      '0x0000000000000000000000000000000000000000000000000000000000000000',
      input.conditionId,
      indexSets,
    ]);

    if (sigType === 1) {
      // Proxy/Gnosis Safe logic
      logger.info('[clob] executing redemption via Proxy wallet', {
        funderAddress,
        conditionId: input.conditionId,
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const safe = new Contract(funderAddress, SAFE_ABI, signer) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const nonce = await safe.nonce();

      // Sign the transaction following Gnosis Safe specs
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const safeTxHash: string = await safe.getTransactionHash(
        CTF_ADDRESS,
        0, // value
        data,
        0, // operation: Call
        0, // safeTxGas
        0, // baseGas
        0, // gasPrice
        '0x0000000000000000000000000000000000000000', // refundReceiver
        nonce,
      );

      // Sign the transaction following Gnosis Safe specs.
      // NOTE: This implementation assumes Gnosis Safe v1.1.1 or v1.3.0 with standard EOA signing.
      // It uses the (v + 4) suffix which is a required Gnosis-specific trick for EOA signatures
      // to distinguish them from other signature types in the Safe's internal signature validator.
      const sig = signer.signingKey.sign(safeTxHash);
      // Strip 0x prefix from r and s before concatenation.
      // sig.r and sig.s include the leading 0x — concatenating without stripping
      // produces a malformed 132-byte signature instead of the expected 65 bytes.
      const r = sig.r.slice(2);
      const s = sig.s.slice(2);
      const v = sig.v + 4;
      const safeSignature = '0x' + r + s + v.toString(16).padStart(2, '0');

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const tx = await safe.execTransaction(
        CTF_ADDRESS,
        0,
        data,
        0,
        0,
        0,
        0,
        '0x0000000000000000000000000000000000000000',
        safeSignature,
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const receipt = await tx.wait();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      return { success: true, tx_hash: receipt?.hash ?? undefined, raw: receipt };
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
  } catch (err) {
    logger.error('[clob] redemption failed', {
      error: err instanceof Error ? err.message : String(err),
      conditionId: input.conditionId,
    });
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
