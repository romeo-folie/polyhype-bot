/**
 * Polymarket CLOB execution client.
 *
 * Used as fallback when a signal market is not available in Simmer's catalogue.
 * Trades are signed locally with POLYGON_WALLET_PRIVATE_KEY.
 */

import { ClobClient, OrderType, Side, AssetType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;
// Hard timeout for CLOB order submission. The SDK has no built-in timeout;
// without this a hung connection would keep the cron process alive indefinitely.
const CLOB_ORDER_TIMEOUT_MS = 30_000;

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

function normaliseError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function getClobClient(): Promise<ClobClient> {
  if (cachedClient) return cachedClient;

  const initPromise = (async () => {
    const cfg = loadConfig();

    if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
      throw new Error('POLYGON_WALLET_PRIVATE_KEY is required for CLOB fallback execution');
    }

    const signer = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
    const bootstrap = new ClobClient(CLOB_HOST, POLYGON_CHAIN_ID, signer);
    const creds = await bootstrap.createOrDeriveApiKey();

    const funderAddress = cfg.POLYMARKET_FUNDER_ADDRESS ?? signer.address;
    return new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      signer,
      creds,
      cfg.POLYMARKET_SIGNATURE_TYPE,
      funderAddress,
    );
  })();

  cachedClient = initPromise;

  // Clear the cached promise on rejection so the next call retries fresh
  // instead of returning the same rejected promise forever.
  initPromise.catch(() => {
    if (cachedClient === initPromise) {
      cachedClient = null;
    }
  });

  return cachedClient;
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

    // Allowance preflight
    const bal = await getClobBalance();
    if (bal !== null && bal.allowance < input.amountUsd) {
      return {
        success: false,
        error: `Insufficient CLOB allowance: ${String(bal.allowance)} USDC available, ${String(input.amountUsd)} required`,
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
 * Fetch the raw USDC balance and allowance for the CLOB wallet.
 *
 * Returns both values separately for probe and preflight use.
 * Not included in global bankroll — CLOB capital is validated at order time.
 *
 * Returns null on failure so callers can degrade gracefully.
 */
export async function getClobBalance(): Promise<{ balance: number; allowance: number } | null> {
  try {
    const client = await getClobClient();
    const result = await (client as unknown as {
      getBalanceAllowance(params: { asset_type: string }): Promise<{ balance?: string; allowance?: string }>;
    }).getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const balance = parseFloat(result.balance ?? '0');
    const allowance = parseFloat(result.allowance ?? '0');
    if (!isFinite(balance) || !isFinite(allowance)) return null;
    return { balance, allowance };
  } catch {
    return null;
  }
}
