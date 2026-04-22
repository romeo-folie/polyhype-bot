import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { fetchHkoDailyHigh } = await import('../hkoClient.js');

const makePayload = (month: number, dayData: string[][]) => ({
  stn: { data: [{ month, dayData }] },
});

beforeEach(() => vi.clearAllMocks());

describe('fetchHkoDailyHigh', () => {
  it('returns the absolute daily max from column index 2', async () => {
    const payload = makePayload(4, [
      ['19', '1012.3', '27.8', '24.5', '20.1', '76', '85', '0.0'],
      ['20', '1013.1', '30.2', '26.0', '22.3', '78', '80', '0.1'],
      ['21', '1010.0', '28.5', '25.0', '21.0', '80', '82', '0.0'],
    ]);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => payload,
    });

    const result = await fetchHkoDailyHigh('2026-04-20', fetchFn as any);
    expect(result).toBe(30.2);
  });

  it('returns null when the day row is not present', async () => {
    const payload = makePayload(4, [
      ['19', '1012.0', '27.0', '23.0', '20.0', '75', '80', '0.0'],
    ]);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => payload,
    });

    const result = await fetchHkoDailyHigh('2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });

  it('returns null when the month block is missing', async () => {
    const payload = makePayload(3, [['20', '1012.0', '28.0', '24.0', '20.0', '75', '80', '0.0']]);
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => payload,
    });

    const result = await fetchHkoDailyHigh('2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await fetchHkoDailyHigh('2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('timeout'));
    const result = await fetchHkoDailyHigh('2026-04-20', fetchFn as any);
    expect(result).toBeNull();
  });
});
