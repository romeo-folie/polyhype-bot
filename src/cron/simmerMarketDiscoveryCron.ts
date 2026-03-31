/**
 * Simmer market discovery cron.
 *
 * Discovers markets not yet imported to Simmer and imports them.
 * Runs every 30 minutes to populate Simmer's market catalog with high-volume
 * Polymarket markets for enriched trading (divergence scores, tags, internal IDs).
 *
 * Schedule: every 30 minutes (cron: * /30 * * * *)
 */

import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { discoverUnimportedMarkets, importMarket } from '../shared/simmerImport.js';

const MAX_IMPORTS_PER_RUN = 20; // Rate limit: import at most 20 markets per run
const IMPORT_DELAY_MS = 1_000; // 1s delay between imports to avoid rate limit issues

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.SIMMER_AUTO_IMPORT_ENABLED) {
    logger.info('[simmer-discovery] auto-import disabled — skipping');
    return;
  }

  logger.info('[simmer-discovery] starting market discovery');

  const discovered = await discoverUnimportedMarkets({ limit: 50 });

  if (discovered.length === 0) {
    logger.info('[simmer-discovery] no markets to import');
    return;
  }

  logger.info('[simmer-discovery] discovered markets', { count: discovered.length });

  const toImport = discovered.slice(0, MAX_IMPORTS_PER_RUN);
  let imported = 0;
  let alreadyImported = 0;
  let failed = 0;

  for (const market of toImport) {
    if (!market.polymarket_url) {
      logger.warn('[simmer-discovery] skipping market without URL', { market });
      failed++;
      continue;
    }

    // Rate limit: delay between imports
    if (imported > 0 || alreadyImported > 0) {
      await sleep(IMPORT_DELAY_MS);
    }

    const result = await importMarket(market.polymarket_url);

    if (result.success) {
      if (result.alreadyImported) {
        alreadyImported++;
      } else {
        imported++;
        logger.info('[simmer-discovery] imported market', {
          url: market.polymarket_url,
          question: market.question?.slice(0, 80),
          marketId: result.marketId,
        });
      }
    } else {
      failed++;
      logger.warn('[simmer-discovery] import failed', {
        url: market.polymarket_url,
        error: result.error,
      });
    }
  }

  logger.info('[simmer-discovery] discovery cycle complete', {
    discovered: discovered.length,
    imported,
    alreadyImported,
    failed,
  });
}

main().catch((err) => {
  logger.error('[simmer-discovery] fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
