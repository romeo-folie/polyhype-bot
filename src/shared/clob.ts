/**
 * Polymarket CLOB execution client.
 *
 * Used as fallback when a signal market is not available in Simmer's catalogue.
 * Trades are signed locally with POLYGON_WALLET_PRIVATE_KEY.
 */

import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { loadConfig } from './config.js';

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

export interface ClobTradeResult {
  success: boolean;
  tx_hash?: string;
  shares_bought?: number;
  error?: string;
  raw?: unknown;
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

function extractTxHash(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const candidates = [obj['tx_hash'], obj['txHash'], obj['orderID'], obj['orderId'], obj['id']];
  for (const value of candidates) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function extractShares(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const candidates = [obj['size_matched'], obj['sizeMatched'], obj['filled_size'], obj['size']];
  for (const value of candidates) {
    if (typeof value === 'number' && isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = parseFloat(value);
      if (isFinite(parsed)) return parsed;
    }
  }
  return undefined;
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

    // Wrap the entire order submission in a timeout to prevent hung connections
    // from keeping the cron process alive indefinitely (SDK has no built-in timeout).
    // The timer is cleared in .finally() so it never leaks regardless of outcome.
    const orderWithTimeout = <T>(promise: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`CLOB order timed out after ${CLOB_ORDER_TIMEOUT_MS}ms`)),
          CLOB_ORDER_TIMEOUT_MS,
        );
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    };

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

    if (raw && typeof raw === 'object' && 'error' in (raw as Record<string, unknown>)) {
      const error = (raw as Record<string, unknown>)['error'];
      if (typeof error === 'string' && error.length > 0) {
        return { success: false, error, raw };
      }
    }

    const txHash = extractTxHash(raw);
    const sharesBought = extractShares(raw);

    return {
      success: true,
      ...(txHash ? { tx_hash: txHash } : {}),
      ...(sharesBought !== undefined ? { shares_bought: sharesBought } : {}),
      raw,
    };
  } catch (err) {
    return { success: false, error: normaliseError(err) };
  }
}
