/**
 * Telegram MTProto Monitor (Phase 2)
 *
 * Listens for new messages in specified channels using GramJS (telegram).
 * Triggers immediate OSINT scoring and execution on arrival.
 *
 * Latency Target: < 500ms from Telegram arrival to execution start.
 */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis } from '../shared/redis.js';
import { scoreItems } from './scorer.js';
import { processScoredItems } from '../execution/index.js';
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

  const session = new StringSession(sessionStr || '');
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
  });

  await client.connect();
  logger.info('[telegram] connected to MTProto');

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

  const channels = channelsStr.split(',').map((s) => s.trim()).filter(Boolean);
  logger.info('[telegram] monitoring channels', { channels });

  // Event handler for new messages
  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message;
    if (!message || !message.text) return;

    // Resolve channel/peer info
    let peerName = 'unknown';
    let peerUrlSlug = 'unknown';
    try {
      const peer = await client?.getEntity(message.peerId);
      if (peer instanceof Api.Channel) {
        peerName = peer.username || peer.title || 'channel';
        // Build a valid t.me URL using the username when available; fall back to channel ID
        peerUrlSlug = peer.username ? peer.username : `c/${peer.id}`;
      } else if (peer instanceof Api.Chat) {
        peerName = peer.title || 'chat';
        peerUrlSlug = `c/${peer.id}`;
      }
    } catch { /* best effort */ }

    // Filter by configured channel list using the resolved name/username
    if (channels.length > 0 && !channels.includes(peerName)) {
      return;
    }

    const startAt = Date.now();
    const telegramLatency = startAt - (message.date * 1000);
    logger.info('[telegram] new message received', {
      from: peerName,
      text: message.text.slice(0, 50) + '...',
      latency: `${telegramLatency}ms`,
    });

    try {
      const redis = getRedis();
      
      // 1. Convert to RssItem format for scoring
      const item = {
        title: message.text.trim(),
        url: `https://t.me/${peerUrlSlug}/${message.id}`,
        publishedAt: new Date(),
        source: `telegram:${peerName}`,
        latencyMs: telegramLatency,
      };

      // 2. Score urgency
      const scored = await scoreItems([item], {
        categoryId: 'geopolitical',
        categoryLabel: 'Geopolitics',
        entityContext: 'Real-time breaking news from Telegram alerts.',
        redis,
      });

      const highUrgency = scored.filter(i => i.urgencyScore >= cfg.URGENCY_THRESHOLD);
      
      if (highUrgency.length > 0) {
        logger.info('[telegram] high-urgency message triggering execution', {
          urgency: highUrgency[0]!.urgencyScore,
          latencyMs: Date.now() - startAt,
        });

        // 3. Trigger immediate execution (bypass cron lag)
        await processScoredItems(highUrgency, redis);
      } else {
        logger.debug('[telegram] message ignored (low urgency)', {
          score: scored[0]?.urgencyScore,
        });
      }
    } catch (err) {
      logger.error('[telegram] ingestion error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, new NewMessage({}));
}

/**
 * Main entry point for standalone worker.
 */
if (process.argv[1]?.endsWith('telegramMonitor.ts')) {
  startTelegramMonitor().catch((err) => {
    logger.error('[telegram] monitor fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
