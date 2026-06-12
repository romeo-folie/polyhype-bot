import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const notifyMock = vi.fn(async (_text: string) => {});
vi.mock('../../execution/telegram.js', () => ({
  notify: notifyMock,
}));

const fetchWeatherEventsMock = vi.fn(async (_limit: number, _offset?: number): Promise<unknown[]> => []);
vi.mock('../weatherScanner.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../weatherScanner.js');
  return { ...actual, fetchWeatherEvents: fetchWeatherEventsMock };
});

const { parseResolutionStation, auditWeatherStations, runStationAudit, fetchAllWeatherEvents } = await import(
  '../stationAudit.js'
);
import type { WeatherGammaEvent } from '../weatherScanner.js';

// ── Real description shapes captured from Gamma 2026-06-12 ────────────────

const DESC_NOAA_LTFM =
  "This market will resolve to the temperature range that contains the highest temperature recorded by NOAA at the Istanbul Airport in degrees Celsius on 9 Jun '26.\n\n" +
  'The resolution source for this market will be information from NOAA, specifically the highest reading under the "Temp" column for all times on this day, available here: https://www.weather.gov/wrh/timeseries?site=LTFM';

const DESC_WU_LFPB =
  "This market will resolve to the temperature range that contains the highest temperature recorded at the Paris-Le Bourget Airport Station in degrees Celsius on 11 Jun '26.\n\n" +
  'The resolution source for this market will be information from Wunderground, specifically the highest temperature recorded for all times on this day for the Paris-Le Bourget Airport Station, available here: https://www.wunderground.com/history/daily/fr/le-bourget/LFPB/date/2026-6-11';

// US format: extra state segment AND no /date/ suffix — the ICAO is the last
// path segment, terminated by sentence punctuation. Captured verbatim from
// the live Miami June 12 market after this exact shape caused 11 false
// mismatch alerts in production (parser grabbed the lowercase city slug).
const DESC_WU_US_URL =
  "This market will resolve to the temperature range that contains the highest temperature recorded at the Miami Intl Airport in degrees Fahrenheit on 12 Jun '26.\n\n" +
  'The resolution source for this market will be information from Wunderground, specifically the highest temperature recorded for all times on this day for the Miami Intl Airport, available here: https://www.wunderground.com/history/daily/us/fl/miami/KMIA.';

const DESC_WU_NAME_ONLY =
  "This market will resolve to the temperature range that contains the highest temperature recorded at the LaGuardia Airport in degrees Fahrenheit on 13 Jun '26.\n\n" +
  'The resolution source for this market will be information from Wunderground, specifically the highest temperature recorded for all times on this day.';

const DESC_HKO =
  "This market will resolve to the temperature range that contains the highest temperature recorded by the Hong Kong Observatory in degrees Celsius on 13 Jun '26.\n\n" +
  'The resolution source for this market will be information from the Hong Kong Observatory, specifically the "Absolute Daily Max (deg. C)", available here: https://www.weather.gov.hk/en/cis/climat.htm';

function makeEvent(title: string, slug: string, description: string): WeatherGammaEvent {
  return {
    id: '1',
    title,
    slug,
    active: true,
    closed: false,
    markets: [
      {
        id: 'm1',
        question: title,
        conditionId: '0xabc',
        clobTokenIds: '[]',
        outcomePrices: '[]',
        outcomes: '[]',
        active: true,
        closed: false,
        description,
      },
    ],
  } as unknown as WeatherGammaEvent;
}

beforeEach(() => {
  notifyMock.mockClear();
  fetchWeatherEventsMock.mockClear();
  fetchWeatherEventsMock.mockImplementation(async () => []);
});

// ── parseResolutionStation ─────────────────────────────────────────────────

describe('parseResolutionStation', () => {
  it('extracts NOAA timeseries station from site= link', () => {
    const parsed = parseResolutionStation(DESC_NOAA_LTFM);
    expect(parsed.sourceType).toBe('noaa');
    expect(parsed.stationId).toBe('LTFM');
    expect(parsed.stationName).toBe('Istanbul Airport');
  });

  it('extracts WU station ICAO from the history URL', () => {
    const parsed = parseResolutionStation(DESC_WU_LFPB);
    expect(parsed.sourceType).toBe('wu');
    expect(parsed.stationId).toBe('LFPB');
    expect(parsed.stationName).toBe('Paris-Le Bourget Airport');
  });

  it('extracts the ICAO from US-format WU URLs (state segment, no /date/, trailing period)', () => {
    const parsed = parseResolutionStation(DESC_WU_US_URL);
    expect(parsed.sourceType).toBe('wu');
    expect(parsed.stationId).toBe('KMIA');
  });

  it('never promotes lowercase city/state slugs to a station id', () => {
    // "miami"→MIAMI was the production false-alert bug (2026-06-12).
    const noIcao = DESC_WU_US_URL.replace('/KMIA.', '.');
    const parsed = parseResolutionStation(noIcao);
    expect(parsed.sourceType).toBe('wu');
    expect(parsed.stationId).toBeNull();
  });

  it('returns WU with null stationId for prose-only descriptions', () => {
    const parsed = parseResolutionStation(DESC_WU_NAME_ONLY);
    expect(parsed.sourceType).toBe('wu');
    expect(parsed.stationId).toBeNull();
    expect(parsed.stationName).toBe('LaGuardia Airport');
  });

  it('classifies Hong Kong Observatory as hko, not NOAA, despite weather.gov.hk URL', () => {
    // weather.gov.hk contains the substring weather.gov — must not be
    // misread as a NOAA source.
    const parsed = parseResolutionStation(DESC_HKO);
    expect(parsed.sourceType).toBe('hko');
    expect(parsed.stationId).toBe('HKO');
  });

  it('returns unknown for non-weather descriptions', () => {
    const parsed = parseResolutionStation('This market resolves to "Up" if the Solana price...');
    expect(parsed.sourceType).toBe('unknown');
    expect(parsed.stationId).toBeNull();
  });
});

// ── auditWeatherStations ───────────────────────────────────────────────────

describe('auditWeatherStations', () => {
  it('flags a station mismatch (LTBA-era istanbul would alert against LTFM market)', () => {
    // The live description resolves LTFM and our table (post-fix) agrees, so
    // mutate the description to a different station to simulate a future
    // silent station switch.
    const switched = DESC_NOAA_LTFM.replace(/LTFM/g, 'LTBA');
    const result = auditWeatherStations([
      makeEvent('Highest temperature in Istanbul on June 9?', 'highest-temperature-in-istanbul-on-june-9-2026', switched),
    ]);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]).toMatchObject({
      city: 'istanbul',
      expectedStation: 'LTFM',
      actual: { stationId: 'LTBA', sourceType: 'noaa' },
    });
  });

  it('passes matching stations (istanbul=LTFM, paris=LFPB, hong kong=HKO, miami=KMIA)', () => {
    const result = auditWeatherStations([
      makeEvent('Highest temperature in Istanbul on June 9?', 'ist', DESC_NOAA_LTFM),
      makeEvent('Highest temperature in Paris on June 11?', 'par', DESC_WU_LFPB),
      makeEvent('Highest temperature in Hong Kong on June 13?', 'hk', DESC_HKO),
      makeEvent('Highest temperature in Miami on June 12?', 'mia', DESC_WU_US_URL),
    ]);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBe(4);
  });

  it('treats NOAA timeseries vs our WU as compatible when the ICAO matches', () => {
    // tel aviv: market resolves NOAA site=LLBG; we fetch WU LLBG — same METAR feed.
    const desc = DESC_NOAA_LTFM.replace(/LTFM/g, 'LLBG').replace('Istanbul Airport', 'Ben Gurion International Airport');
    const result = auditWeatherStations([
      makeEvent('Highest temperature in Tel Aviv on June 13?', 'ta', desc),
    ]);
    expect(result.mismatches).toEqual([]);
  });

  it('collects untracked cities instead of flagging mismatches', () => {
    const result = auditWeatherStations([
      makeEvent('Highest temperature in Reykjavik on June 13?', 'rey', DESC_WU_NAME_ONLY),
      makeEvent('Highest temperature in Oslo on June 13?', 'osl', DESC_WU_NAME_ONLY),
    ]);
    expect(result.mismatches).toEqual([]);
    expect(result.unknownCities).toEqual(['oslo', 'reykjavik']);
  });

  it('marks prose-only same-source descriptions as uncomparable, not mismatched', () => {
    const result = auditWeatherStations([
      makeEvent('Highest temperature in NYC on June 13?', 'nyc', DESC_WU_NAME_ONLY),
    ]);
    expect(result.mismatches).toEqual([]);
    expect(result.uncomparable).toEqual(['new york']);
  });

  it('treats an unrecognized description format as uncomparable — never alerts', () => {
    // If Polymarket rewrites its description template, every city would
    // otherwise fire a mismatch alert at once. Unknown formats go to the
    // uncomparable list (visible in the audit log) instead.
    const result = auditWeatherStations([
      makeEvent(
        'Highest temperature in Istanbul on June 9?',
        'ist',
        'This market resolves based on the official reading. Details to follow.',
      ),
    ]);
    expect(result.mismatches).toEqual([]);
    expect(result.uncomparable).toEqual(['istanbul']);
    expect(result.checked).toBe(0);
  });

  it('flags an hko/wu source conflict even without a station id', () => {
    // If Polymarket moved Hong Kong from HKO to a WU airport station, the
    // station id may be absent but the source flip alone is actionable.
    const result = auditWeatherStations([
      makeEvent('Highest temperature in Hong Kong on June 13?', 'hk', DESC_WU_NAME_ONLY),
    ]);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0].city).toBe('hong kong');
  });

  it('audits each city once even with multiple events', () => {
    const result = auditWeatherStations([
      makeEvent('Highest temperature in Paris on June 11?', 'p1', DESC_WU_LFPB),
      makeEvent('Highest temperature in Paris on June 12?', 'p2', DESC_WU_LFPB),
    ]);
    expect(result.checked).toBe(1);
  });
});

// ── runStationAudit ────────────────────────────────────────────────────────

function makeRedis() {
  const store = new Set<string>();
  return {
    set: vi.fn(async (key: string, _v: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.add(key);
      return 'OK';
    }),
    _store: store,
  };
}

describe('runStationAudit', () => {
  it('notifies once per mismatch and dedups within the TTL window', async () => {
    const redis = makeRedis();
    const switched = DESC_NOAA_LTFM.replace(/LTFM/g, 'LTBA');
    const events = [
      makeEvent('Highest temperature in Istanbul on June 9?', 'ist', switched),
    ];

    await runStationAudit(redis as never, events);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toContain('istanbul');
    expect(notifyMock.mock.calls[0][0]).toContain('LTBA');

    notifyMock.mockClear();
    await runStationAudit(redis as never, events);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('notifies untracked cities as expansion candidates, deduped', async () => {
    const redis = makeRedis();
    const events = [
      makeEvent('Highest temperature in Reykjavik on June 13?', 'rey', DESC_WU_NAME_ONLY),
    ];

    await runStationAudit(redis as never, events);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0][0]).toContain('reykjavik');

    notifyMock.mockClear();
    await runStationAudit(redis as never, events);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('sends no notifications when everything matches', async () => {
    const redis = makeRedis();
    await runStationAudit(redis as never, [
      makeEvent('Highest temperature in Paris on June 11?', 'par', DESC_WU_LFPB),
    ]);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('returns null and never throws when the audit itself fails', async () => {
    const redis = {
      set: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const switched = DESC_NOAA_LTFM.replace(/LTFM/g, 'LTBA');
    const result = await runStationAudit(redis as never, [
      makeEvent('Highest temperature in Istanbul on June 9?', 'ist', switched),
    ]);
    expect(result).toBeNull();
  });
});

// ── fetchAllWeatherEvents ──────────────────────────────────────────────────

describe('fetchAllWeatherEvents', () => {
  const ev = (slug: string) =>
    makeEvent(`Highest temperature in Paris on June 11?`, slug, DESC_WU_LFPB);

  it('pages past the per-request cap until a short batch', async () => {
    // Gamma caps each request at 100 events; with 117 live events a single
    // page silently dropped the lowest-liquidity cities from the audit.
    fetchWeatherEventsMock
      .mockResolvedValueOnce([ev('a'), ev('b')])
      .mockResolvedValueOnce([ev('c'), ev('d')])
      .mockResolvedValueOnce([ev('e')]);

    const all = await fetchAllWeatherEvents(2, 5);

    expect(all).toHaveLength(5);
    expect(fetchWeatherEventsMock.mock.calls).toEqual([[2, 0], [2, 2], [2, 4]]);
  });

  it('stops after a single short page', async () => {
    fetchWeatherEventsMock.mockResolvedValueOnce([ev('a')]);

    const all = await fetchAllWeatherEvents(2, 5);

    expect(all).toHaveLength(1);
    expect(fetchWeatherEventsMock).toHaveBeenCalledTimes(1);
  });

  it('is bounded by maxPages even when every page is full', async () => {
    fetchWeatherEventsMock.mockImplementation(async () => [ev('x'), ev('y')]);

    const all = await fetchAllWeatherEvents(2, 3);

    expect(all).toHaveLength(6);
    expect(fetchWeatherEventsMock).toHaveBeenCalledTimes(3);
  });
});
