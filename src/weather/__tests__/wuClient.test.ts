import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const redisMock = { get: vi.fn(), set: vi.fn() };

const { fetchWuHistoricalHigh } = await import('../wuClient.js');

const makeObs = (temps: number[]) =>
  JSON.stringify({ observations: temps.map((t) => ({ valid_time_gmt: 0, temp: t })) });

beforeEach(() => {
  vi.clearAllMocks();
  redisMock.get.mockResolvedValue('cac4edce1234567890ab1234567890ab');
  redisMock.set.mockResolvedValue('OK');
});

describe('fetchWuHistoricalHigh', () => {
  it('returns the max temp across observations', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ observations: [{ temp: 18 }, { temp: 22 }, { temp: 15 }] }),
    });

    const result = await fetchWuHistoricalHigh('EGLC', 'GB', '2026-04-20', 'celsius', redisMock as any, fetchFn as any);
    expect(result).toBe(22);
  });

  it('refreshes key and retries on 401 (URL query-param format)', async () => {
    redisMock.get.mockResolvedValueOnce('bad0bad0bad0bad0bad0bad0bad0bad0');
    // WU now embeds the key as a URL query param in inline script src attributes.
    const refreshHtml = `<script src="/some/bundle.js?apiKey=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4&lang=en"></script>`;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => refreshHtml }) // key refresh
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ observations: [{ temp: 19 }] }) });

    const result = await fetchWuHistoricalHigh('KLGA', 'US', '2026-04-20', 'fahrenheit', redisMock as any, fetchFn as any);
    expect(result).toBe(19);
    expect(redisMock.set).toHaveBeenCalled();
  });

  it('returns null when no observations are returned', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ observations: [] }),
    });

    const result = await fetchWuHistoricalHigh('EGLC', 'GB', '2026-04-20', 'celsius', redisMock as any, fetchFn as any);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network error'));
    const result = await fetchWuHistoricalHigh('EGLC', 'GB', '2026-04-20', 'celsius', redisMock as any, fetchFn as any);
    expect(result).toBeNull();
  });

  it('seeds Redis from WU_API_KEY env var when cache is empty', async () => {
    const envKey = 'aabbccddeeff00112233445566778899';
    vi.stubEnv('WU_API_KEY', envKey);
    redisMock.get.mockResolvedValueOnce(null); // cache miss → falls through to env var

    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ observations: [{ temp: 20 }] }),
    });

    const result = await fetchWuHistoricalHigh('EGLC', 'GB', '2026-04-20', 'celsius', redisMock as any, fetchFn as any);
    expect(result).toBe(20);
    // Env key must be written to Redis for subsequent calls.
    expect(redisMock.set).toHaveBeenCalledWith(
      'weather:wu_api_key', envKey, 'EX', expect.any(Number),
    );
    vi.unstubAllEnvs();
  });

  it('attempts page refresh on 401 retry even when WU_API_KEY is set', async () => {
    const envKey = 'aabbccddeeff00112233445566778899';
    vi.stubEnv('WU_API_KEY', envKey);
    redisMock.get.mockResolvedValue(null); // no cached key

    const freshKey = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const refreshHtml = `<script src="/bundle.js?apiKey=${freshKey}&lang=en"></script>`;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ observations: [{ temp: 21 }] }) }) // first attempt with env key succeeds — actually let's trigger 401
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => refreshHtml })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ observations: [{ temp: 25 }] }) });

    // Simulate 401 on first attempt
    fetchFn.mockReset();
    fetchFn
      .mockResolvedValueOnce({ ok: false, status: 401, text: async () => '' }) // data fetch → 401
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => refreshHtml }) // page refresh
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ observations: [{ temp: 25 }] }) }); // retry with fresh key

    const result = await fetchWuHistoricalHigh('EGLC', 'GB', '2026-04-20', 'celsius', redisMock as any, fetchFn as any);
    expect(result).toBe(25);
    // Fresh key from page must be stored, not the env var.
    expect(redisMock.set).toHaveBeenCalledWith('weather:wu_api_key', freshKey, 'EX', expect.any(Number));
    vi.unstubAllEnvs();
  });
});
