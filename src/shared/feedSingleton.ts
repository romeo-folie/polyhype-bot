/**
 * Singleton ClobPriceFeed so all modules share one WebSocket connection.
 */

import type { Redis } from 'ioredis';
import { ClobPriceFeed } from './clobWebSocket.js';
import { loadConfig } from './config.js';

let _feed: ClobPriceFeed | null = null;

export function getPriceFeed(redis: Redis): ClobPriceFeed {
  if (_feed) return _feed;
  const cfg = loadConfig();
  _feed = new ClobPriceFeed(redis, { enabled: cfg.WS_ENABLED });
  return _feed;
}

export function destroyPriceFeed(): void {
  if (_feed) {
    _feed.destroy();
    _feed = null;
  }
}
