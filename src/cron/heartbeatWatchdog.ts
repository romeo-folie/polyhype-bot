/**
 * Heartbeat watchdog — alerts when a scanner that should run on a fixed cadence
 * has gone silent.
 *
 * WHY: the weather scanner (and the rest of the host-cron fleet) runs via `run.sh`,
 * which sources `.env` as bash. On 2026-06-22→25 a single malformed `.env` line made
 * `set -e` abort `run.sh` before `tsx` ever launched — so the weather scanner silently
 * stopped for ~2.5 days. No scans, no shadow, and (worse) held weather positions rode
 * to resolution completely unmonitored because the drift/invalidation exits ALSO live
 * in that same scanner. Nothing surfaced the outage.
 *
 * WHERE THIS RUNS: from the always-on `pga-cron` container via
 *   docker compose exec -T pga-cron … npx tsx src/cron/heartbeatWatchdog.ts
 * (the same path as the PM activity reconciler, which kept running through the outage).
 * It must NOT run via `run.sh`/host-cron — that is the exact failure mode it detects.
 *
 * HOW: the weather scanner writes `heartbeat:weather-scanner` = unix-seconds on every
 * completed scan. This watchdog reads it and, if it is older than the threshold (or
 * missing), sends a Telegram alert — then re-alerts at a slower cadence while still
 * stale, and sends one recovery notice when it comes back.
 */

import 'dotenv/config';
import type { Redis } from 'ioredis';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { notify } from '../execution/telegram.js';

/** Redis key the weather scanner stamps (unix seconds) on every completed scan. */
export const WEATHER_SCANNER_HEARTBEAT_KEY = 'heartbeat:weather-scanner';
/** Redis key recording the last time we ALERTED on the weather scanner (cooldown state). */
export const WEATHER_SCANNER_ALERT_KEY = 'heartbeat:alert:weather-scanner';

export interface HeartbeatDecision {
  /** Age of the heartbeat in ms, or null if no heartbeat has ever been recorded. */
  ageMs: number | null;
  /** Heartbeat is missing OR older than maxAge. */
  stale: boolean;
  /** Stale AND (never alerted, or past the re-alert window) → send an alert now. */
  shouldAlert: boolean;
  /** Fresh again AND we had previously alerted → send a one-time recovery notice. */
  shouldNotifyRecovery: boolean;
}

/**
 * Pure staleness/cooldown decision. Missing heartbeat (`lastBeatMs == null`) counts as
 * stale so a never-started or fully-wiped scanner still alerts.
 */
export function evaluateHeartbeat(opts: {
  lastBeatMs: number | null;
  nowMs: number;
  maxAgeMs: number;
  lastAlertMs: number | null;
  reAlertMs: number;
}): HeartbeatDecision {
  const { lastBeatMs, nowMs, maxAgeMs, lastAlertMs, reAlertMs } = opts;
  const ageMs = lastBeatMs == null ? null : nowMs - lastBeatMs;
  const stale = ageMs == null || ageMs > maxAgeMs;
  const cooldownElapsed = lastAlertMs == null || nowMs - lastAlertMs >= reAlertMs;
  return {
    ageMs,
    stale,
    shouldAlert: stale && cooldownElapsed,
    shouldNotifyRecovery: !stale && lastAlertMs != null,
  };
}

function formatAge(ageMs: number | null): string {
  if (ageMs == null) return 'never (no heartbeat recorded)';
  const min = Math.round(ageMs / 60_000);
  if (min < 120) return `${min}m`;
  return `${(min / 60).toFixed(1)}h`;
}

/**
 * Check the weather scanner heartbeat and alert/recover via Telegram. Best-effort: any
 * failure is logged, never thrown, so the watchdog cron tick can't itself page-storm.
 */
export async function runHeartbeatWatchdog(
  redis: Redis,
  deps?: { notify?: (text: string) => Promise<void>; now?: number },
): Promise<HeartbeatDecision | null> {
  const cfg = loadConfig();
  if (!cfg.HEARTBEAT_WATCHDOG_ENABLED) {
    logger.info('[heartbeat-watchdog] disabled — skipping');
    return null;
  }
  const notifyFn = deps?.notify ?? notify;
  const nowMs = deps?.now ?? Date.now();
  const maxAgeMs = cfg.WEATHER_SCANNER_HEARTBEAT_MAX_AGE_MIN * 60_000;
  const reAlertMs = cfg.WEATHER_SCANNER_HEARTBEAT_REALERT_MIN * 60_000;

  const [beatRaw, alertRaw] = await Promise.all([
    redis.get(WEATHER_SCANNER_HEARTBEAT_KEY),
    redis.get(WEATHER_SCANNER_ALERT_KEY),
  ]);
  // Stored as unix SECONDS (matches heartbeat:spot-feed / heartbeat:writer convention).
  const lastBeatMs = beatRaw != null && beatRaw !== '' ? Number(beatRaw) * 1000 : null;
  const lastAlertMs = alertRaw != null && alertRaw !== '' ? Number(alertRaw) * 1000 : null;
  const safeBeat = lastBeatMs != null && Number.isFinite(lastBeatMs) ? lastBeatMs : null;
  const safeAlert = lastAlertMs != null && Number.isFinite(lastAlertMs) ? lastAlertMs : null;

  const d = evaluateHeartbeat({ lastBeatMs: safeBeat, nowMs, maxAgeMs, lastAlertMs: safeAlert, reAlertMs });

  if (d.shouldAlert) {
    logger.warn('[heartbeat-watchdog] weather scanner STALE', {
      ageMs: d.ageMs, thresholdMin: cfg.WEATHER_SCANNER_HEARTBEAT_MAX_AGE_MIN,
    });
    try {
      await notifyFn(
        `⚠️ <b>Weather scanner stale</b>\nNo completed scan in <b>${formatAge(d.ageMs)}</b> ` +
        `(threshold ${cfg.WEATHER_SCANNER_HEARTBEAT_MAX_AGE_MIN}m).\n` +
        `Host-cron may be down — check ~/logs/pga/weather.log and ~/logs/pga/env-source.log.\n` +
        `⚠️ Open weather positions are NOT being monitored for drift/invalidation exits.`,
      );
      // Cooldown TTL generously exceeds the re-alert window so re-alert cadence is driven
      // by the timestamp, not key expiry; cleared on recovery below.
      await redis.setex(WEATHER_SCANNER_ALERT_KEY, 30 * 24 * 60 * 60, String(Math.floor(nowMs / 1000)));
    } catch (err) {
      logger.warn('[heartbeat-watchdog] alert send failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (d.shouldNotifyRecovery) {
    logger.info('[heartbeat-watchdog] weather scanner recovered', { ageMs: d.ageMs });
    try {
      await notifyFn(`✅ <b>Weather scanner recovered</b> — a scan completed (age ${formatAge(d.ageMs)}).`);
      await redis.del(WEATHER_SCANNER_ALERT_KEY);
    } catch (err) {
      logger.warn('[heartbeat-watchdog] recovery notice failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    logger.info('[heartbeat-watchdog] ok', { ageMs: d.ageMs, stale: d.stale });
  }
  return d;
}

async function main(): Promise<void> {
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  try {
    await runHeartbeatWatchdog(redis);
  } catch (err: unknown) {
    logger.error('[heartbeat-watchdog] failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  } finally {
    await closeRedis();
  }
}

// Only run when invoked directly — importing the key constants (e.g. from the weather
// scanner) must NOT trigger a watchdog run.
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/heartbeatWatchdog.js') === true ||
  process.argv[1]?.endsWith('/heartbeatWatchdog.ts') === true;

if (isMainModule) {
  void main().catch((err: unknown) => {
    logger.error('[heartbeat-watchdog] fatal', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
