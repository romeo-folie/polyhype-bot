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
    // Wake up the update stream and confirm identity
    const me = await client.getMe();
    logger.info('[telegram] connected to MTProto', {
      username: me.username,
      id: me.id.toString(),
      firstName: me.firstName,
    });

    // Ensure all dialogs (channels/chats) are synced in memory
    await client.getDialogs({});
    logger.info('[telegram] dialogs synced');
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
      
      // Determine entity type and membership
      let isJoined = false;
      let type = 'unknown';

      if (entity instanceof Api.Channel) {
        type = entity.broadcast ? 'channel' : 'megagroup';
        // If it's a public channel/group we aren't in, try to join it
        if (entity.left) {
          try {
            await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
            isJoined = true;
            logger.info('[telegram] joined channel', { name: channelName });
          } catch (joinErr: any) {
            logger.warn('[telegram] could not auto-join channel', {
              name: channelName,
              error: joinErr.message,
            });
          }
        } else {
          isJoined = true;
        }
      } else if (entity instanceof Api.Chat) {
        type = 'chat';
        isJoined = !entity.left;
      } else if (entity instanceof Api.User) {
        type = 'user';
        isJoined = true; // Direct messages always "joined"
      }

      resolvedPeerIds.push(id);
      channelNameMap.set(id, (channelName || 'channel').replace(/^@/, ''));
      
      logger.info('[telegram] resolved & monitoring', {
        name: channelName,
        id,
        type,
        joined: isJoined,
      });

      if (!isJoined) {
        logger.warn('[telegram] NOT JOINED to channel — events will not be received', {
          channel: channelName,
        });
      }
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

  client.addEventHandler((update: any) => {
    // 1. Identify New Message updates (Bypasses NewMessage event class bugs)
    let message: Api.Message | undefined;
    if (update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage) {
      message = update.message as Api.Message;
    } else {
      // Not a new message update — return synchronously
      return;
    }

    if (!message || !message.text || !client) return;

    // Increment count and log arrival IMMEDIATELY (synchronously)
    messageCount++;
    const arrivalTs = Date.now();

    // ──────────────────────────────────────────────────────────────────────
    // CRITICAL: Fire-and-forget the heavy async processing.
    //
    // GramJS's _dispatchUpdate() `await`s each event handler callback
    // sequentially. If we block here with LLM scoring (up to 30s), Redis
    // lookups, and execution, NO subsequent updates from ANY channel can
    // be dispatched until this handler returns. That's why only ~1 channel
    // was getting through — the handler was monopolising the dispatch loop.
    //
    // By making the handler synchronous and kicking off processing as a
    // detached promise, we return control to GramJS immediately so it can
    // continue dispatching the next update.
    // ──────────────────────────────────────────────────────────────────────
    const msgRef = message; // capture for closure
    const clientRef = client; // capture for closure

    void (async () => {
      try {
        // Fast-path ID check using canonical peer ID
        const peerId = await clientRef.getPeerId(msgRef.peerId).catch(() => null);
        const peerName = (peerId && channelNameMap.get(peerId)) || 'unknown';

        // Check if this is a monitored channel
        if (!peerId || !channelNameMap.has(peerId)) {
          // Silently skip non-monitored channels
          return;
        }

        logger.info('[telegram] message arrived', {
          id: msgRef.id,
          from: peerName,
        });

        const telegramLatency = arrivalTs - msgRef.date * 1000;
        logger.info('[telegram] processing monitored message', {
          from: peerName,
          text: msgRef.text!.slice(0, 70).replace(/\n/g, ' ') + '...',
          latency: `${telegramLatency.toString()}ms`,
        });

        const redis = getRedis();
        const cfgInternal = loadConfig();

        // 1. Build Item
        const url = `https://t.me/${peerName}/${msgRef.id.toString()}`;
        const item = {
          title: msgRef.text!.trim(),
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
          entityContext:
            'Geopolitical entities (locations, leaders, organizations, conflict terms, sanctions, treaties). Skip sports teams or athletes.',
          redis,
        });

        const highUrgency = scored.filter((i) => i.urgencyScore >= cfgInternal.URGENCY_THRESHOLD);

        if (highUrgency.length > 0) {
          logger.info('[telegram] high-urgency message triggering execution', {
            urgency: highUrgency[0]?.urgencyScore,
            latencyMs: Date.now() - arrivalTs,
          });

          // 3. Trigger immediate execution
          await processScoredItems(highUrgency, redis, { wait: true });
        } else {
          logger.debug('[telegram] message ignored (low urgency)', {
            score: scored[0]?.urgencyScore,
          });
        }
      } catch (err: unknown) {
        logger.error('[telegram] error processing message', {
          error: String(err),
        });
      }
    })();
  });

  logger.info('[telegram] raw update handler registered');
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
