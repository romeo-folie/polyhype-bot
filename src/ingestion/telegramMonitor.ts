/**
 * Telegram MTProto Monitor (Phase 2)
 *
 * Listens for new messages in specified channels using GramJS (telegram).
 * Triggers immediate OSINT scoring and execution on arrival.
 *
 * ARCHITECTURE: Dual-path ingestion
 *
 *   1. PUSH PATH (event handler) — low latency when it works, but GramJS's
 *      update system is unreliable. Its catchUp() is a TODO stub, and
 *      StringSession doesn't persist update state (pts/qts/seq). After any
 *      connection hiccup, the server stops pushing updates entirely because
 *      the client never acknowledges the gap.
 *
 *   2. POLL PATH (getMessages loop) — guaranteed reliable. Fetches the
 *      latest messages from each monitored channel every 30s using the
 *      standard messages.getHistory API. Deduplicates by message ID so
 *      messages from either path are only processed once.
 *
 * The poll path is the **primary** ingestion mechanism. The push path is
 * a bonus for lower latency when GramJS happens to be working.
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
// Configuration constants
// ──────────────────────────────────────────────────────────────────────────────

/** How often to poll each channel for new messages (ms). */
const POLL_INTERVAL_MS = 30_000; // 30 seconds

/** How many recent messages to fetch per channel per poll cycle. */
const POLL_MSG_LIMIT = 5;

/** Delay between polling consecutive channels to avoid API bursts (ms). */
const POLL_STAGGER_MS = 500;

/** Max message age to process on first run (prevents replaying old history). */
const MAX_INITIAL_AGE_S = 120; // 2 minutes

// ──────────────────────────────────────────────────────────────────────────────
// Deduplication set — used by BOTH push and poll paths
// ──────────────────────────────────────────────────────────────────────────────

/** Tracks message IDs we've already started processing. Keyed by `channelId:messageId`. */
const processedMessages = new Set<string>();

/** Prevent the set from growing unbounded — cap at last N entries */
const DEDUP_MAX_SIZE = 5_000;

function dedupKey(channelId: string, messageId: number): string {
  return `${channelId}:${messageId}`;
}

function markProcessed(key: string): boolean {
  if (processedMessages.has(key)) return false; // already seen
  processedMessages.add(key);
  // Prune oldest entries when we exceed max size
  if (processedMessages.size > DEDUP_MAX_SIZE) {
    const iter = processedMessages.values();
    const oldest = iter.next().value;
    if (oldest) processedMessages.delete(oldest);
  }
  return true; // first time seeing this message
}

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
    const me = await client.getMe();
    logger.info('[telegram] connected to MTProto', {
      username: me.username,
      id: me.id.toString(),
      firstName: me.firstName,
    });

    // Full dialog sync — primes entity cache and update state
    const allDialogs = await client.getDialogs({});
    logger.info('[telegram] dialogs synced', { total: allDialogs.length });

    // Prime update state
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

  // ── Resolve channel entities ──────────────────────────────────────────
  // Store both the string ID and the entity itself. The entity is needed
  // for getMessages() polling; the string ID for dedup and push-path matching.
  // ────────────────────────────────────────────────────────────────────────

  interface ResolvedChannel {
    name: string;
    id: string;
    entity: Api.TypeEntity;
  }

  const resolvedChannels: ResolvedChannel[] = [];
  const channelNameMap = new Map<string, string>(); // ID -> Name

  for (const channelName of channels) {
    try {
      const entity = await client.getEntity(channelName);
      const id = await client.getPeerId(entity);

      let isJoined = false;
      let type = 'unknown';

      if (entity instanceof Api.Channel) {
        type = entity.broadcast ? 'channel' : 'megagroup';
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
        isJoined = true;
      }

      const displayName = (channelName || 'channel').replace(/^@/, '');
      resolvedChannels.push({ name: displayName, id, entity });
      channelNameMap.set(id, displayName);

      logger.info('[telegram] resolved & monitoring', {
        name: channelName,
        id,
        type,
        joined: isJoined,
      });

      if (!isJoined) {
        logger.warn('[telegram] NOT JOINED to channel — messages will not be received', {
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
    resolved: resolvedChannels.map((c) => c.name),
    count: resolvedChannels.length,
  });

  let messageCountPush = 0;
  let messageCountPoll = 0;
  let pollCycleCount = 0;
  let updateTypeStats: Record<string, number> = {};

  // ══════════════════════════════════════════════════════════════════════
  // SHARED: Message processing (used by both push and poll paths)
  // ══════════════════════════════════════════════════════════════════════

  async function processMessage(
    text: string,
    messageId: number,
    channelName: string,
    messageDate: number,
    source: 'push' | 'poll',
  ): Promise<void> {
    const arrivalTs = Date.now();
    const telegramLatency = arrivalTs - messageDate * 1000;

    logger.info(`[telegram] processing message (${source})`, {
      from: channelName,
      id: messageId,
      text: text.slice(0, 70).replace(/\n/g, ' ') + (text.length > 70 ? '...' : ''),
      latency: `${telegramLatency}ms`,
    });

    const redis = getRedis();
    const cfgInternal = loadConfig();

    const url = `https://t.me/${channelName}/${messageId}`;
    const item = {
      title: text.trim(),
      url,
      publishedAt: new Date(),
      source: `telegram:${channelName}`,
      latencyMs: telegramLatency,
    };

    // Watchlist gate
    if (!(await matchesWatchlist(item.title, redis))) {
      logger.debug('[telegram] skipping message — no watchlist match', {
        from: channelName,
      });
      return;
    }

    // Score urgency
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
        source,
      });
      await processScoredItems(highUrgency, redis, { wait: true });
    } else {
      logger.debug('[telegram] message ignored (low urgency)', {
        score: scored[0]?.urgencyScore,
        source,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PATH 1: PUSH — GramJS raw update handler (bonus low-latency path)
  // ══════════════════════════════════════════════════════════════════════

  client.addEventHandler((update: any) => {
    const typeName: string = update?.className || update?.constructor?.name || 'Unknown';
    updateTypeStats[typeName] = (updateTypeStats[typeName] || 0) + 1;

    // We no longer try to recover from UpdateChannelTooLong/UpdatesTooLong
    // since the poll path handles message delivery reliably. Just log them.
    if (update instanceof Api.UpdateChannelTooLong) {
      logger.info('[telegram] UpdateChannelTooLong received (poll path covers this)', {
        channelId: update.channelId?.toString(),
      });
      return;
    }

    let message: Api.Message | undefined;
    if (update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage) {
      message = update.message as Api.Message;
    } else {
      return;
    }

    if (!message || !message.text || !client) return;

    const msgRef = message;
    const clientRef = client;

    // Fire-and-forget — return control to GramJS immediately
    void (async () => {
      try {
        const peerId = await clientRef.getPeerId(msgRef.peerId).catch(() => null);
        if (!peerId || !channelNameMap.has(peerId)) return;

        const peerName = channelNameMap.get(peerId) || 'unknown';
        const key = dedupKey(peerId, msgRef.id);

        if (!markProcessed(key)) {
          // Already handled by poll path (or duplicate push)
          return;
        }

        messageCountPush++;
        logger.info('[telegram] push: new message', {
          id: msgRef.id,
          from: peerName,
        });

        await processMessage(msgRef.text!, msgRef.id, peerName, msgRef.date, 'push');
      } catch (err: unknown) {
        logger.error('[telegram] push path error', { error: String(err) });
      }
    })();
  });

  // ══════════════════════════════════════════════════════════════════════
  // PATH 2: POLL — Reliable getMessages() loop (primary path)
  // ══════════════════════════════════════════════════════════════════════

  // Track the highest message ID we've seen per channel.
  // On the first poll, we seed this and only process messages newer than
  // MAX_INITIAL_AGE_S to avoid replaying old history.
  const lastSeenId = new Map<string, number>();

  /** Single poll cycle: iterate all channels and fetch recent messages. */
  async function pollCycle(): Promise<void> {
    if (!client?.connected) {
      logger.warn('[telegram] poll: client not connected, skipping cycle');
      return;
    }

    pollCycleCount++;
    let newMessageCount = 0;

    for (const channel of resolvedChannels) {
      try {
        const messages = await client!.getMessages(channel.entity, {
          limit: POLL_MSG_LIMIT,
        });

        if (!messages || messages.length === 0) continue;

        // Messages come newest-first. Process oldest-first for chronological order.
        const sorted = [...messages].reverse();
        const now = Date.now();
        const isFirstPoll = !lastSeenId.has(channel.id);

        for (const msg of sorted) {
          if (!msg || !msg.id || !msg.text) continue;

          const key = dedupKey(channel.id, msg.id);

          // On first poll, only process very recent messages (avoid replaying history)
          if (isFirstPoll) {
            const ageS = (now - msg.date * 1000) / 1000;
            if (ageS > MAX_INITIAL_AGE_S) continue;
          } else {
            // On subsequent polls, only process messages newer than our high-water mark
            const highWater = lastSeenId.get(channel.id) || 0;
            if (msg.id <= highWater) continue;
          }

          if (!markProcessed(key)) continue; // Already handled by push path

          newMessageCount++;
          messageCountPoll++;

          // Fire-and-forget each message to avoid blocking the poll loop
          void processMessage(msg.text, msg.id, channel.name, msg.date, 'poll').catch(
            (err: unknown) => {
              logger.error('[telegram] poll: message processing error', {
                channel: channel.name,
                messageId: msg.id,
                error: String(err),
              });
            },
          );
        }

        // Update high-water mark to the newest message ID we saw
        const newestId = messages[0]?.id;
        if (newestId) {
          const current = lastSeenId.get(channel.id) || 0;
          if (newestId > current) {
            lastSeenId.set(channel.id, newestId);
          }
        }
      } catch (err: unknown) {
        logger.warn('[telegram] poll: error fetching messages', {
          channel: channel.name,
          error: String(err),
        });
      }

      // Stagger requests to avoid Telegram rate limits
      if (resolvedChannels.indexOf(channel) < resolvedChannels.length - 1) {
        await new Promise((r) => setTimeout(r, POLL_STAGGER_MS));
      }
    }

    if (newMessageCount > 0) {
      logger.info('[telegram] poll: cycle complete', {
        cycle: pollCycleCount,
        newMessages: newMessageCount,
      });
    } else {
      logger.debug('[telegram] poll: cycle complete (no new messages)', {
        cycle: pollCycleCount,
      });
    }
  }

  // ── Start poll loop ─────────────────────────────────────────────────────
  // Run first poll immediately to seed high-water marks, then schedule.
  // ────────────────────────────────────────────────────────────────────────
  logger.info('[telegram] starting poll loop', {
    intervalMs: POLL_INTERVAL_MS,
    channelCount: resolvedChannels.length,
    msgsPerChannel: POLL_MSG_LIMIT,
  });

  // Seed high-water marks (first poll — no processing, just learn IDs)
  for (const channel of resolvedChannels) {
    try {
      const messages = await client.getMessages(channel.entity, { limit: 1 });
      const latestId = messages?.[0]?.id;
      if (latestId) {
        lastSeenId.set(channel.id, latestId);
        logger.debug('[telegram] poll: seeded high-water mark', {
          channel: channel.name,
          latestId,
        });
      }
    } catch (err: unknown) {
      logger.warn('[telegram] poll: seed failed for channel', {
        channel: channel.name,
        error: String(err),
      });
    }
    await new Promise((r) => setTimeout(r, POLL_STAGGER_MS));
  }

  logger.info('[telegram] poll: high-water marks seeded for all channels', {
    seeded: lastSeenId.size,
    total: resolvedChannels.length,
  });

  // Schedule recurring polls
  setInterval(() => {
    void pollCycle().catch((err: unknown) => {
      logger.error('[telegram] poll: cycle failed', { error: String(err) });
    });
  }, POLL_INTERVAL_MS);

  // ══════════════════════════════════════════════════════════════════════
  // HEARTBEAT — monitor health
  // ══════════════════════════════════════════════════════════════════════
  setInterval(() => {
    logger.info('[telegram] heartbeat', {
      connected: client?.connected,
      monitoredChannels: resolvedChannels.length,
      messagesProcessed: { push: messageCountPush, poll: messageCountPoll },
      pollCycles: pollCycleCount,
      dedupSetSize: processedMessages.size,
      updateTypes: { ...updateTypeStats },
    });
    updateTypeStats = {};
  }, 60_000);

  logger.info('[telegram] monitor started (push + poll dual-path)');
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
