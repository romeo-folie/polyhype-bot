import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const baseConfig = {
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
  function makeRedis(overrides: Record<string, unknown> = {}): Record<string, ReturnType<typeof vi.fn>> {
    return {
      set: vi.fn().mockResolvedValue('OK'),
      hgetall: vi.fn().mockResolvedValue({
        orders_placed: '12',
        fills: '3',
        partial_fills: '1',
        stale_cancels: '5',
        reprice_cancels: '2',
        est_rebate_usd: '0.2531',
        lifetime_ms_total: String(40 * 60_000),
        lifetime_count: '8',
      }),
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

  it('sends one summary per UTC day comparing API-reported vs estimated rebates', async () => {
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
    // Summary content: API total, estimate, fills, avg lifetime.
    expect(mockNotify).toHaveBeenCalledOnce();
    const text = mockNotify.mock.calls[0]![0] as string;
    expect(text).toContain('$0.3100');
    expect(text).toContain('$0.2531');
    expect(text).toContain('Fills: 4');
    expect(text).toContain('Avg order lifetime: 5.0 min');
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

  it('skips (no notify) when no maker address is configured', async () => {
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
  });

  it('still sends the summary with "unavailable" when the rebates API fails', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 503, json: () => Promise.resolve([]) });
    const redis = makeRedis();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sent = await maybeSendDailySummary(redis as any);

    expect(sent).toBe(true);
    const text = mockNotify.mock.calls[0]![0] as string;
    expect(text).toContain('unavailable');
    expect(text).toContain('$0.2531'); // our own counters still reported
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
