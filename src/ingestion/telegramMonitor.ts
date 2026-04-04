/**
 * Telegram MTProto Monitor (Phase 2)
 *
 * Listens for new messages in specified channels using GramJS (telegram).
 * Triggers immediate OSINT scoring and execution on arrival.
 *
 * Latency Target: < 500ms from Telegram arrival to execution start.
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import { scoreItems } from './scorer.js';
import { processScoredItems } from '../execution/index.js';
import { matchesWatchlist } from '../shared/watchlist.js';
import type { NewMessageEvent } from 'telegram/events/NewMessage.js';

let client: TelegramClient | null = null;

/**
 * Start the Telegram monitor.
 * Connects to MTProto, listens for messages, and routes to execution.
 */
export async function startTelegramMonitor(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.TELEGRAM_MONITOR_ENABLED) {
    logger.info('[telegram] monitor disabled via config');
    return;
  }

  const {
    TELEGRAM_API_ID: apiId,
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_SESSION_STRING: sessionStr,
    TELEGRAM_CHANNELS: channelsStr,
  } = cfg;

  if (!apiId || !apiHash) {
    logger.error('[telegram] missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
    return;
  }

  const session = new StringSession(sessionStr ?? '');
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.connect();
    logger.info('[telegram] connected to MTProto');
  } catch (err: any) {
    if (err.message?.includes('AUTH_KEY_UNREGISTERED')) {
      logger.error('[telegram] session invalidated (AUTH_KEY_UNREGISTERED)');
      logger.info(
        '[telegram] ACTION REQUIRED: 1. Remove TELEGRAM_SESSION_STRING from your .env. 2. Set TELEGRAM_LOG_SESSION_STRING=true. 3. Restart and re-authenticate.',
      );
    }
    throw err;
  }

  // If no session string was provided, avoid logging the raw credential by default.
  if (!sessionStr) {
    const newSession = client.session.save() as unknown as string;
    if (process.env.TELEGRAM_LOG_SESSION_STRING === 'true') {
      process.stdout.write(
        `[telegram] new session generated — Save this to TELEGRAM_SESSION_STRING env var:\n${newSession}\n`,
      );
    } else {
      logger.info(
        '[telegram] new session generated but not logged. Set TELEGRAM_LOG_SESSION_STRING=true to print it to stdout once for manual setup.',
      );
    }
  }

  const channels = channelsStr
    .split(',')
    .map((s) => s.trim().replace(/^@/, ''))
    .filter(Boolean);

  // Pre-resolve channel IDs to avoid getEntity calls in the hot path
  const resolvedPeerIds: string[] = [];
  const channelNameMap = new Map<string, string>(); // ID -> Name

  for (const channelName of channels) {
    try {
      const entity = await client.getEntity(channelName);
      const id = await client.getPeerId(entity); // Canonical string ID
      resolvedPeerIds.push(id);
      channelNameMap.set(id, (channelName || 'channel').replace(/^@/, ''));
      logger.debug('[telegram] resolved channel', { name: channelName, id });
    } catch (err: unknown) {
      logger.warn('[telegram] could not resolve channel entity at startup', {
        channel: channelName,
        error: String(err),
      });
    }
  }

  logger.info('[telegram] monitoring channels', {
    resolved: Array.from(channelNameMap.values()),
    count: resolvedPeerIds.length,
  });

  let messageCount = 0;
  // Heartbeat to confirm monitor is still alive
  setInterval(() => {
    logger.info('[telegram] heartbeat', {
      connected: client?.connected,
      monitoredChannels: resolvedPeerIds.length,
      messagesProcessed: messageCount,
    });
  }, 60000);

  // Event handler for new messages
  client.addEventHandler(async (event: NewMessageEvent) => {
    // Increment count and log arrival IMMEDIATELY (synchronously) to prevent swallowing
    // during burst updates or while waiting for peerId resolution.
    messageCount++;
    const arrivalTs = Date.now();

    const message = event.message;
    if (!message?.text || !client) return;

    // Log EVERY message received at INFO level while troubleshooting silent misses
    // We use message.peerId.toString() as a temporary label before full resolution.
    logger.info('[telegram] message arrived', {
      id: message.id,
      rawPeerId: message.peerId?.toString(),
    });

    // Fast-path ID check using canonical peer ID
    const peerId = await client.getPeerId(message.peerId).catch(() => null);
    const peerName = (peerId && channelNameMap.get(peerId)) || 'unknown';

    // Manual filter against our resolved channels
    if (resolvedPeerIds.length > 0 && peerId && !channelNameMap.has(peerId)) {
      return;
    }

    const telegramLatency = arrivalTs - message.date * 1000;
    logger.info('[telegram] processing monitored message', {
      from: peerName,
      text: message.text.slice(0, 70).replace(/\n/g, ' ') + '...',
      latency: `${telegramLatency.toString()}ms`,
    });

    try {
      const redis = getRedis();
      const cfgInternal = loadConfig(); // Refresh for threshold changes

      // 1. Build Item
      // Use fallback for URL if username not available
      const url = `https://t.me/${peerName}/${message.id.toString()}`;

      const item = {
        title: message.text.trim(),
        url,
        publishedAt: new Date(),
        source: `telegram:${peerName}`,
        latencyMs: telegramLatency,
      };

      // 1.5 Dynamic Watchlist Gate
      if (!(await matchesWatchlist(item.title, redis))) {
        logger.debug('[telegram] skipping message — no watchlist match', {
          from: peerName,
        });
        return;
      }

      // 2. Score urgency
      const scored = await scoreItems([item], {
        categoryId: 'geopolitical',
        categoryLabel: 'Geopolitics',
        entityContext: 'Real-time breaking news from Telegram alerts.',
        redis,
      });

      const highUrgency = scored.filter((i) => i.urgencyScore >= cfgInternal.URGENCY_THRESHOLD);

      if (highUrgency.length > 0) {
        logger.info('[telegram] high-urgency message triggering execution', {
          urgency: highUrgency[0]?.urgencyScore,
          latencyMs: Date.now() - arrivalTs,
        });

        // 3. Trigger immediate execution (wait for lock to handle concurrent news bursts)
        await processScoredItems(highUrgency, redis, { wait: true });
      } else {
        logger.debug('[telegram] message ignored (low urgency)', {
          score: scored[0]?.urgencyScore,
        });
      }
    } catch (err: unknown) {
      logger.error('[telegram] error processing message', {
        error: String(err),
        peer: peerName,
      });
    }
  }, new NewMessage({}));
}

/**
 * Main entry point for standalone worker.
 */
if (process.argv[1]?.endsWith('telegramMonitor.ts')) {
  startTelegramMonitor().catch((err: unknown) => {
    logger.error('[telegram] monitor fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
