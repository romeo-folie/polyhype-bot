import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockFetchWithTimeout = vi.fn();
vi.mock('../../mapping/gamma.js', () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args),
}));

const mockNotify = vi.fn();
vi.mock('../../execution/telegram.js', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

// Foundation from the REAL Zod schema defaults so the mock can't drift from
// config.ts (see feedback: hand-written literals crash on new cfg.X reads).
const { envSchema } = await vi.importActual<{ envSchema: z.AnyZodObject }>(
  '../../shared/config.js',
);
function schemaDefaults(schema: z.AnyZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = field.safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[key] = parsed.data;
  }
  return defaults;
}

const baseConfig = {
  ...schemaDefaults(envSchema),
  REBATE_DAILY_SUMMARY_ENABLED: true,
  REBATE_MAKER_ADDRESS: undefined as string | undefined,
  POLYMARKET_FUNDER_ADDRESS: '0x2474251E6F057d57d045853Bf94fB15DBd50Ec29',
};
const mockLoadConfig = vi.fn(() => ({ ...baseConfig }));
vi.mock('../../shared/config.js', () => ({
  loadConfig: () => mockLoadConfig(),
}));

import {
  fetchRebatesForDate,
  utcDateString,
  maybeSendDailySummary,
} from '../rebateChecker.js';

function apiResponse(rows: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: true, status: 200, json: () => Promise.resolve(rows) };
}

describe('fetchRebatesForDate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('parses rows and sums rebated_fees_usdc', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      apiResponse([
        { date: '2026-06-04', condition_id: '0xa', asset_address: '0x1', maker_address: '0xm', rebated_fees_usdc: '0.42' },
        { date: '2026-06-04', condition_id: '0xb', asset_address: '0x1', maker_address: '0xm', rebated_fees_usdc: '1.08' },
      ]),
    );

    const result = await fetchRebatesForDate('2026-06-04', '0xm');

    expect(result).not.toBeNull();
    expect(result!.rows).toHaveLength(2);
    expect(result!.totalUsd).toBeCloseTo(1.5);
    // URL carries both query params.
    const url = mockFetchWithTimeout.mock.calls[0]![0] as string;
    expect(url).toContain('/rebates/current?date=2026-06-04&maker_address=0xm');
  });

  it('returns null on HTTP failure and non-array payloads', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve([]) });
    expect(await fetchRebatesForDate('2026-06-04', '0xm')).toBeNull();

    mockFetchWithTimeout.mockResolvedValue(apiResponse({ error: 'bad request' }));
    expect(await fetchRebatesForDate('2026-06-04', '0xm')).toBeNull();

    mockFetchWithTimeout.mockRejectedValue(new Error('timeout'));
    expect(await fetchRebatesForDate('2026-06-04', '0xm')).toBeNull();
  });

  it('ignores unparseable fee values in the sum', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      apiResponse([
        { rebated_fees_usdc: '0.50' },
        { rebated_fees_usdc: 'not-a-number' },
        {},
      ]),
    );

    const result = await fetchRebatesForDate('2026-06-04', '0xm');
    expect(result!.totalUsd).toBeCloseTo(0.5);
  });
});

describe('utcDateString', () => {
  it('formats UTC dates with day offsets', () => {
    const nowMs = Date.UTC(2026, 5, 5, 10, 30); // 2026-06-05 10:30Z
    expect(utcDateString(0, nowMs)).toBe('2026-06-05');
    expect(utcDateString(1, nowMs)).toBe('2026-06-04');
  });
});

describe('maybeSendDailySummary', () => {
  // Yesterday's date bucket (same-period comparison against the API) holds
  // DIFFERENT numbers than the cumulative hash so the assertions prove which
  // bucket feeds which summary line.
  const dayStats = {
    orders_placed: '6',
    fills: '2',
    partial_fills: '0',
    post_resolution_cancels: '2',
    lifetime_cap_cancels: '1',
    reprice_cancels: '1',
    est_rebate_usd: '0.1200',
    lifetime_ms_total: String(20 * 60_000),
    lifetime_count: '4', // avg 5.0 min
  };
  const cumStats = {
    orders_placed: '12',
    fills: '3',
    partial_fills: '1',
    post_resolution_cancels: '3',
    lifetime_cap_cancels: '2',
    reprice_cancels: '2',
    est_rebate_usd: '0.2531',
    lifetime_ms_total: String(80 * 60_000),
    lifetime_count: '8', // avg 10.0 min — distinct from the day bucket so the
    // assertions prove which bucket feeds the avg-lifetime line
  };

  function makeRedis(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
    return {
      set: vi.fn().mockResolvedValue('OK'),
      hgetall: vi.fn((key: string) =>
        Promise.resolve(key.startsWith('rebate:stats:date:') ? { ...dayStats } : { ...cumStats }),
      ),
      ...overrides,
    } as Record<string, ReturnType<typeof vi.fn>>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue({ ...baseConfig });
    mockFetchWithTimeout.mockResolvedValue(
      apiResponse([{ rebated_fees_usdc: '0.31' }]),
    );
  });

  it('sends one summary per UTC day comparing the API against the SAME day\'s estimate bucket', async () => {
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await maybeSendDailySummary(redis as any);

    expect(sent).toBe(true);
    // Date-gate key set NX with TTL.
    const setArgs = redis.set.mock.calls[0]!;
    expect(setArgs[0]).toMatch(/^rebate:summary_sent:\d{4}-\d{2}-\d{2}$/);
    expect(setArgs).toContain('NX');
    // Queried YESTERDAY for the funder address (default maker address).
    const url = mockFetchWithTimeout.mock.calls[0]![0] as string;
    expect(url).toContain('maker_address=0x2474251E6F057d57d045853Bf94fB15DBd50Ec29');
    const yesterday = utcDateString(1);
    expect(url).toContain(`date=${yesterday}`);
    // Read yesterday's date bucket, not just the cumulative hash.
    const hgetallKeys = redis.hgetall.mock.calls.map((c) => c[0] as string);
    expect(hgetallKeys).toContain(`rebate:stats:date:${yesterday}`);
    expect(hgetallKeys).toContain('rebate:stats');

    expect(mockNotify).toHaveBeenCalledOnce();
    const text = mockNotify.mock.calls[0]![0] as string;
    // API line (yesterday's payout figure).
    expect(text).toContain('$0.3100');
    // Same-period estimate line comes from the DATE bucket (0.1200 / 2 fills /
    // avg 5.0 min), not the cumulative hash (avg 10.0 min).
    expect(text).toContain(`Est. ${yesterday}: $0.1200 from 2 fill(s)`);
    expect(text).toContain('avg lifetime 5.0 min');
    expect(text).not.toContain('avg lifetime 10.0 min');
    expect(text).toContain('placed 6');
    // Hold-policy cancels replace the retired stale_cancels: the ops line shows
    // the post-resolution / lifetime-cap breakdown from the DATE bucket (2 + 1).
    expect(text).toContain('held-cancelled 3 (res 2 / cap 1)');
    expect(text).not.toContain('stale-cancelled');
    // Cumulative counters are present but labelled all-time.
    expect(text).toContain('All-time: est $0.2531 | fills 4 | placed 12');
  });

  it('does not resend when the date-gate key already exists', async () => {
    const redis = makeRedis({ set: vi.fn().mockResolvedValue(null) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await maybeSendDailySummary(redis as any);

    expect(sent).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it('prefers REBATE_MAKER_ADDRESS over the funder address', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, REBATE_MAKER_ADDRESS: '0xoverride' });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await maybeSendDailySummary(redis as any);

    const url = mockFetchWithTimeout.mock.calls[0]![0] as string;
    expect(url).toContain('maker_address=0xoverride');
  });

  it('skips (no notify) when no maker address is configured — WITHOUT burning the date gate', async () => {
    mockLoadConfig.mockReturnValue({
      ...baseConfig,
      REBATE_MAKER_ADDRESS: undefined,
      POLYMARKET_FUNDER_ADDRESS: undefined as unknown as string,
    });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await maybeSendDailySummary(redis as any);

    expect(sent).toBe(false);
    expect(mockNotify).not.toHaveBeenCalled();
    // Date gate must NOT be acquired — once the address is configured, the
    // next cycle (same day) should still send.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('still sends the summary with "unavailable" when the rebates API fails', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve([]) });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await maybeSendDailySummary(redis as any);

    expect(sent).toBe(true);
    const text = mockNotify.mock.calls[0]![0] as string;
    expect(text).toContain('unavailable');
    expect(text).toContain('$0.1200'); // same-day estimates still reported
    expect(text).toContain('$0.2531'); // all-time counters still reported
  });

  it('does nothing when the summary is disabled', async () => {
    mockLoadConfig.mockReturnValue({ ...baseConfig, REBATE_DAILY_SUMMARY_ENABLED: false });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await maybeSendDailySummary(redis as any);

    expect(sent).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
  });
});
