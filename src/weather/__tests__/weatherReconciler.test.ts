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
        { city: 'new york', targetDate: '2026-04-10', hasArchive: false },
        { city: 'london',   targetDate: '2026-04-10', hasArchive: false },
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
      [{ city: 'NYC', targetDate: '2026-04-10', hasArchive: false }],
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
      [{ city: 'london', targetDate: '2026-04-10', hasArchive: false }],
      fetcher,
    );
    // London is international → celsius, pulled from CITY_COORDINATES not the
    // caller. Coords are the EGLC (London City Airport) resolution station.
    expect(fetcher).toHaveBeenCalledWith(51.5053, 0.0553, '2026-04-10', 'celsius');
    const [, payload] = enqueueWriteMock.mock.calls[0]!;
    expect((payload as { unit: string }).unit).toBe('celsius');
  });

  it('skips unknown cities and counts them separately', async () => {
    const fetcher = vi.fn();
    const summary = await reconcileTargets(
      [{ city: 'atlantis', targetDate: '2026-04-10', hasArchive: false }],
      fetcher,
    );
    expect(summary).toEqual({ resolved: 0, unknownCity: 1, noData: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });

  it('counts archive misses as noData without throwing', async () => {
    const fetcher = vi.fn().mockResolvedValue(null);
    const summary = await reconcileTargets(
      [{ city: 'chicago', targetDate: '2026-04-10', hasArchive: false }],
      fetcher,
    );
    expect(summary).toEqual({ resolved: 0, unknownCity: 0, noData: 1 });
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });

  it('enqueues resolution backfill when hasArchive=true and resolution is available', async () => {
    const archiveFetcher = vi.fn();
    const resolutionFetcher = vi.fn().mockResolvedValue({ high: 28.4, source: 'wu' });

    const summary = await reconcileTargets(
      [{ city: 'london', targetDate: '2026-04-10', hasArchive: true }],
      archiveFetcher,
      resolutionFetcher,
    );

    expect(summary).toEqual({ resolved: 1, unknownCity: 0, noData: 0 });
    expect(archiveFetcher).not.toHaveBeenCalled();
    expect(enqueueWriteMock).toHaveBeenCalledTimes(1);
    const [, payload] = enqueueWriteMock.mock.calls[0]!;
    // `backfillOnly: true` routes the writer through a bare UPDATE that only
    // touches `resolution_high` / `resolution_source` (see
    // src/db/writer/handlers/weather_ground_truth.ts). `source` and
    // `observedHigh` are not part of that path's payload contract — commit
    // 8de8fa2 (2026-04-22) intentionally stripped them.
    expect((payload as { backfillOnly: boolean }).backfillOnly).toBe(true);
    expect((payload as { resolutionHigh: number }).resolutionHigh).toBe(28.4);
    expect((payload as { resolutionSource: string }).resolutionSource).toBe('wu');
    // Strictly assert key absence (not just undefined value) so an accidental
    // `source: undefined` in production code would still fail the test.
    expect(payload).not.toHaveProperty('source');
    expect(payload).not.toHaveProperty('observedHigh');

    // Regression (2026-04-24): the reconciler's output MUST roundtrip through
    // the writer's Zod schema. Without this assertion, a schema/producer drift
    // can silently cause every backfill enqueue to be rejected by the db-writer
    // — which is what happened from 2026-04-22 (PR #298) onward: 1,122 rows
    // were missing their resolution_high until this guard was added.
    const parsed = weatherGroundTruthRowSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it('skips enqueue when hasArchive=true and resolution is unavailable', async () => {
    const archiveFetcher = vi.fn();
    const resolutionFetcher = vi.fn().mockResolvedValue(null);

    const summary = await reconcileTargets(
      [{ city: 'london', targetDate: '2026-04-10', hasArchive: true }],
      archiveFetcher,
      resolutionFetcher,
    );

    expect(summary).toEqual({ resolved: 0, unknownCity: 0, noData: 1 });
    expect(archiveFetcher).not.toHaveBeenCalled();
    expect(enqueueWriteMock).not.toHaveBeenCalled();
  });

  it('continues reconciling other targets when resolution fetcher throws', async () => {
    const archiveFetcher = vi.fn().mockResolvedValue({
      observedHigh: 70.0, targetDate: '2026-04-10', unit: 'fahrenheit',
    });
    const resolutionFetcher = vi.fn().mockRejectedValue(new Error('network error'));

    const summary = await reconcileTargets(
      [{ city: 'new york', targetDate: '2026-04-10', hasArchive: false }],
      archiveFetcher,
      resolutionFetcher,
    );

    // Row is still written — resolution is best-effort and a throw should not abort the loop.
    expect(summary).toEqual({ resolved: 1, unknownCity: 0, noData: 0 });
    expect(enqueueWriteMock).toHaveBeenCalledTimes(1);
    const [, payload] = enqueueWriteMock.mock.calls[0]!;
    expect((payload as { resolutionHigh: unknown }).resolutionHigh).toBeUndefined();
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

  it('rejects INSERT payloads (backfillOnly unset) without observedHigh', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
      // observedHigh intentionally missing — INSERT path must require it.
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const hit = parsed.error.errors.find((e) => e.path.join('.') === 'observedHigh');
      expect(hit).toBeDefined();
    }
  });

  it('accepts backfillOnly payloads without observedHigh', () => {
    // The reconciler's resolution-backfill branch (weatherReconciler.ts:182-190)
    // produces exactly this shape — no observedHigh, resolution columns only.
    // Pre-fix, Zod rejected these with "Required" and 1,122 rows lost their
    // canonical resolution source.
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'london',
      targetDate: '2026-04-10',
      unit: 'celsius',
      resolutionHigh: 14,
      resolutionSource: 'wu',
      observedAt: '2026-04-10T12:00:00.000Z',
      backfillOnly: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects backfillOnly payloads missing resolutionHigh', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'london',
      targetDate: '2026-04-10',
      unit: 'celsius',
      backfillOnly: true,
      // resolutionHigh + resolutionSource missing — nothing to backfill.
    });
    expect(parsed.success).toBe(false);
  });

  it('still rejects unpaired resolutionHigh / resolutionSource on INSERT path', () => {
    const parsed = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
      observedHigh: 71.4,
      resolutionHigh: 72.0,
      // resolutionSource missing → superRefine catches the half-specified pair.
    });
    expect(parsed.success).toBe(false);
  });

  it('issue `path` points at the actually-missing field (writer log diagnostic)', () => {
    // Unpaired — resolutionHigh present, resolutionSource missing. The
    // `path` must be `resolutionSource` so the writer's rejection log
    // identifies the real absent field rather than always blaming
    // resolutionHigh.
    const missingSource = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
      observedHigh: 71.4,
      resolutionHigh: 72.0,
    });
    expect(missingSource.success).toBe(false);
    if (!missingSource.success) {
      const hit = missingSource.error.errors.find(
        (e) => e.path.join('.') === 'resolutionSource',
      );
      expect(hit).toBeDefined();
    }

    // Inverse — resolutionSource present, resolutionHigh missing.
    const missingHigh = weatherGroundTruthRowSchema.safeParse({
      city: 'new york',
      targetDate: '2026-04-10',
      unit: 'fahrenheit',
      observedHigh: 71.4,
      resolutionSource: 'wu',
    });
    expect(missingHigh.success).toBe(false);
    if (!missingHigh.success) {
      const hit = missingHigh.error.errors.find(
        (e) => e.path.join('.') === 'resolutionHigh',
      );
      expect(hit).toBeDefined();
    }

    // backfillOnly carrying NEITHER resolution pair (no high, no low) is rejected
    // with a single "at least one resolution pair" issue (a low-only backfill is
    // now valid, so the rule is OR across the two pairs rather than per-field).
    const backfillEmpty = weatherGroundTruthRowSchema.safeParse({
      city: 'london',
      targetDate: '2026-04-10',
      unit: 'celsius',
      backfillOnly: true,
    });
    expect(backfillEmpty.success).toBe(false);
    if (!backfillEmpty.success) {
      const messages = backfillEmpty.error.errors.map((e) => e.message);
      expect(messages.some((m) => m.includes('at least one resolution pair'))).toBe(true);
    }
  });
});
