import 'dotenv/config';
import { getRedis } from '../shared/redis.js';
import { refreshDynamicWatchlist } from '../shared/watchlist.js';
import { logger } from '../shared/logger.js';

async function main() {
  const redis = getRedis();
  try {
    const count = await refreshDynamicWatchlist(redis);
    logger.info(`[cron:watchlist] successfully refreshed ${String(count)} keywords`);
    process.exit(0);
  } catch (err) {
    logger.error('[cron:watchlist] fatal error during refresh', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
