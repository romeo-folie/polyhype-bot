#!/usr/bin/env tsx
/**
 * Build the climatological exceedance table for the conditional weather oracle.
 *
 * Usage:
 *   npx tsx scripts/build-climo-exceedance.ts --all --years 2010-2024   # full rebuild (preferred)
 *   npx tsx scripts/build-climo-exceedance.ts --city chicago --city "hong kong"  # incremental merge
 *
 * City list and coordinates are imported from src/weather/noaaClient.ts
 * (CITY_COORDINATES) — the same table the live oracle and forecast pipeline
 * use — so coordinate corrections propagate automatically. After any change
 * to CITY_COORDINATES (coords moved, cities added), re-run with --all and
 * commit the regenerated JSON; the climoTable integrity test fails until the
 * table matches the runtime city list again.
 *
 * Data source: Open-Meteo Historical API (ERA5 reanalysis) at the city's
 * runtime coordinates. NOTE: ERA5 grid data has compressed extremes vs
 * station observations (verified 2026-06-11: Milan June 15:00 max 15-year
 * rise reads 1.7°C) — the table understates tail rises. Acceptable for the
 * fallback/clamp role; a station-history build (WU/ISD) is the planned
 * replacement for cities where the fallback binds.
 *
 * Table schema:
 *   city → month (1-12) → localHour (0-23) →
 *     sorted array of { delta, exceedance } where
 *     exceedance = P(finalDailyMax > runningMax + delta | localHour, month, city)
 *
 * Algorithm:
 *   For each historical day d and city:
 *     For each local hour H from 0 to 23:
 *       runningMax_H = max(hourly temps from 00:00 to H)
 *       finalMax = max(all hourly temps for day d)
 *       rise = finalMax − runningMax_H
 *       → contribute to (city, month, hour H, rise) histogram
 *   Empirical exceedance at each delta = fraction of (day, hour) pairs with rise > delta
 *
 * This is a one-time/refreshable offline script. The resulting JSON is committed
 * and loaded by the conditional oracle at runtime.
 */

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { CITY_COORDINATES, canonicalCityKey } from '../src/weather/noaaClient.js';

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const DEFAULT_OUT = resolve('src/weather/data/climoExceedance.json');

interface Args {
  cities: string[];
  /** True when --all was passed: rebuild every runtime city from scratch (no merge). */
  all: boolean;
  yearRange: [number, number];
  outPath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const cities: string[] = [];
  let all = false;
  let yearStart = 2010;
  let yearEnd = 2024;
  let outPath = DEFAULT_OUT;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--city' && argv[i + 1]) {
      cities.push(argv[++i]!);
    } else if (argv[i] === '--all') {
      all = true;
    } else if (argv[i] === '--years' && argv[i + 1]) {
      const parts = argv[++i]!.split('-');
      const start = parts[0] ? parseInt(parts[0], 10) : NaN;
      const end = parts[1] ? parseInt(parts[1], 10) : NaN;
      if (parts.length !== 2 || !Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        console.error(`Invalid --years '${argv[i]}': expected START-END, e.g. 2010-2024`);
        process.exit(1);
      }
      yearStart = start;
      yearEnd = end;
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = resolve(argv[++i]!);
    }
  }

  return { cities, all, yearRange: [yearStart, yearEnd], outPath };
}

// City list and coordinates come from the runtime table (src/weather/noaaClient.ts)
// so coordinate corrections there propagate here automatically. Do NOT maintain
// a separate city list in this script — a hand-synced duplicate drifted twice
// (wrong 'hongkong' key; 25 stale coords + 17 missing cities after PR #485/#488).

type MonthHourMap = Record<number, Record<number, number[]>>; // month → hour → rises[]

async function fetchHourlyForYear(
  lat: number, lon: number, unit: 'fahrenheit' | 'celsius', year: number,
): Promise<Record<string, number[]> | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: 'temperature_2m',
    temperature_unit: unit,
    timezone: 'auto',
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
  });
  const url = `${ARCHIVE_BASE}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Archive API error: ${res.status} for ${year}`);
    return null;
  }
  const data = await res.json() as { hourly?: { time?: string[]; temperature_2m?: number[] } };
  if (!data.hourly?.time || !data.hourly.temperature_2m) return null;
  const result: Record<string, number[]> = {};
  for (let i = 0; i < data.hourly.time.length; i++) {
    const dt = data.hourly.time[i]!;
    const t = data.hourly.temperature_2m[i];
    if (typeof t !== 'number' || !isFinite(t)) continue;
    const day = dt.slice(0, 10);
    if (!result[day]) result[day] = [];
    result[day].push(t);
  }
  return result;
}

function buildMonthHourMap(dailyHourly: Record<string, number[]>, tz: string): MonthHourMap {
  const map: MonthHourMap = {};
  for (const [day, temps] of Object.entries(dailyHourly)) {
    if (temps.length < 20) continue; // incomplete day
    const date = new Date(day + 'T12:00:00Z');
    const month = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(date), 10);
    const finalMax = Math.max(...temps);

    for (let h = 0; h < temps.length && h <= 23; h++) {
      let runningMax = -Infinity;
      for (let i = 0; i <= h; i++) {
        const v = temps[i];
        if (v !== undefined && isFinite(v) && v > runningMax) runningMax = v;
      }
      if (!isFinite(runningMax)) continue;
      const rise = finalMax - runningMax;
      if (!map[month]) map[month] = {};
      if (!map[month]![h]) map[month]![h] = [];
      map[month]![h]!.push(rise);
    }
  }
  return map;
}

function computeExceedanceTable(rises: number[], nQuantiles = 20): Array<{ delta: number; exceedance: number }> {
  if (rises.length === 0) return [];
  const sorted = [...rises].sort((a, b) => a - b);
  const result: Array<{ delta: number; exceedance: number }> = [];
  const step = (sorted[sorted.length - 1]! - sorted[0]!) / nQuantiles;
  for (let i = 0; i <= nQuantiles; i++) {
    const delta = sorted[0]! + step * i;
    const exceedance = sorted.filter((r) => r > delta).length / sorted.length;
    result.push({ delta: Math.round(delta * 100) / 100, exceedance: Math.round(exceedance * 1000) / 1000 });
  }
  return result;
}

async function main() {
  const args = parseArgs();
  if (!args.all && args.cities.length === 0) {
    console.log('Usage: tsx scripts/build-climo-exceedance.ts (--all | --city chicago --city "hong kong" ...) [--years 2010-2024]');
    process.exit(0);
  }

  // --all: rebuild every runtime city from an empty table so the output has a
  // single provenance (no stale-coordinate cities merged in from a prior build).
  // --city: incremental merge into the existing file.
  let existing: Record<string, unknown> = { _meta: {}, cities: {} };
  if (!args.all && existsSync(args.outPath)) {
    existing = JSON.parse(readFileSync(args.outPath, 'utf-8')) as Record<string, unknown>;
  }

  const cities = (existing.cities ?? {}) as Record<string, unknown>;
  const cityProvenance = ((existing._meta as Record<string, unknown> | undefined)?.cityProvenance ?? {}) as Record<string, unknown>;

  const targetCities = args.all ? Object.keys(CITY_COORDINATES) : args.cities;

  for (const cityArg of targetCities) {
    const city = canonicalCityKey(cityArg) ?? cityArg.toLowerCase();
    const coords = CITY_COORDINATES[city];
    if (!coords) {
      console.warn(`Unknown city: ${cityArg}. Must exist in CITY_COORDINATES (src/weather/noaaClient.ts).`);
      continue;
    }
    console.log(`Building climo table for ${city} (${args.yearRange[0]}–${args.yearRange[1]}, ${coords.lat},${coords.lon})...`);

    const combined: MonthHourMap = {};
    for (let year = args.yearRange[0]; year <= args.yearRange[1]; year++) {
      console.log(`  Fetching ${year}...`);
      const dailyHourly = await fetchHourlyForYear(coords.lat, coords.lon, coords.unit, year);
      if (!dailyHourly) continue;
      const yearMap = buildMonthHourMap(dailyHourly, coords.tz);
      for (const [mStr, hours] of Object.entries(yearMap)) {
        const m = parseInt(mStr, 10);
        if (!combined[m]) combined[m] = {};
        for (const [hStr, rises] of Object.entries(hours)) {
          const h = parseInt(hStr, 10);
          if (!combined[m]![h]) combined[m]![h] = [];
          combined[m]![h]!.push(...rises);
        }
      }
      await new Promise((r) => setTimeout(r, 500)); // rate limit
    }

    const cityTable: Record<number, Record<number, Array<{ delta: number; exceedance: number }>>> = {};
    for (const [mStr, hours] of Object.entries(combined)) {
      const m = parseInt(mStr, 10);
      cityTable[m] = {};
      for (const [hStr, rises] of Object.entries(hours)) {
        const h = parseInt(hStr, 10);
        cityTable[m]![h] = computeExceedanceTable(rises);
      }
    }
    cities[city] = cityTable;
    // Per-city provenance: lets the table-integrity test detect coordinate drift
    // between this build and the runtime CITY_COORDINATES table.
    cityProvenance[city] = {
      lat: coords.lat,
      lon: coords.lon,
      unit: coords.unit,
      source: 'open-meteo-archive-era5',
      years: `${args.yearRange[0]}-${args.yearRange[1]}`,
      generatedAt: new Date().toISOString(),
    };
    console.log(`  Done: ${city}`);
  }

  const output = {
    _meta: {
      description: 'Empirical conditional exceedance table for the conditional weather oracle.',
      schema: 'city → month (1-12) → localHour (0-23) → sorted array of { delta, exceedance }',
      generatedAt: new Date().toISOString(),
      sourceRange: `${args.yearRange[0]}-${args.yearRange[1]}`,
      cityProvenance,
    },
    cities,
  };

  writeFileSync(args.outPath, JSON.stringify(output));
  console.log(`Written to ${args.outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
