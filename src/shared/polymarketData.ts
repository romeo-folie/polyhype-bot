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

  // The Data API caps each /positions response at a page limit (exactly 100
  // when `limit` is omitted; up to ≥500 when set). A wallet with more positions
  // than one page is silently TRUNCATED otherwise — and any open position that
  // falls off the page becomes invisible to the reconciler, which then leans on
  // a flaky per-token on-chain balance check and can FALSE-GHOST a position we
  // still hold (observed 2026-06: a finals pair leg was deleted from the ledger
  // while the tokens remained on-chain, because ~96 settled-but-unredeemed
  // positions filled the entire first page). Paginate to exhaustion.
  const PAGE_SIZE = 500;
  const MAX_PAGES = 20; // 10k-position runaway backstop — never hit in practice
  const all: PolymarketPosition[] = [];
  let offset = 0;
  let page = 0;
  let truncated = false;

  for (; page < MAX_PAGES; page++) {
    const url = `https://data-api.polymarket.com/positions?user=${address}&limit=${PAGE_SIZE}&offset=${offset}`;
    try {
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const body = await resp.text();
        logger.warn('[polymarket-data] Data API returned error', { status: resp.status, body: body.slice(0, 200), offset });
        // Partial snapshot. Absence from a SHORT list is not proof a position
        // is gone — the reconciler confirms every ghost via an on-chain balance
        // read before deleting, so a truncated list cannot cause a false close.
        truncated = true;
        break;
      }

      const data = await resp.json();
      if (!Array.isArray(data)) {
        logger.warn('[polymarket-data] Data API returned unexpected format', { offset });
        truncated = true;
        break;
      }

      const rows = data as PolymarketPosition[];
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break; // last (partial) page reached
      offset += rows.length;
    } catch (err) {
      logger.error('[polymarket-data] fetch failed', { error: err instanceof Error ? err.message : String(err), offset });
      truncated = true;
      break;
    }
  }

  if (page >= MAX_PAGES || truncated) {
    logger.warn('[polymarket-data] position snapshot may be incomplete', {
      collected: all.length,
      hitPageCap: page >= MAX_PAGES,
      truncated,
    });
  }

  // Invariant the reconciler depends on: a FIRST-page failure must surface as
  // an empty list, so the caller's empty-snapshot abort guard fires instead of
  // treating an outage as "wallet holds nothing" (which would ghost every
  // position). A later-page failure returns a non-empty partial — safe, because
  // the reconciler confirms each ghost on-chain before deleting. Made explicit
  // so a future change that pre-seeds `all` can't silently break it.
  if (truncated && all.length === 0) {
    logger.warn('[polymarket-data] first-page fetch failed — returning empty so the caller aborts (no ghosting)');
    return [];
  }

  logger.info('[polymarket-data] fetched positions from Data API', { address, count: all.length });
  return all;
}
