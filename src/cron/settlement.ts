/**
 * CME settlement arb cron entrypoint.
 *
 * Schedule from host crontab during the pre-settlement windows
 * (e.g. 1:20, 1:25, 2:25 ET). The scanner is gated by SETTLEMENT_ARB_ENABLED;
 * runs in log-only mode by default.
 */

import { logger } from '../shared/logger.js';
import { getRedis, closeRedis } from '../shared/redis.js';
import { scanSettlementArb } from '../settlement/scanner.js';

async function main(): Promise<void> {
  const redis = getRedis();
  try {
    const result = await scanSettlementArb(redis);
    logger.info('[cron:settlement] complete', { ...result });
  } catch (err: unknown) {
    logger.error('[cron:settlement] failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    await closeRedis();
  }
}

main().catch((err: unknown) => {
  logger.error('[cron:settlement] fatal', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
