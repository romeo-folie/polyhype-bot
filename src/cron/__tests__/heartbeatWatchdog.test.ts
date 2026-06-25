import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import {
  evaluateHeartbeat,
  runHeartbeatWatchdog,
  WEATHER_SCANNER_HEARTBEAT_KEY,
  WEATHER_SCANNER_ALERT_KEY,
} from '../heartbeatWatchdog.js';

const MIN = 60_000;
const MAX_AGE = 60 * MIN;   // default WEATHER_SCANNER_HEARTBEAT_MAX_AGE_MIN
const RE_ALERT = 180 * MIN; // default WEATHER_SCANNER_HEARTBEAT_REALERT_MIN
const NOW = 1_900_000_000_000;

describe('evaluateHeartbeat', () => {
  it('fresh heartbeat, never alerted → not stale, no alert, no recovery', () => {
    const d = evaluateHeartbeat({ lastBeatMs: NOW - 10 * MIN, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: null, reAlertMs: RE_ALERT });
    expect(d).toMatchObject({ stale: false, shouldAlert: false, shouldNotifyRecovery: false });
    expect(d.ageMs).toBe(10 * MIN);
  });

  it('stale heartbeat, never alerted → alert fires', () => {
    const d = evaluateHeartbeat({ lastBeatMs: NOW - 120 * MIN, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: null, reAlertMs: RE_ALERT });
    expect(d).toMatchObject({ stale: true, shouldAlert: true, shouldNotifyRecovery: false });
  });

  it('missing heartbeat → treated as stale and alerts (ageMs null)', () => {
    const d = evaluateHeartbeat({ lastBeatMs: null, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: null, reAlertMs: RE_ALERT });
    expect(d).toMatchObject({ ageMs: null, stale: true, shouldAlert: true });
  });

  it('stale but alerted recently (within re-alert window) → suppressed', () => {
    const d = evaluateHeartbeat({ lastBeatMs: NOW - 120 * MIN, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: NOW - 30 * MIN, reAlertMs: RE_ALERT });
    expect(d.stale).toBe(true);
    expect(d.shouldAlert).toBe(false);
  });

  it('stale and last alert past the re-alert window → re-alerts', () => {
    const d = evaluateHeartbeat({ lastBeatMs: NOW - 600 * MIN, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: NOW - 200 * MIN, reAlertMs: RE_ALERT });
    expect(d.shouldAlert).toBe(true);
  });

  it('exactly at threshold is NOT stale; one ms over is stale', () => {
    expect(evaluateHeartbeat({ lastBeatMs: NOW - MAX_AGE, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: null, reAlertMs: RE_ALERT }).stale).toBe(false);
    expect(evaluateHeartbeat({ lastBeatMs: NOW - MAX_AGE - 1, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: null, reAlertMs: RE_ALERT }).stale).toBe(true);
  });

  it('fresh again after a prior alert → one-time recovery notice', () => {
    const d = evaluateHeartbeat({ lastBeatMs: NOW - 5 * MIN, nowMs: NOW, maxAgeMs: MAX_AGE, lastAlertMs: NOW - 90 * MIN, reAlertMs: RE_ALERT });
    expect(d).toMatchObject({ stale: false, shouldAlert: false, shouldNotifyRecovery: true });
  });
});

/** Minimal in-memory Redis double covering only the calls the watchdog makes. */
function makeRedis(store: Record<string, string>): Redis {
  return {
    get: async (k: string) => store[k] ?? null,
    setex: async (k: string, _ttl: number, v: string) => { store[k] = v; return 'OK'; },
    del: async (k: string) => { const had = k in store; Reflect.deleteProperty(store, k); return had ? 1 : 0; },
  } as unknown as Redis;
}

describe('runHeartbeatWatchdog', () => {
  const sec = (ms: number) => String(Math.floor(ms / 1000));

  it('fresh scanner → no notification, no alert key written', async () => {
    const store: Record<string, string> = { [WEATHER_SCANNER_HEARTBEAT_KEY]: sec(NOW - 10 * MIN) };
    const sent: string[] = [];
    const d = await runHeartbeatWatchdog(makeRedis(store), { notify: async (t) => { sent.push(t); }, now: NOW });
    expect(d?.stale).toBe(false);
    expect(sent).toHaveLength(0);
    expect(store[WEATHER_SCANNER_ALERT_KEY]).toBeUndefined();
  });

  it('stale scanner → sends alert and records cooldown', async () => {
    const store: Record<string, string> = { [WEATHER_SCANNER_HEARTBEAT_KEY]: sec(NOW - 150 * MIN) };
    const sent: string[] = [];
    await runHeartbeatWatchdog(makeRedis(store), { notify: async (t) => { sent.push(t); }, now: NOW });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('stale');
    expect(store[WEATHER_SCANNER_ALERT_KEY]).toBe(sec(NOW));
  });

  it('missing heartbeat → alerts', async () => {
    const store: Record<string, string> = {};
    const sent: string[] = [];
    await runHeartbeatWatchdog(makeRedis(store), { notify: async (t) => { sent.push(t); }, now: NOW });
    expect(sent).toHaveLength(1);
  });

  it('stale but within cooldown → no notification', async () => {
    const store: Record<string, string> = {
      [WEATHER_SCANNER_HEARTBEAT_KEY]: sec(NOW - 150 * MIN),
      [WEATHER_SCANNER_ALERT_KEY]: sec(NOW - 30 * MIN),
    };
    const sent: string[] = [];
    await runHeartbeatWatchdog(makeRedis(store), { notify: async (t) => { sent.push(t); }, now: NOW });
    expect(sent).toHaveLength(0);
  });

  it('recovered (fresh again after alert) → sends recovery notice and clears cooldown', async () => {
    const store: Record<string, string> = {
      [WEATHER_SCANNER_HEARTBEAT_KEY]: sec(NOW - 5 * MIN),
      [WEATHER_SCANNER_ALERT_KEY]: sec(NOW - 90 * MIN),
    };
    const sent: string[] = [];
    await runHeartbeatWatchdog(makeRedis(store), { notify: async (t) => { sent.push(t); }, now: NOW });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('recovered');
    expect(store[WEATHER_SCANNER_ALERT_KEY]).toBeUndefined();
  });
});
