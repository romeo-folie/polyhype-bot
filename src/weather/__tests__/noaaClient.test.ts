import { describe, it, expect } from 'vitest';
import { CITY_COORDINATES, canonicalCityKey, lookupCity } from '../noaaClient.js';

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

  it('all four cities formerly routed via METAR are now WU-sourced with isoCountry', () => {
    // Regression guard: the 2026-04-24 backfill audit found LTFM/LLBG/UUWW/RCTP
    // failing because aviationweather.gov caps obs at ~400 (~9d window), so
    // anything older dropped out of the canonical-resolution backfill. Keeping
    // these on WU is load-bearing — reverting would silently re-strand
    // istanbul/tel aviv/moscow/taipei resolution_high rows in the DB.
    const formerlyMetar: Array<{ city: string; station: string; iso: string }> = [
      { city: 'tel aviv', station: 'LLBG', iso: 'IL' },
      { city: 'istanbul', station: 'LTBA', iso: 'TR' }, // LTFM → LTBA; new IST airport not in WU
      { city: 'moscow',   station: 'UUWW', iso: 'RU' },
      { city: 'taipei',   station: 'RCTP', iso: 'TW' },
    ];
    for (const { city, station, iso } of formerlyMetar) {
      const entry = CITY_COORDINATES[city];
      expect(entry, `${city} missing from CITY_COORDINATES`).toBeDefined();
      expect(entry!.resolutionSource).toBe('wu');
      expect(entry!.wuStation).toBe(station);
      expect(entry!.isoCountry).toBe(iso);
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
