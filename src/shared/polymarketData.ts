import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { Wallet } from 'ethers';

export interface PolymarketPosition {
  asset: string;
  avgPrice: number;
  size: number;
  conditionId: string;
  currentValue: number;
  proxy?: boolean;
}

/**
 * Fetch ground-truth positions and average entry prices from the Polymarket Data API.
 * 
 * Endpoint: https://data-api.polymarket.com/positions?user=${wallet}
 * This is the only source that reliably provides 'avgPrice' for CLOB positions.
 */
export async function fetchPolymarketPositions(walletAddress?: string): Promise<PolymarketPosition[]> {
  const cfg = loadConfig();
  let address = walletAddress ?? cfg.POLYMARKET_FUNDER_ADDRESS;

  if (!address && cfg.POLYGON_WALLET_PRIVATE_KEY) {
    try {
      const wallet = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY);
      address = wallet.address;
    } catch (err) {
      logger.warn('[polymarket-data] failed to derive address from private key', { error: String(err) });
    }
  }

  if (!address) {
    logger.warn('[polymarket-data] no wallet address or private key configured — skipping fetch');
    return [];
  }

  const url = `https://data-api.polymarket.com/positions?user=${address}`;
  logger.info('[polymarket-data] fetching positions from Data API', { address, url });

  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      logger.warn('[polymarket-data] Data API returned error', { status: resp.status, body: body.slice(0, 200) });
      return [];
    }

    const data = await resp.json();
    if (!Array.isArray(data)) {
      logger.warn('[polymarket-data] Data API returned unexpected format', { data });
      return [];
    }

    return data as PolymarketPosition[];
  } catch (err) {
    logger.error('[polymarket-data] fetch failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
