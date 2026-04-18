/**
 * Residual sweep — safety net for dust / partial-fill residuals left on open
 * positions. Runs on a schedule (cron). By default it's a dry run; pass
 * --execute to actually mark dust positions pendingSettlement.
 *
 * What it does:
 * 1. Loads every open position from the Redis ledger.
 * 2. For CLOB positions, fetches the real on-chain ERC-1155 balance.
 * 3. Cross-references Redis sharesHeld vs on-chain balance.
 * 4. If the live shares * currentPrice (proxied by entryPrice) is below the
 *    configured minimum notional, marks the position pendingSettlement so the
 *    resolution redeemer handles it at settlement instead of retrying forever.
 *
 * This is a *passive* cleanup. The primary sweep happens synchronously inside
 * takeProfitExecutor on detected partial fills (Change 2). This script exists
 * only to catch drift that slipped through (crashed workers, pre-Change-2
 * positions, etc.).
 *
 * Usage:
 *   npx tsx scripts/sweep-residuals.ts           # dry-run
 *   npx tsx scripts/sweep-residuals.ts --execute # actually mutate Redis
 */
import 'dotenv/config';
import { getRedis, closeRedis } from '../src/shared/redis.js';
import { getOpenPositions, markPositionPendingSettlement } from '../src/execution/positionLedger.js';
import { fetchClobTokenBalance, getClobOrderBook, CLOB_MIN_ORDER_USD } from '../src/shared/clob.js';
import { loadConfig } from '../src/shared/config.js';
import { logger } from '../src/shared/logger.js';

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute');
  const cfg = loadConfig();
  const redis = getRedis();

  const positions = await getOpenPositions(redis);
  const open = positions.filter((p) => !p.pendingSettlement && !p.synthHedged);

  let scanned = 0;
  let flagged = 0;
  let mutated = 0;

  for (const pos of open) {
    scanned++;
    const venue = pos.executionVenue ?? 'simmer';
    if (venue !== 'clob') continue;
    if (!pos.clobTokenIds || pos.clobTokenIds.length === 0) continue;

    const tokenId =
      pos.direction === 'YES' || pos.direction === 'UP'
        ? pos.clobTokenIds[0]
        : pos.clobTokenIds[1];
    if (!tokenId) continue;

    const bal = await fetchClobTokenBalance(tokenId);
    if (!bal.ok) {
      logger.warn('[sweep-residuals] balance fetch failed', {
        marketId: pos.marketId,
        error: bal.error,
      });
      continue;
    }

    // Fetch live best bid for an accurate notional. Using entryPrice was wrong for
    // prediction markets — a position entered at 8¢ can trade at 99¢ minutes later,
    // making the entry-price notional a massive underestimate that incorrectly
    // triggers pendingSettlement on perfectly healthy positions.
    const book = await getClobOrderBook(tokenId);
    const bestBid = parseFloat(book?.bids[0]?.price ?? '0');
    const currentPrice = bestBid > 0 ? bestBid : pos.entryPrice;
    if (bestBid === 0) {
      logger.warn('[sweep-residuals] no live bid available, falling back to entryPrice', {
        marketId: pos.marketId,
        entryPrice: pos.entryPrice,
      });
    }
    const notional = bal.balance * currentPrice;
    const ledgerShares = pos.sharesHeld ?? 0;
    const drift = Math.abs(ledgerShares - bal.balance);

    if (bal.balance <= 0.001) {
      flagged++;
      logger.info('[sweep-residuals] zero on-chain balance for open position', {
        marketId: pos.marketId,
        direction: pos.direction,
        ledgerShares,
        execute,
      });
      if (execute) {
        await markPositionPendingSettlement(redis, pos.marketId, pos.direction);
        mutated++;
      }
      continue;
    }

    if (notional > 0 && notional < Math.max(cfg.RESIDUAL_SWEEP_MIN_NOTIONAL_USD, CLOB_MIN_ORDER_USD)) {
      flagged++;
      logger.info('[sweep-residuals] dust residual below min notional', {
        marketId: pos.marketId,
        direction: pos.direction,
        onChain: bal.balance.toFixed(6),
        ledgerShares: ledgerShares.toFixed(6),
        drift: drift.toFixed(6),
        currentPrice: currentPrice.toFixed(4),
        notional: notional.toFixed(4),
        execute,
      });
      if (execute) {
        await markPositionPendingSettlement(redis, pos.marketId, pos.direction);
        mutated++;
      }
    }
  }

  logger.info('[sweep-residuals] done', { scanned, flagged, mutated, execute });
  await closeRedis();
}

main().catch((err) => {
  logger.error('[sweep-residuals] fatal', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
