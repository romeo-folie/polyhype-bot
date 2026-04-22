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

// Spy on the SQL tagged template so we can assert query shape without a live DB.
interface SqlCall { strings: TemplateStringsArray; values: unknown[]; result: unknown }
const sqlCalls: SqlCall[] = [];
let sqlNextResult: unknown = [];
const sqlMock = vi.fn(
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ strings, values, result: sqlNextResult });
    return Promise.resolve(sqlNextResult);
  },
);
vi.mock('../../db/client.js', () => ({
  getSql: () => sqlMock,
  closeSql: vi.fn(),
}));

const { reconcileTargets, fetchTargetsToReconcile } = await import('../weatherReconciler.js');
const { weatherGroundTruthRowSchema } = await import('../../db/schemas/weather_ground_truth.js');

beforeEach(() => {
  enqueueWriteMock.mockClear();
  sqlMock.mockClear();
  sqlCalls.length = 0;
  sqlNextResult = [];
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
        { city: 'new york', targetDate: '2026-04-10' },
        { city: 'london',   targetDate: '2026-04-10' },
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
      // observedAt is stamped at fetch time — ISO 8601 with timezone.
      expect(parsed.data.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('canonicalizes aliased city names to the CITY_COORDINATES key', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      observedHigh: 70.0,
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
    });
    await reconcileTargets(
      [{ city: 'NYC', targetDate: '2026-04-10' }],
      fetcher,
    );
    expect(enqueueWriteMock).toHaveBeenCalledTimes(1);
    const [, payload] = enqueueWriteMock.mock.calls[0]!;
    // 'NYC' alias should collapse to 'new york' canonical key on the persisted row.
    expect((payload as { city: string }).city).toBe('new york');
  });

  it('derives unit from city coords regardless of input', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      observedHigh: 15.1,
      targetDate: '2026-04-10',
      unit: 'celsius',
    });
    await reconcileTargets(
      [{ city: 'london', targetDate: '2026-04-10' }],
      fetcher,
    );
    // London is international → celsius, pulled from CITY_COORDINATES not the caller.
    expect(fetcher).toHaveBeenCalledWith(51.5074, -0.1278, '2026-04-10', 'celsius');
    const [, payload] = enqueueWriteMock.mock.calls[0]!;
    expect((payload as { unit: string }).unit).toBe('celsius');
  });

  it('skips unknown cities and counts them separately', async () => {
    const fetcher = vi.fn();
    const summary = await reconcileTargets(
      [{ city: 'atlantis', targetDate: '2026-04-10' }],
      fetcher,
    );
    expect(summary).toEqual({ resolved: 0, unknownCity: 1, noData: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });

  it('counts archive misses as noData without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const summary = await reconcileTargets(
      [{ city: 'chicago', targetDate: '2026-04-10' }],
      fetcher,
    );
    expect(summary).toEqual({ resolved: 0, unknownCity: 0, noData: 1 });
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });
});

describe('fetchTargetsToReconcile', () => {
  it('passes the canonical city list and date-range bounds to SQL', async () => {
    sqlNextResult = [
      { city: 'new york', target_date: '2026-04-15' },
      { city: 'london',   target_date: '2026-04-15' },
    ];
    const targets = await fetchTargetsToReconcile(1, 30, 50);
    expect(targets).toEqual([
      { city: 'new york', targetDate: '2026-04-15', hasArchive: false },
      { city: 'london',   targetDate: '2026-04-15', hasArchive: false },
    ]);
    expect(sqlCalls).toHaveLength(1);
    const call = sqlCalls[0]!;
    // Values bound to the template: lookbackDays, lagDays, cities array, limit.
    expect(call.values[0]).toBe(30); // lookbackDays
    expect(call.values[1]).toBe(1);  // lagDays
    expect(Array.isArray(call.values[2])).toBe(true);
    expect((call.values[2] as string[]).length).toBeGreaterThan(20); // 30 cities
    expect((call.values[2] as string[])).toContain('new york');
    expect((call.values[2] as string[])).toContain('london');
    expect(call.values[3]).toBe(50); // limit
  });

  it('returns empty when no rows match', async () => {
    sqlNextResult = [];
    const targets = await fetchTargetsToReconcile(1, 30, 50);
    expect(targets).toEqual([]);
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
