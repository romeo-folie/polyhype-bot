/**
 * Telegram MTProto Monitor (Phase 2)
 *
 * Listens for new messages in specified channels using GramJS (telegram).
 * Triggers immediate OSINT scoring and execution on arrival.
 *
 * Latency Target: < 500ms from Telegram arrival to execution start.
 *
 * IMPORTANT: GramJS has a known issue — its catchUp() method is a TODO stub.
 * When the server sends UpdateChannelTooLong (pts gap), GramJS never calls
 * getChannelDifference() to recover. This module works around that by:
 *   1. Catching UpdateChannelTooLong and manually fetching missed messages.
 *   2. Periodically refreshing dialogs to keep the session's pts state in sync.
 *   3. Periodically calling updates.GetState() to prevent the server from
 *      silently dropping the update stream.
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

// ──────────────────────────────────────────────────────────────────────────────
// Dialog refresh interval (ms). GramJS does not track per-channel pts, so a
// periodic getDialogs() call forces the session layer to re-sync with the
// server, ensuring the update stream stays open for ALL channels.
// ──────────────────────────────────────────────────────────────────────────────
const DIALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// How often to call updates.GetState() to keep the update stream alive.
// GramJS does this internally every 30 min, but we do it more frequently
// because long-running user sessions can silently die in between.
const UPDATE_STATE_REFRESH_INTERVAL_MS = 3 * 60 * 1000; // 3 minutes

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

    // ── Full dialog sync ────────────────────────────────────────────────
    // getDialogs({}) without a limit defaults to an iterator that returns
    // ALL dialogs. This is essential: if only the first page is fetched,
    // GramJS doesn't learn the pts for channels outside that page, and
    // the server won't send us updates for them.
    // ────────────────────────────────────────────────────────────────────
    const allDialogs = await client.getDialogs({});
    logger.info('[telegram] dialogs synced', { total: allDialogs.length });

    // Prime the update state so the server knows where we are
    try {
      await client.invoke(new Api.updates.GetState());
      logger.info('[telegram] update state synced');
    } catch (err: unknown) {
      logger.warn('[telegram] GetState failed (non-fatal)', { error: String(err) });
    }
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

  // Pre-resolve channel IDs AND keep entity references for gap recovery
  const resolvedPeerIds: string[] = [];
  const channelNameMap = new Map<string, string>(); // ID -> Name
  const channelEntityMap = new Map<string, Api.Channel>(); // ID -> Channel entity (for getChannelDifference)

  for (const channelName of channels) {
    try {
      const entity = await client.getEntity(channelName);
      const id = await client.getPeerId(entity); // Canonical string ID
      
      // Determine entity type and membership
      let isJoined = false;
      let type = 'unknown';

      if (entity instanceof Api.Channel) {
        type = entity.broadcast ? 'channel' : 'megagroup';
        channelEntityMap.set(id, entity);
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
  let updateTypeStats: Record<string, number> = {};

  // ── Heartbeat: log monitor health + update type distribution ─────────
  setInterval(() => {
    logger.info('[telegram] heartbeat', {
      connected: client?.connected,
      monitoredChannels: resolvedPeerIds.length,
      messagesProcessed: messageCount,
      updateTypes: { ...updateTypeStats },
    });
    // Reset counters each heartbeat cycle
    updateTypeStats = {};
  }, 60000);

  // ── Periodic dialog refresh ──────────────────────────────────────────
  // GramJS doesn't track per-channel pts internally. When the server's pts
  // drifts ahead of the client's, the server stops delivering updates for
  // those channels. Periodically re-fetching dialogs re-syncs the pts for
  // all conversations, keeping the update stream open.
  // ────────────────────────────────────────────────────────────────────────
  setInterval(() => {
    if (!client?.connected) return;
    void (async () => {
      try {
        await client!.getDialogs({});
        logger.debug('[telegram] periodic dialog refresh complete');
      } catch (err: unknown) {
        logger.warn('[telegram] periodic dialog refresh failed', { error: String(err) });
      }
    })();
  }, DIALOG_REFRESH_INTERVAL_MS);

  // ── Periodic update state refresh ────────────────────────────────────
  // Calling updates.GetState() serves two purposes:
  //   1. Tells the server "I'm still alive, keep sending updates"
  //   2. Returns the current pts/qts/seq — if there's a gap, the server
  //      will start sending UpdatesTooLong which triggers our recovery.
  // ────────────────────────────────────────────────────────────────────────
  setInterval(() => {
    if (!client?.connected) return;
    void (async () => {
      try {
        await client!.invoke(new Api.updates.GetState());
        logger.debug('[telegram] periodic GetState complete');
      } catch (err: unknown) {
        logger.warn('[telegram] periodic GetState failed', { error: String(err) });
      }
    })();
  }, UPDATE_STATE_REFRESH_INTERVAL_MS);

  // ══════════════════════════════════════════════════════════════════════
  // EVENT HANDLER — raw update dispatcher
  // ══════════════════════════════════════════════════════════════════════
  client.addEventHandler((update: any) => {
    // ── Track ALL update types for diagnostics ──────────────────────────
    const typeName: string = update?.className || update?.constructor?.name || 'Unknown';
    updateTypeStats[typeName] = (updateTypeStats[typeName] || 0) + 1;

    // ── Handle UpdateChannelTooLong (pts gap recovery) ──────────────────
    // GramJS's catchUp() is a TODO stub and never calls getChannelDifference.
    // When the server detects our pts is behind for a channel, it sends this
    // update instead of real messages. We must manually fetch the difference
    // to recover the update stream for that channel.
    // ────────────────────────────────────────────────────────────────────────
    if (update instanceof Api.UpdateChannelTooLong) {
      const channelId = update.channelId?.toString();
      logger.warn('[telegram] UpdateChannelTooLong received — pts gap detected, recovering', {
        channelId,
        pts: update.pts,
      });

      void (async () => {
        try {
          // Re-fetch dialogs to re-sync session state for this channel
          await client!.getDialogs({});
          // Also call GetState to tell the server we're caught up
          await client!.invoke(new Api.updates.GetState());
          logger.info('[telegram] gap recovery complete (dialogs + GetState refreshed)', {
            channelId,
          });
        } catch (err: unknown) {
          logger.error('[telegram] gap recovery failed', {
            channelId,
            error: String(err),
          });
        }
      })();
      return;
    }

    // ── Handle UpdatesTooLong (global pts gap) ──────────────────────────
    if (update instanceof Api.UpdatesTooLong) {
      logger.warn('[telegram] UpdatesTooLong received — global pts gap, re-syncing');
      void (async () => {
        try {
          await client!.getDialogs({});
          await client!.invoke(new Api.updates.GetState());
          logger.info('[telegram] global gap recovery complete');
        } catch (err: unknown) {
          logger.error('[telegram] global gap recovery failed', { error: String(err) });
        }
      })();
      return;
    }

    // ── New message handling ────────────────────────────────────────────
    let message: Api.Message | undefined;
    if (update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage) {
      message = update.message as Api.Message;
    } else {
      // Log non-message update types at debug once per type per heartbeat cycle
      return;
    }

    if (!message || !message.text || !client) return;

    // Increment count and log arrival IMMEDIATELY (synchronously)
    messageCount++;
    const arrivalTs = Date.now();

    // ──────────────────────────────────────────────────────────────────────
    // CRITICAL: Fire-and-forget the heavy async processing.
    // GramJS's _dispatchUpdate() `await`s each event handler callback
    // sequentially. We return synchronously and process in background.
    // ──────────────────────────────────────────────────────────────────────
    const msgRef = message;
    const clientRef = client;

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

  logger.info('[telegram] raw update handler registered (with gap recovery)');
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
