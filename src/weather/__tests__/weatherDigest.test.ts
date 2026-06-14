/**
 * Tests for the weather daily digest (maybeSendWeatherDailySummary).
 *
 * Asserts the NEW behaviour:
 *  - once-per-UTC-day NX date gate (weather:summary_sent:<today>)
 *  - the placed/filled/PnL/win-loss aggregation and message content
 *  - exact realised-PnL math (Σ stake*return/100) and win rate
 *  - best/worst trade selection from the PnL-ordered resolved rows
 *  - disabled flag short-circuit (no gate burn, no send)
 *  - empty day → one-line "no activity" heartbeat
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockLoadConfig = vi.fn();
vi.mock('../../shared/config.js', () => ({ loadConfig: mockLoadConfig }));

// resolutionTime depends on noaaClient's city table; the digest only needs the
// target-date parse. Stub it so questions like 'Phoenix 109F+' fall back to the
// closed_at UTC date, and questions of the canonical form resolve to their date.
vi.mock('../resolutionTime.js', () => ({
  weatherTargetDateFromQuestion: (q: string) => {
    const m = q.match(/__target:(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  },
}));

// gamma is a transitive import of rebateChecker (utcDateString); stub its
// network helper so loading the real rebateChecker module is side-effect free.
vi.mock('../../mapping/gamma.js', () => ({ fetchWithTimeout: vi.fn() }));

const mockNotify = vi.fn();
vi.mock('../../execution/telegram.js', () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
  escapeHtml: (s: string) => s,
}));

const mockSql = vi.fn();
vi.mock('../../db/client.js', () => ({ getSql: () => mockSql }));

// ── Dynamic import (after mocks are registered) ──────────────────────────────

const { maybeSendWeatherDailySummary } = await import('../weatherDigest.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

// 2026-06-11T12:00:00Z → today=2026-06-11, yesterday(day)=2026-06-10.
const NOW_MS = Date.parse('2026-06-11T12:00:00Z');
const SENT_KEY = 'weather:summary_sent:2026-06-11';

function makeRedis(setResult: 'OK' | null = 'OK') {
  return { set: vi.fn().mockResolvedValue(setResult) };
}

/** Queue the three queries (placed, filled, resolved) in call order. */
interface FilledFixture {
  entryPrice: number;
  stakeUsd: number | null;
  direction: string;
  question: string;
}
interface ResolvedFixture {
  result: 'won' | 'lost' | 'pushed';
  returnPct: number;
  entryPrice: number | null;
  direction: string;
  question: string;
  pnlUsd: number;
  /** Defaults to noon on `day` (2026-06-10) so the fixture lands in-window. */
  closedAt?: string;
}

const DAY = '2026-06-10';

function queueQueries(placed: number, filled: FilledFixture[], resolved: ResolvedFixture[]) {
  // The digest scans a wide window and buckets by weather day; default each
  // resolved fixture's closedAt to mid-`day` so the UTC-date fallback keeps it.
  const withClose = resolved.map((r) => ({
    closedAt: `${DAY}T12:00:00Z`,
    ...r,
  }));
  mockSql
    .mockResolvedValueOnce([{ placed }])
    .mockResolvedValueOnce(filled)
    .mockResolvedValueOnce(withClose);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue({
    WEATHER_DAILY_SUMMARY_ENABLED: true,
    WEATHER_DAILY_SUMMARY_MIN_UTC_HOUR: 12,
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('maybeSendWeatherDailySummary', () => {
  it('sends a digest with placed/filled counts, win-loss, PnL and best/worst', async () => {
    queueQueries(
      9,
      [
        { entryPrice: 0.24, stakeUsd: 6.0, direction: 'NO', question: 'Phoenix 109F+' },
        { entryPrice: 0.5, stakeUsd: 5.0, direction: 'NO', question: 'Dallas 90-91F' },
        { entryPrice: 0.71, stakeUsd: 7.0, direction: 'YES', question: 'Austin 88-89F' },
      ],
      // Provided PnL-ascending, as the SQL ORDER BY guarantees.
      [
        { result: 'lost', returnPct: -100, entryPrice: 0.53, direction: 'YES', question: 'Austin 88-89F', pnlUsd: -2.1 },
        { result: 'won', returnPct: 5, entryPrice: 0.5, direction: 'NO', question: 'Dallas 90-91F', pnlUsd: 0.25 },
        { result: 'won', returnPct: 108, entryPrice: 0.46, direction: 'NO', question: 'Phoenix 109F+', pnlUsd: 3.21 },
      ],
    );
    const redis = makeRedis();

    const sent = await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    expect(sent).toBe(true);
    // NX date gate
    const setArgs = redis.set.mock.calls[0]!;
    expect(setArgs[0]).toBe(SENT_KEY);
    expect(setArgs).toContain('NX');
    // exactly one Telegram send
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const msg = mockNotify.mock.calls[0]![0] as string;

    expect(msg).toContain('Weather Daily Summary');
    expect(msg).toContain('Day 2026-06-10 (UTC)');
    expect(msg).toContain('9 resting order(s) worked → 3 filled into position(s)');
    // fill prices avg = (0.24+0.5+0.71)/3 = 0.483, range 0.240–0.710, staked $18.00
    expect(msg).toContain('avg 0.483 (range 0.240–0.710)');
    expect(msg).toContain('staked $18.00');
    // 2 won / 1 lost → win rate 2/3 = 66.7%
    expect(msg).toContain('3 market(s) — 2W / 1L (66.7%)');
    // realised PnL = -2.10 + 0.25 + 3.21 = 1.36
    expect(msg).toContain('Realized PnL:</b> +$1.36');
    // best = highest PnL, worst = lowest PnL
    expect(msg).toContain('Best:');
    expect(msg).toContain('Phoenix 109F+');
    expect(msg).toContain('+$3.21 (+108.0%)');
    expect(msg).toContain('Worst:');
    expect(msg).toContain('Austin 88-89F');
    expect(msg).toContain('-$2.10 (-100.0%)');
  });

  it('computes realised PnL and win rate exactly', async () => {
    queueQueries(
      2,
      [{ entryPrice: 0.4, stakeUsd: 10, direction: 'NO', question: 'A' }],
      [
        { result: 'lost', returnPct: -100, entryPrice: 0.4, direction: 'NO', question: 'A', pnlUsd: -5 },
        { result: 'won', returnPct: 50, entryPrice: 0.6, direction: 'YES', question: 'B', pnlUsd: 2.5 },
      ],
    );
    const redis = makeRedis();

    await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain('2 market(s) — 1W / 1L (50.0%)');
    expect(msg).toContain('Realized PnL:</b> -$2.50'); // -5 + 2.5
  });

  it('omits the worst line when only one market resolved', async () => {
    queueQueries(
      1,
      [{ entryPrice: 0.5, stakeUsd: 5, direction: 'NO', question: 'Solo' }],
      [{ result: 'won', returnPct: 20, entryPrice: 0.5, direction: 'NO', question: 'Solo', pnlUsd: 1.0 }],
    );
    const redis = makeRedis();

    await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain('Best:');
    expect(msg).not.toContain('Worst:');
  });

  it('does nothing when the date gate is already set (returns false, no queries, no send)', async () => {
    const redis = makeRedis(null); // SET NX returns null when key exists

    const sent = await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    expect(sent).toBe(false);
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does nothing when WEATHER_DAILY_SUMMARY_ENABLED is false — without burning the date gate', async () => {
    mockLoadConfig.mockReturnValue({ WEATHER_DAILY_SUMMARY_ENABLED: false });
    const redis = makeRedis();

    const sent = await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    expect(sent).toBe(false);
    expect(redis.set).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('sends a one-line "no activity" heartbeat on an empty day', async () => {
    queueQueries(0, [], []);
    const redis = makeRedis();

    const sent = await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    expect(sent).toBe(true);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const msg = mockNotify.mock.calls[0]![0] as string;
    expect(msg).toContain('Weather Daily Summary — 2026-06-10 (UTC): no activity');
  });

  it('buckets resolutions by city-local weather day, not closed_at UTC date', async () => {
    // A "June 10" Western-hemisphere win that resolves just after 00:00 UTC on
    // June 11 must count toward the June-10 report (the user's Panama City bug),
    // and a June-11 market whose drift-exit closed during June 10 UTC must NOT.
    queueQueries(
      0,
      [],
      [
        // closed 06-11 05:24Z but weather day = 06-10 → INCLUDED, biggest win
        {
          result: 'won', returnPct: 81.8, entryPrice: 0.55, direction: 'NO',
          question: 'Panama City 32C __target:2026-06-10', pnlUsd: 4.09,
          closedAt: '2026-06-11T05:24:00Z',
        },
        // closed 06-10 21:00Z but weather day = 06-11 (next day) → EXCLUDED
        {
          result: 'won', returnPct: 50, entryPrice: 0.5, direction: 'NO',
          question: 'Ankara 21C __target:2026-06-11', pnlUsd: 9.99,
          closedAt: '2026-06-10T21:00:00Z',
        },
        // in-window scratch loss (UTC-date fallback, no __target) → INCLUDED
        {
          result: 'lost', returnPct: -10, entryPrice: 0.5, direction: 'NO',
          question: 'London 21C', pnlUsd: -0.5,
          closedAt: '2026-06-10T10:00:00Z',
        },
      ],
    );
    const redis = makeRedis();

    await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    const msg = mockNotify.mock.calls[0]![0] as string;
    // Two markets in the June-10 bucket (Panama win + London loss); Ankara excluded.
    expect(msg).toContain('2 market(s) — 1W / 1L (50.0%)');
    // PnL = +4.09 - 0.50 = +3.59 (the +9.99 next-day row must not leak in)
    expect(msg).toContain('Realized PnL:</b> +$3.59');
    // Best = the spillover Panama win, NOT a same-UTC-day scratch.
    expect(msg).toContain('Best:');
    expect(msg).toContain('Panama City');
    expect(msg).toContain('+$4.09');
    expect(msg).not.toContain('Ankara');
  });

  it('does not send (and does not burn the date gate) before the min UTC hour', async () => {
    const earlyMs = Date.parse('2026-06-11T03:00:00Z'); // 03:00 UTC < 12
    const redis = makeRedis();

    const sent = await maybeSendWeatherDailySummary(redis as never, earlyMs);

    expect(sent).toBe(false);
    expect(redis.set).not.toHaveBeenCalled(); // NX gate not burned
    expect(mockSql).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('queries Postgres with explicit UTC day bounds for yesterday', async () => {
    queueQueries(0, [], []);
    const redis = makeRedis();

    await maybeSendWeatherDailySummary(redis as never, NOW_MS);

    // postgres.js tagged template: first arg is the strings array, the rest are
    // interpolated values (start, end). Assert the bounds are the UTC day edges.
    const firstCallValues = mockSql.mock.calls[0]!.slice(1);
    expect(firstCallValues).toContain('2026-06-10T00:00:00Z');
    expect(firstCallValues).toContain('2026-06-11T00:00:00Z');
  });
});
