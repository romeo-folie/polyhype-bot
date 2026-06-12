import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { fetchMetarDailyHigh } = await import('../metarClient.js');

const makeObs = (date: string, temps: number[]) =>
  temps.map((t) => ({ reportTime: `${date} 12:00:00`, temp: t }));

beforeEach(() => vi.clearAllMocks());

describe('fetchMetarDailyHigh', () => {
  it('returns the max temp for the target date', async () => {
    const obs = [
      ...makeObs('2026-04-20', [10, 14, 12]),
      ...makeObs('2026-04-19', [8, 9]),
    ];
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => obs,
    });

    const result = await fetchMetarDailyHigh('LTFM', '2026-04-20', fetchFn as any);
    expect(result).toBe(14);
  });

  it('returns null when no observations match the target date', async () => {
    const obs = makeObs('2026-04-19', [10, 12]);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => obs,
    });

    const result = await fetchMetarDailyHigh('LTFM', '2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchMetarDailyHigh('LTFM', '2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await fetchMetarDailyHigh('LTFM', '2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });

  it('groups by station-local calendar day when tz is provided', async () => {
    // Istanbul is UTC+3. Local June 9 spans 2026-06-08T21:00Z → 2026-06-09T21:00Z.
    const obs = [
      { reportTime: '2026-06-08 20:30:00', temp: 40 }, // 23:30 local Jun 8 — previous local day
      { reportTime: '2026-06-08 21:30:00', temp: 19 }, // 00:30 local Jun 9 — counts
      { reportTime: '2026-06-09 11:00:00', temp: 23 }, // 14:00 local Jun 9 — counts (the real high)
      { reportTime: '2026-06-09 22:00:00', temp: 30 }, // 01:00 local Jun 10 — next local day
    ];
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => obs });

    const result = await fetchMetarDailyHigh('LTFM', '2026-06-09', fetchFn as any, 'Europe/Istanbul');
    // 40 (prev local day) and 30 (next local day) must be excluded; max of {19, 23} = 23.
    expect(result).toBe(23);
  });

  it('keeps legacy UTC grouping when tz is omitted', async () => {
    const obs = [
      { reportTime: '2026-06-09 22:00:00', temp: 30 }, // UTC Jun 9 — counts without tz
      { reportTime: '2026-06-09 11:00:00', temp: 23 },
    ];
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => obs });

    const result = await fetchMetarDailyHigh('LTFM', '2026-06-09', fetchFn as any);
    expect(result).toBe(30);
  });

  it('falls back to UTC grouping on an invalid timezone', async () => {
    const obs = [{ reportTime: '2026-06-09 11:00:00', temp: 23 }];
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => obs });

    const result = await fetchMetarDailyHigh('LTFM', '2026-06-09', fetchFn as any, 'Not/AZone');
    expect(result).toBe(23);
  });

  it('handles a western-hemisphere tz where local day starts after UTC midnight', async () => {
    // America/New_York (UTC-4 in June): local June 9 = 2026-06-09T04:00Z → 2026-06-10T04:00Z.
    const obs = [
      { reportTime: '2026-06-09 02:00:00', temp: 35 }, // 22:00 local Jun 8 — excluded
      { reportTime: '2026-06-09 18:00:00', temp: 28 }, // 14:00 local Jun 9 — counts
      { reportTime: '2026-06-10 02:00:00', temp: 31 }, // 22:00 local Jun 9 — counts
    ];
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => obs });

    const result = await fetchMetarDailyHigh('KLGA', '2026-06-09', fetchFn as any, 'America/New_York');
    expect(result).toBe(31);
  });
});
