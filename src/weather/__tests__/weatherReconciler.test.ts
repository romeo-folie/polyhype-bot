import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// enqueueWrite is used inside reconcileTargets; spy on it so we don't touch Redis.
const enqueueWriteMock = vi.fn(async (_table: string, _payload: Record<string, unknown>) => {});
vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: enqueueWriteMock,
}));

const { reconcileTargets } = await import('../weatherReconciler.js');
const { weatherGroundTruthRowSchema } = await import('../../db/schemas/weather_ground_truth.js');

beforeEach(() => {
  enqueueWriteMock.mockClear();
});

describe('reconcileTargets', () => {
  it('enqueues a weather_ground_truth row for each successful fetch', async () => {
    const fetcher = vi.fn().mockImplementation(
      async (_lat: number, _lon: number, date: string, unit: 'fahrenheit' | 'celsius') => ({
        observedHigh: 72.5,
        targetDate: date,
        unit,
      }),
    );

    const summary = await reconcileTargets(
      [
        { city: 'new york', targetDate: '2026-04-10', unit: 'fahrenheit' },
        { city: 'london',   targetDate: '2026-04-10', unit: 'celsius' },
      ],
      fetcher,
    );

    expect(summary).toEqual({ resolved: 2, unknownCity: 0, noData: 0 });
    expect(enqueueWriteMock).toHaveBeenCalledTimes(2);

    const [table, payload] = enqueueWriteMock.mock.calls[0]!;
    expect(table).toBe('weather_ground_truth');
    // The payload must pass the Zod schema used by the writer handler.
    const parsed = weatherGroundTruthRowSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.city).toBe('new york');
      expect(parsed.data.targetDate).toBe('2026-04-10');
      expect(parsed.data.source).toBe('open-meteo-archive');
      expect(parsed.data.observedHigh).toBe(72.5);
    }
  });

  it('skips unknown cities and counts them separately', async () => {
    const fetcher = vi.fn();
    const summary = await reconcileTargets(
      [{ city: 'atlantis', targetDate: '2026-04-10', unit: 'fahrenheit' }],
      fetcher,
    );
    expect(summary).toEqual({ resolved: 0, unknownCity: 1, noData: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });

  it('counts archive misses as noData without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const summary = await reconcileTargets(
      [{ city: 'chicago', targetDate: '2026-04-10', unit: 'fahrenheit' }],
      fetcher,
    );
    expect(summary).toEqual({ resolved: 0, unknownCity: 0, noData: 1 });
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });

  it('passes city coordinates and correct unit to the fetcher', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      observedHigh: 15.1,
      targetDate: '2026-04-10',
      unit: 'celsius',
    });
    await reconcileTargets(
      [{ city: 'london', targetDate: '2026-04-10', unit: 'celsius' }],
      fetcher,
    );
    // London coords from CITY_COORDINATES: 51.5074, -0.1278
    expect(fetcher).toHaveBeenCalledWith(51.5074, -0.1278, '2026-04-10', 'celsius');
  });
});

describe('weatherGroundTruthRowSchema', () => {
  it('accepts a valid row', () => {
    const row = {
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
      observedHigh: 71.4,
      source: 'open-meteo-archive',
    };
    expect(weatherGroundTruthRowSchema.safeParse(row).success).toBe(true);
  });

  it('defaults source when omitted', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'london',
      targetDate: '2026-04-10',
      unit: 'celsius',
      observedHigh: 15.1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.source).toBe('open-meteo-archive');
  });

  it('rejects malformed targetDate', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '04/10/2026',
      unit: 'fahrenheit',
      observedHigh: 71.4,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown units', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'kelvin',
      observedHigh: 295.2,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects non-finite observedHigh', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
      observedHigh: Number.NaN,
    });
    expect(parsed.success).toBe(false);
  });
});
