import { describe, it, expect } from 'vitest';
import { CITY_COORDINATES, canonicalCityKey, lookupCity, estimateBracketProbability } from '../noaaClient.js';

describe('CITY_COORDINATES', () => {
  it('every WU-sourced city has an isoCountry code', () => {
    // wuClient builds the API URL as `{ICAO}:9:{ISO2}`; a missing isoCountry
    // produces a malformed URL that WU rejects with HTTP 400. The reconciler
    // catches this and returns null, so the city silently never resolves.
    const offenders: string[] = [];
    for (const [city, coords] of Object.entries(CITY_COORDINATES)) {
      if (coords.resolutionSource === 'wu' && !coords.isoCountry) {
        offenders.push(city);
      }
    }
    expect(offenders, `WU cities missing isoCountry: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every city entry has a non-empty station code', () => {
    const offenders: string[] = [];
    for (const [city, coords] of Object.entries(CITY_COORDINATES)) {
      if (!coords.wuStation || coords.wuStation.length < 2) offenders.push(city);
    }
    expect(offenders).toEqual([]);
  });

  it('isoCountry is a valid ISO 3166-1 alpha-2 pattern', () => {
    const pattern = /^[A-Z]{2}$/;
    const offenders: string[] = [];
    for (const [city, coords] of Object.entries(CITY_COORDINATES)) {
      if (coords.isoCountry !== undefined && !pattern.test(coords.isoCountry)) {
        offenders.push(`${city}=${coords.isoCountry}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('tel aviv and moscow stay WU-sourced with isoCountry (2026-04-24 METAR cap)', () => {
    // aviationweather.gov caps obs at ~400 (~9d window) so long-history
    // backfills must go through WU. Their markets resolve via NOAA's
    // timeseries page for the SAME ICAO — WU renders the same METAR feed,
    // so WU stays correct as long as the station matches.
    const wuCities: { city: string; station: string; iso: string }[] = [
      { city: 'tel aviv', station: 'LLBG', iso: 'IL' },
      { city: 'moscow',   station: 'UUWW', iso: 'RU' },
    ];
    for (const { city, station, iso } of wuCities) {
      const entry = CITY_COORDINATES[city];
      expect(entry, `${city} missing from CITY_COORDINATES`).toBeDefined();
      expect(entry!.resolutionSource).toBe('wu');
      expect(entry!.wuStation).toBe(station);
      expect(entry!.isoCountry).toBe(iso);
    }
  });

  it('istanbul resolves via METAR at LTFM — the station Polymarket settles on', () => {
    // 2026-06-12 station audit: the market description links
    // weather.gov/wrh/timeseries?site=LTFM. Our previous LTBA proxy diverged
    // up to 4°C (Jun 9: LTFM 23 / LTBA 27 — market resolved 23°C YES, our
    // NO-on-23 was written off). WU has no LTFM history (HTTP 400), so
    // resolution uses METAR; the reconciler only needs the day-after fetch,
    // well inside METAR's ~8-day window.
    const istanbul = CITY_COORDINATES.istanbul;
    expect(istanbul.wuStation).toBe('LTFM');
    expect(istanbul.resolutionSource).toBe('metar');
    // Forecast point must be the LTFM airfield (Black Sea coast), not LTBA.
    expect(istanbul.lat).toBeCloseTo(41.2753, 3);
    expect(istanbul.lon).toBeCloseTo(28.7519, 3);
  });

  it('paris resolves at Le Bourget (LFPB), not Charles de Gaulle', () => {
    // Market description: "Paris-Le Bourget Airport Station" on Wunderground.
    // LFPG cost the May-31 and Jun-11 2026 markets (resolved 1°C above CDG).
    const paris = CITY_COORDINATES.paris;
    expect(paris.wuStation).toBe('LFPB');
    expect(paris.resolutionSource).toBe('wu');
    expect(paris.lat).toBeCloseTo(48.9694, 3);
    expect(paris.lon).toBeCloseTo(2.4414, 3);
  });

  it('taipei resolves at Songshan (RCSS), not Taoyuan', () => {
    // Market description names Songshan (downtown). Taoyuan is 30km west on
    // the coast and systematically cooler — the residual that kept taipei in
    // WEATHER_EXCLUDED_CITIES.
    const taipei = CITY_COORDINATES.taipei;
    expect(taipei.wuStation).toBe('RCSS');
    expect(taipei.resolutionSource).toBe('wu');
    expect(taipei.lat).toBeCloseTo(25.0694, 3);
    expect(taipei.lon).toBeCloseTo(121.5521, 3);
  });

  it('forecast coordinates sit at the resolution station, not the city center', () => {
    // Spot-check the largest geography gaps the 2026-06-12 audit fixed: if
    // someone reverts a station's coords to downtown, the forecast re-acquires
    // a terrain offset cityBias cannot reliably absorb.
    const stationCoords: { city: string; lat: number; lon: number }[] = [
      { city: 'los angeles', lat: 33.9416, lon: -118.4085 }, // KLAX coast, not downtown
      { city: 'chicago',     lat: 41.9786, lon: -87.9048 },  // KORD
      { city: 'ankara',      lat: 40.1281, lon: 32.9951 },   // LTAC, 25km out, +200m
      { city: 'jeddah',      lat: 21.6796, lon: 39.1565 },   // OEJN
      { city: 'buenos aires', lat: -34.8222, lon: -58.5358 }, // SAEZ Ezeiza
    ];
    for (const { city, lat, lon } of stationCoords) {
      const entry = CITY_COORDINATES[city];
      expect(entry, `${city} missing`).toBeDefined();
      expect(entry!.lat, `${city} lat`).toBeCloseTo(lat, 3);
      expect(entry!.lon, `${city} lon`).toBeCloseTo(lon, 3);
    }
  });

  it('tracks all cities discovered live on Polymarket 2026-06-12, stations per their descriptions', () => {
    // Station-audit discovery: these 20 cities had active markets with no
    // CITY_COORDINATES entry. ICAOs come from the market descriptions' WU
    // URLs; every one verified to return WU observations before adding.
    const discovered: { city: string; station: string; iso: string; tz: string }[] = [
      { city: 'beijing',      station: 'ZBAA', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'busan',        station: 'RKPK', iso: 'KR', tz: 'Asia/Seoul' },
      { city: 'cape town',    station: 'FACT', iso: 'ZA', tz: 'Africa/Johannesburg' },
      { city: 'chengdu',      station: 'ZUUU', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'chongqing',    station: 'ZUCK', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'guangzhou',    station: 'ZGGG', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'helsinki',     station: 'EFHK', iso: 'FI', tz: 'Europe/Helsinki' },
      { city: 'jinan',        station: 'ZSJN', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'karachi',      station: 'OPKC', iso: 'PK', tz: 'Asia/Karachi' },
      { city: 'kuala lumpur', station: 'WMKK', iso: 'MY', tz: 'Asia/Kuala_Lumpur' },
      { city: 'manila',       station: 'RPLL', iso: 'PH', tz: 'Asia/Manila' },
      { city: 'munich',       station: 'EDDM', iso: 'DE', tz: 'Europe/Berlin' },
      { city: 'qingdao',      station: 'ZSQD', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'seoul',        station: 'RKSI', iso: 'KR', tz: 'Asia/Seoul' },
      { city: 'shanghai',     station: 'ZSPD', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'singapore',    station: 'WSSS', iso: 'SG', tz: 'Asia/Singapore' },
      { city: 'tokyo',        station: 'RJTT', iso: 'JP', tz: 'Asia/Tokyo' },
      { city: 'wellington',   station: 'NZWN', iso: 'NZ', tz: 'Pacific/Auckland' },
      { city: 'wuhan',        station: 'ZHHH', iso: 'CN', tz: 'Asia/Shanghai' },
      { city: 'zhengzhou',    station: 'ZHCC', iso: 'CN', tz: 'Asia/Shanghai' },
    ];
    for (const { city, station, iso, tz } of discovered) {
      const entry = CITY_COORDINATES[city];
      expect(entry, `${city} missing from CITY_COORDINATES`).toBeDefined();
      expect(entry!.wuStation, `${city} station`).toBe(station);
      expect(entry!.resolutionSource, `${city} source`).toBe('wu');
      expect(entry!.unit, `${city} unit`).toBe('celsius');
      expect(entry!.isoCountry, `${city} iso`).toBe(iso);
      expect(entry!.tz, `${city} tz`).toBe(tz);
    }
  });
});

describe('canonicalCityKey / lookupCity', () => {
  it('resolves aliases to canonical keys', () => {
    expect(canonicalCityKey('NYC')).toBe('new york');
    expect(canonicalCityKey('nyc')).toBe('new york');
    expect(canonicalCityKey('são paulo')).toBe('sao paulo');
    expect(canonicalCityKey('Tel Aviv')).toBe('tel aviv');
  });

  it('returns null for unknown city', () => {
    expect(canonicalCityKey('atlantis')).toBe(null);
    expect(lookupCity('atlantis')).toBe(null);
  });
});

describe('estimateBracketProbability — floor semantics (one-decimal sources)', () => {
  // Floor boundaries sit exactly +0.5° above round boundaries, so
  // P_floor(forecast) must equal P_round(forecast − 0.5) for every shape.
  const σ = 2.0;

  it('interior bracket: floor equals round shifted by half a degree', () => {
    expect(estimateBracketProbability(31.0, 31, 31, 0, σ, 'floor'))
      .toBeCloseTo(estimateBracketProbability(30.5, 31, 31, 0, σ), 10);
    expect(estimateBracketProbability(33.2, 31, 31, 0, σ, 'floor'))
      .toBeCloseTo(estimateBracketProbability(32.7, 31, 31, 0, σ), 10);
  });

  it('tails: floor equals round shifted by half a degree', () => {
    expect(estimateBracketProbability(31.8, null, 31, 0, σ, 'floor'))
      .toBeCloseTo(estimateBracketProbability(31.3, null, 31, 0, σ), 10); // "31 or below"
    expect(estimateBracketProbability(31.8, 32, null, 0, σ, 'floor'))
      .toBeCloseTo(estimateBracketProbability(31.3, 32, null, 0, σ), 10); // "32 or higher"
  });

  it('floor probabilities are a full ladder (sum to 1 over a partition)', () => {
    // ≤30, 31, 32, ≥33 partitions the line under floor semantics too.
    const fc = 31.5;
    const total =
      estimateBracketProbability(fc, null, 30, 0, σ, 'floor') +
      estimateBracketProbability(fc, 31, 31, 0, σ, 'floor') +
      estimateBracketProbability(fc, 32, 32, 0, σ, 'floor') +
      estimateBracketProbability(fc, 33, null, 0, σ, 'floor');
    expect(total).toBeCloseTo(1.0, 6);
  });

  it('default (no semantics arg) is round — unchanged behavior', () => {
    expect(estimateBracketProbability(52, 52, 53, 1, 3))
      .toBeCloseTo(estimateBracketProbability(52, 52, 53, 1, 3, 'round'), 12);
  });
});
