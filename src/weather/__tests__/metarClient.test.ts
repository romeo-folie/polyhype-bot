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
});
