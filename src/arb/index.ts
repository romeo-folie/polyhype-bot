/**
 * Arbitrage scanner — cron entrypoint.
 *
 * Scans active binary markets for YES+NO < $1.00 - fees.
 * Runs independently of the OSINT pipeline.
 *
 * Usage: npx tsx src/arb/index.ts
 */

import 'dotenv/config';
import { getRedis, closeRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import { runArbScan } from './scanner.js';

export { runArbScan } from './scanner.js';

// Entrypoint when run directly (npx tsx src/arb/index.ts)
const isMain = process.argv[1]?.endsWith('arb/index.ts') ?? false;
if (isMain) {
  const redis = getRedis();
  runArbScan(redis)
    .catch((err: unknown) => {
      logger.error('[arb] fatal error', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    })
    .finally(() => {
      closeRedis().catch(() => undefined);
    });
}
