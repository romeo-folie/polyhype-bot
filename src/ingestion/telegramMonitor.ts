/**
 * Telegram TDLib Monitor (Phase 3)
 * 
 * Migrated from GramJS to TDLib (via tdl) for absolute reliability. 
 * TDLib is Telegram's official C++ library that handles:
 *  - Persistent state in a local SQLite DB (pts/qts tracking)
 *  - Automatic gap recovery (calls getDifference internally)
 *  - Native connection resilience
 * 
 * This rewrite removes all polling workarounds and manual dedup logic,
 * as TDLib guarantees reliable, ordered, exactly-once delivery.
 */

import { createClient, configure } from 'tdl';
import type { Client } from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getRedis, closeRedis } from '../shared/redis.js';
import { scoreItems } from './scorer.js';
import { processScoredItems } from '../execution/index.js';
import { matchesWatchlist } from '../shared/watchlist.js';
import { classifyCategory } from './categoryClassifier.js';
import { parseWhaleAlert } from './whaleAlertParser.js';
import { parseCryptoQuantAlert } from './cryptoQuantParser.js';
import { cryptoFutures } from './categories/index.js';

// Channels whose messages are parsed as structured whale flow events.
// These bypass the watchlist gate, urgency scorer, and category classifier.
// All entries lowercase — matched against channelName.toLowerCase().
const WHALE_ALERT_CHANNELS = new Set([
  'whale_alert_io',
  'whalebotalerts',
]);

// Channels whose messages are parsed as structured on-chain data alerts.
// Matched messages bypass the watchlist gate and urgency scorer.
// Unmatched messages fall through to the normal scorer as crypto-futures.
const CRYPTOQUANT_ALERT_CHANNELS = new Set([
  'cryptoquant_alert',
]);

// Channels pre-assigned to the crypto-futures category.
// Skip classifyCategory (LLM + keyword overhead) and use the category directly.
// All entries lowercase — matched against channelName.toLowerCase().
const CRYPTO_CHANNEL_OVERRIDES = new Set([
  'cryptoquant_official',
  'watcherguru',
  'bloombergcrypto',
  'wublockchainenglish',
  'arkhamintelligence',
  'aicryptodailybrief',
  'infinityhedge',
  'coinmarketcapannouncements',
  'binance_announcements',
  'cointelegraph',
]);

// Global state
let client: Client | null = null;
let isStarted = false;
const channelNameMap = new Map<number, string>(); // chat_id -> Name
const monitoredChannels = new Set<number>();
let messageCount = 0;
let updateTypes: Record<string, number> = {};

/**
 * Start the Telegram monitor.
 */
export async function startTelegramMonitor(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.TELEGRAM_MONITOR_ENABLED) {
    logger.info('[telegram] monitor disabled via config');
    return;
  }

  if (isStarted) {
    logger.warn('[telegram] monitor already started, skipping');
    return;
  }

  // Configure tdl to use the native binary inside the monitor start to avoid
  // crashing if the binary is missing when monitor is disabled.
  configure({ tdjson: getTdjson() });

  const {
    TELEGRAM_API_ID: apiId,
    TELEGRAM_API_HASH: apiHash,
    TELEGRAM_CHANNELS: channelsStr,
    TELEGRAM_DB_PATH: dbPath,
  } = cfg;

  if (!apiId || !apiHash) {
    logger.error('[telegram] missing TELEGRAM_API_ID or TELEGRAM_API_HASH');
    return;
  }

  // 1. Initialize TDLib client
  client = createClient({
    apiId,
    apiHash,
    databaseDirectory: dbPath,
    // Use message database for persistence across restarts
    tdlibParameters: {
      use_message_database: true,
      use_secret_chats: false,
      system_language_code: 'en',
      device_model: 'PGA-Agent',
      application_version: '2.0',
    }
  });

  client.on('error', (err: unknown) => {
    logger.error('[telegram] TDLib error', { error: String(err) });
  });

  // 2. Handle updates
  client.on('update', (update: any) => {
    const type = update._;
    updateTypes[type] = (updateTypes[type] || 0) + 1;

    if (type === 'updateNewMessage') {
      const message = update.message;
      if (monitoredChannels.has(message.chat_id)) {
        void handleNewMessage(message);
      }
    }
  });

  try {
    // 3. Login (Interactive on first run, auto-resume after)
    // Note: This relies on standard input if not already authorized.
    await client.login();
    const me = await client.invoke({ _: 'getMe' });
    logger.info('[telegram] connected to TDLib', {
      id: me.id,
      firstName: me.first_name,
      username: (me as any).username || (me as any).usernames?.active_usernames?.[0] || 'unknown',
    });

    // 4. Resolve and open channels
    const channels = channelsStr
      .split(',')
      .map((s) => s.trim().replace(/^@/, ''))
      .filter(Boolean);

    for (const username of channels) {
      try {
        const chat = await client.invoke({ _: 'searchPublicChat', username });
        const chatId = chat.id;

        logger.info('[telegram] resolved channel', { username, chatId });
        channelNameMap.set(chatId, username);
        monitoredChannels.add(chatId);

        // CRITICAL: TDLib requires calling openChat to receive live updates for a chat
        await client.invoke({ _: 'openChat', chat_id: chatId });
        logger.info('[telegram] monitoring & listening', { username });
      } catch (err) {
        logger.warn('[telegram] could not resolve or open channel', { username, error: String(err) });
      }
    }

    isStarted = true;
    logger.info('[telegram] monitor started', { count: monitoredChannels.size });

    // 5. Heartbeat
    setInterval(() => {
      logger.info('[telegram] heartbeat', {
        connected: !!client,
        channels: monitoredChannels.size,
        processed: messageCount,
        updateStats: { ...updateTypes },
      });
      updateTypes = {};
    }, 60000);

  } catch (err: unknown) {
    logger.error('[telegram] failed to start monitor', { error: String(err) });
    throw err;
  }
}

/**
 * Reset internal state (for testing only)
 */
export function __resetMonitorStateForTest(): void {
  isStarted = false;
  if (client) {
    client = null;
  }
  monitoredChannels.clear();
  channelNameMap.clear();
  messageCount = 0;
  updateTypes = {};
}

/**
 * Handle new message from monitored chat
 */
async function handleNewMessage(message: any) {
  if (!message.content || message.content._ !== 'messageText') return;

  const text = message.content.text.text as string;
  if (!text) return;

  messageCount++;
  const arrivalTs = Date.now();
  const channelName = channelNameMap.get(message.chat_id) || 'unknown';
  const channelKey = channelName.toLowerCase(); // normalized for set lookups

  // Latency calculation: TDLib message.date is Unix timestamp (seconds)
  const telegramLatency = arrivalTs - (Number(message.date) * 1000);

  logger.info('[telegram] message arrived', {
    id: message.id,
    from: channelName,
    text: text.slice(0, 50).replace(/\n/g, ' ') + (text.length > 50 ? '...' : ''),
    latency: `${telegramLatency}ms`
  });

  try {
    const cfg = loadConfig();
    const redis = getRedis();

    const url = `https://t.me/${channelName}/${message.id}`;
    const trimmedText = text.trim();
    const baseItem = {
      url,
      publishedAt: new Date(message.date * 1000),
      source: `telegram:${channelName}`,
      latencyMs: telegramLatency,
    };

    // ── Path A: Whale alert channels (structured flow parser) ──────────────
    if (WHALE_ALERT_CHANNELS.has(channelKey)) {
      const parsed = parseWhaleAlert(
        trimmedText,
        baseItem.source,
        url,
        baseItem.publishedAt,
        cfg.WHALE_ALERT_MIN_USD_M,
      );
      if (!parsed) {
        logger.debug('[telegram] whale alert below threshold or unrecognised', { from: channelName });
        return;
      }
      logger.info('[telegram] whale alert parsed', {
        from: channelName,
        title: parsed.title,
        urgency: parsed.urgencyScore,
        latencyMs: Date.now() - arrivalTs,
      });
      await processScoredItems([parsed], redis, { wait: true });
      return;
    }

    // ── Path B: CryptoQuant alert channels (on-chain signal parser) ────────
    if (CRYPTOQUANT_ALERT_CHANNELS.has(channelKey)) {
      const parsed = parseCryptoQuantAlert(
        trimmedText,
        baseItem.source,
        url,
        baseItem.publishedAt,
      );
      if (parsed) {
        logger.info('[telegram] cryptoquant alert parsed', {
          from: channelName,
          title: parsed.title,
          urgency: parsed.urgencyScore,
          latencyMs: Date.now() - arrivalTs,
        });
        await processScoredItems([parsed], redis, { wait: true });
        return;
      }
      // Unrecognised CQ message — fall through to normal scorer as crypto-futures
      logger.debug('[telegram] cryptoquant alert unrecognised, scoring normally', { from: channelName });
    }

    // ── Path C/D: Standard item construction ───────────────────────────────
    const item = { title: trimmedText, ...baseItem };

    // Watchlist gate — only for non-structured channels
    if (!(await matchesWatchlist(item.title, redis))) {
      logger.debug('[telegram] skipped - no match', { from: channelName });
      return;
    }

    // ── Path C: Channel override → skip classifyCategory, use crypto-futures ─
    // ── Path D: Normal classifier ──────────────────────────────────────────
    const category = CRYPTO_CHANNEL_OVERRIDES.has(channelKey) || CRYPTOQUANT_ALERT_CHANNELS.has(channelKey)
      ? cryptoFutures
      : await classifyCategory(item.title);

    if (CRYPTO_CHANNEL_OVERRIDES.has(channelKey)) {
      logger.info('[telegram] channel override → crypto-futures', { from: channelName });
    } else {
      logger.info('[telegram] classified category', { category: category.id, from: channelName });
    }

    const scored = await scoreItems([item], {
      systemPrompt: category.scorerPrompt,
      categoryId: category.id,
      categoryLabel: category.label,
      entityContext: category.entityContext,
      redis,
    });

    const highUrgency = scored.filter(i => i.urgencyScore >= category.scoreThreshold);

    if (highUrgency.length > 0) {
      logger.info('[telegram] high-urgency message triggering execution', {
        urgency: highUrgency[0]?.urgencyScore,
        category: category.id,
        latencyMs: Date.now() - arrivalTs,
      });
      await processScoredItems(highUrgency, redis, { wait: true });
    } else {
      logger.debug('[telegram] ignored (low score)', { score: scored[0]?.urgencyScore });
    }
  } catch (err: unknown) {
    logger.error('[telegram] message processing error', { error: String(err) });
  }
}

/**
 * Main entry point for standalone worker.
 */
if (process.argv[1]?.endsWith('telegramMonitor.ts')) {
  const shutdown = () => {
    logger.info('[telegram] shutting down…');
    if (client) {
      void client.close();
    }
    void closeRedis().finally(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  startTelegramMonitor().catch((err: unknown) => {
    logger.error('[telegram] fatal error', { error: String(err) });
    process.exit(1);
  });
}
