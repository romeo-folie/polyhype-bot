import { describe, it, expect, vi } from 'vitest';

// Hermetic config (mirrors heartbeatWatchdog.test.ts) so runWeatherCohortHealth's
// loadConfig read doesn't depend on a host .env. Small MIN_SAMPLES for compact fixtures.
vi.mock('../../shared/config.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadConfig: () => ({
      WEATHER_COHORT_HEALTH_ENABLED: true,
      WEATHER_COHORT_HEALTH_WINDOW_DAYS: 14,
      WEATHER_COHORT_HEALTH_MIN_SAMPLES: 2,
      WEATHER_COHORT_HEALTH_REALERT_MIN: 60,
      WEATHER_CALIBRATION_LIVE_COHORTS: 'NO|high|exact|open-meteo',
    }),
  };
});

import {
  evaluateCohortHealth,
  parseLiveCohorts,
  scoreCohortFromRows,
  runWeatherCohortHealth,
  COHORT_HEALTH_ALERT_KEY,
  type CohortPerf,
  type LiveCohort,
  type ScoredBracket,
} from '../weatherCohortHealth.js';

describe('parseLiveCohorts', () => {
  it('parses side-aware entries and normalizes metric/source (case + whitespace)', () => {
    const got = parseLiveCohorts(' NO|high|exact|open-meteo , YES|LOW|range|HRRR-Combined ');
    expect(got).toEqual([
      { side: 'NO', metric: 'high', shape: 'exact', source: 'open-meteo', key: 'NO|high|exact|open-meteo' },
      { side: 'YES', metric: 'low', shape: 'range', source: 'hrrr-combined', key: 'YES|low|range|hrrr-combined' },
    ]);
  });

  it('skips legacy 3-part (both-side) and malformed entries', () => {
    // legacy metric|shape|source (no side), a bad side token, and an empty shape.
    const got = parseLiveCohorts('high|exact|open-meteo, MAYBE|high|exact|combined, NO|high||combined');
    expect(got).toEqual([]);
  });
});

describe('evaluateCohortHealth', () => {
  const MIN = 20;
  const perf = (o: Partial<CohortPerf>): CohortPerf => ({ cohort: 'NO|high|exact|open-meteo', n: 40, wr: 0.7, be: 0.6, roi: 0.1, ...o });

  it('flags a well-sampled cohort whose WR no longer clears breakeven as degrading', () => {
    const r = evaluateCohortHealth([perf({ wr: 0.55, be: 0.62 })], MIN);
    expect(r.degrading).toHaveLength(1);
    expect(r.healthy).toHaveLength(0);
  });

  it('treats wr == be as degrading (strict inverse of the admission gate wr>be)', () => {
    const r = evaluateCohortHealth([perf({ wr: 0.6, be: 0.6 })], MIN);
    expect(r.degrading).toHaveLength(1);
  });

  it('keeps a cohort still beating breakeven as healthy', () => {
    const r = evaluateCohortHealth([perf({ wr: 0.72, be: 0.6 })], MIN);
    expect(r.healthy).toHaveLength(1);
    expect(r.degrading).toHaveLength(0);
  });

  it('does not judge a cohort with too few recent samples (insufficient, never degrading)', () => {
    const r = evaluateCohortHealth([perf({ n: 8, wr: 0.1, be: 0.9 })], MIN);
    expect(r.insufficient).toHaveLength(1);
    expect(r.degrading).toHaveLength(0);
  });
});

describe('scoreCohortFromRows', () => {
  // null calibration table → calibrate() is the identity, so calProb == pRaw. That lets us
  // assert the pick rule (NO: calProb<yesPrice; YES: calProb>yesPrice) and the WR/BE/ROI math.
  const NO_COHORT: LiveCohort = { side: 'NO', metric: 'high', shape: 'exact', source: 'open-meteo', key: 'NO|high|exact|open-meteo' };
  const row = (o: Partial<ScoredBracket>): ScoredBracket =>
    ({ metric: 'high', shape: 'exact', source: 'open-meteo', daysOut: 1, pRaw: 0.2, yesPrice: 0.7, yes: false, ...o });

  it('scores NO picks (calProb<yesPrice) and computes WR/BE/ROI on the NO side', () => {
    const rows: ScoredBracket[] = [
      row({ pRaw: 0.2, yesPrice: 0.7, yes: false }), // picked (0.2<0.7); NO wins (not in bracket)
      row({ pRaw: 0.2, yesPrice: 0.7, yes: true }),  // picked; NO loses (in bracket)
      row({ pRaw: 0.9, yesPrice: 0.7, yes: false }), // NOT picked (calProb>yesPrice)
    ];
    const p = scoreCohortFromRows(NO_COHORT, rows, null);
    expect(p.n).toBe(2);
    expect(p.wr).toBeCloseTo(0.5, 6);
    expect(p.be).toBeCloseTo(0.3, 6);         // NO price = 1 − 0.7
    // ROI: win 1/0.3−1 = +2.333, loss −1 → avg +0.667
    expect(p.roi).toBeCloseTo((1 / 0.3 - 1 - 1) / 2, 6);
    expect(p.cohort).toBe('NO|high|exact|open-meteo');
  });

  it('excludes rows of a different metric/shape/source and non-finite prices', () => {
    const rows: ScoredBracket[] = [
      row({ metric: 'low' }),                 // wrong metric
      row({ shape: 'range' }),                // wrong shape
      row({ source: 'combined' }),            // wrong source
      row({ yesPrice: Number.NaN }),          // unusable price
    ];
    expect(scoreCohortFromRows(NO_COHORT, rows, null).n).toBe(0);
  });

  it('scores a YES cohort with the opposite pick rule (calProb>yesPrice)', () => {
    const YES_COHORT: LiveCohort = { side: 'YES', metric: 'high', shape: 'range', source: 'combined', key: 'YES|high|range|combined' };
    const rows: ScoredBracket[] = [
      { metric: 'high', shape: 'range', source: 'combined', daysOut: 1, pRaw: 0.6, yesPrice: 0.3, yes: true },  // picked; YES wins
      { metric: 'high', shape: 'range', source: 'combined', daysOut: 1, pRaw: 0.1, yesPrice: 0.3, yes: true },  // NOT picked (0.1<0.3)
    ];
    const p = scoreCohortFromRows(YES_COHORT, rows, null);
    expect(p.n).toBe(1);
    expect(p.wr).toBeCloseTo(1, 6);
    expect(p.be).toBeCloseTo(0.3, 6);          // YES price
  });
});

describe('runWeatherCohortHealth (alert / recovery state machine)', () => {
  const NOW = Date.parse('2026-07-22T12:00:00Z');

  // Fake postgres tagged-template: dispatch on the query text.
  function makeSql(shadowRows: unknown[], gtRows: unknown[]) {
    return ((strings: TemplateStringsArray) => {
      const q = strings.join(' ');
      if (q.includes('weather_ground_truth')) return Promise.resolve(gtRows);
      if (q.includes('shadow_observations')) return Promise.resolve(shadowRows);
      return Promise.resolve([]);
    }) as never;
  }
  function makeRedis(initial: Record<string, string> = {}) {
    const store: Record<string, string> = { ...initial };
    return {
      store,
      get: vi.fn((k: string) => Promise.resolve(store[k] ?? null)),
      setex: vi.fn((k: string, _ttl: number, v: string) => { store[k] = v; return Promise.resolve('OK'); }),
      del: vi.fn((k: string) => { delete store[k]; return Promise.resolve(1); }),
    };
  }
  // A weather_bracket shadow row for chicago 27°C exact / open-meteo / NO.
  const shadowRow = (daysOut: number): { payload: Record<string, unknown>; observed_at: string } => ({
    payload: {
      city: 'chicago', targetDate: '2026-07-20', bracket: '27°C', metric: 'high',
      forecastSource: 'open-meteo', daysOut, modelProbCalInput: 0.2, outcomePrice: 0.3,
      tradeSide: 'NO', sourceStddevMultiplier: 1,
    },
    observed_at: `2026-07-20T0${daysOut}:00:00Z`,
  });
  // resolution_high 27 → actual lands IN the 27°C bracket → NO loses; 30 → NO wins.
  const gt = (high: number): unknown[] => ([{
    city: 'chicago', target_date: '2026-07-20',
    resolution_high: high, observed_high: null, resolution_low: null, observed_low: null,
  }]);

  it('alerts once and stamps the cooldown when a cohort is degrading (no prior alert)', async () => {
    const redis = makeRedis();
    const notify = vi.fn(() => Promise.resolve());
    // Two horizons, both resolve in-bracket → 2 NO losses → wr 0 ≤ be 0.3 → degrading.
    const res = await runWeatherCohortHealth(makeSql([shadowRow(1), shadowRow(2)], gt(27)), redis as never, { notify, now: NOW, table: null });
    expect(res?.degrading.map((p) => p.cohort)).toEqual(['NO|high|exact|open-meteo']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain('degraded');
    expect(redis.setex).toHaveBeenCalledWith(COHORT_HEALTH_ALERT_KEY, expect.any(Number), String(Math.floor(NOW / 1000)));
  });

  it('does not re-alert while inside the cooldown window', async () => {
    const recent = String(Math.floor(NOW / 1000) - 600); // 10 min ago < 60 min re-alert
    const redis = makeRedis({ [COHORT_HEALTH_ALERT_KEY]: recent });
    const notify = vi.fn(() => Promise.resolve());
    await runWeatherCohortHealth(makeSql([shadowRow(1), shadowRow(2)], gt(27)), redis as never, { notify, now: NOW, table: null });
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends ONE recovery notice and clears state when every cohort is healthy again', async () => {
    const redis = makeRedis({ [COHORT_HEALTH_ALERT_KEY]: '1000000' });
    const notify = vi.fn(() => Promise.resolve());
    // resolution_high 30 → NO wins both → healthy.
    const res = await runWeatherCohortHealth(makeSql([shadowRow(1), shadowRow(2)], gt(30)), redis as never, { notify, now: NOW, table: null });
    expect(res?.healthy.map((p) => p.cohort)).toEqual(['NO|high|exact|open-meteo']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain('recovered');
    expect(redis.del).toHaveBeenCalledWith(COHORT_HEALTH_ALERT_KEY);
  });

  it('does NOT send a false recovery when a previously-alerting cohort merely goes insufficient', async () => {
    const redis = makeRedis({ [COHORT_HEALTH_ALERT_KEY]: '1000000' });
    const notify = vi.fn(() => Promise.resolve());
    // Only one row → n=1 < MIN_SAMPLES(2) → insufficient, not healthy → hold the alert state.
    const res = await runWeatherCohortHealth(makeSql([shadowRow(1)], gt(27)), redis as never, { notify, now: NOW, table: null });
    expect(res?.insufficient).toHaveLength(1);
    expect(res?.degrading).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('swallows a notify rejection (best-effort — never throws)', async () => {
    const redis = makeRedis();
    const notify = vi.fn(() => Promise.reject(new Error('telegram down')));
    const res = await runWeatherCohortHealth(makeSql([shadowRow(1), shadowRow(2)], gt(27)), redis as never, { notify, now: NOW, table: null });
    expect(res?.degrading).toHaveLength(1); // returned normally despite the throw
  });
});
