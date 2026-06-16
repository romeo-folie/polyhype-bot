#!/usr/bin/env tsx
/**
 * Build the climatological exceedance table for the conditional weather oracle.
 *
 * Usage:
 *   npx tsx scripts/build-climo-exceedance.ts --all --years 2010-2024            # rise table (highest-temp)
 *   npx tsx scripts/build-climo-exceedance.ts --all --metric low --years 2010-2024  # fall table (lowest-temp)
 *   npx tsx scripts/build-climo-exceedance.ts --all --source wu --years 2010-2024   # WU station-history table
 *   npx tsx scripts/build-climo-exceedance.ts --all --source auto                  # WU for WU cities, ERA5 fallback otherwise
 *   npx tsx scripts/build-climo-exceedance.ts --city chicago --city "hong kong"  # incremental merge
 *
 * --metric high (default) builds the RISE table P(finalMax > runningMax + delta)
 * written to climoExceedance.json. --metric low builds the FALL table
 * P(runningMin − finalMin > delta) written to climoFallExceedance.json — the
 * lowest-temperature conditional oracle's climo fallback.
 *
 * City list and coordinates are imported from src/weather/noaaClient.ts
 * (CITY_COORDINATES) — the same table the live oracle and forecast pipeline
 * use — so coordinate corrections propagate automatically. After any change
 * to CITY_COORDINATES (coords moved, cities added), re-run with --all and
 * commit the regenerated JSON; the climoTable integrity test fails until the
 * table matches the runtime city list again.
 *
 * Data sources:
 *   --source wu          Weather Underground historical hourly observations for
 *                        WU-resolution cities. This is the settlement-aligned
 *                        source for most Polymarket weather markets.
 *   --source open-meteo  Open-Meteo Historical API (ERA5 reanalysis) at runtime
 *                        coordinates. ERA5 grid data has compressed extremes vs
 *                        station observations; use as a proxy/fallback only.
 *   --source auto        WU for WU-resolution cities, Open-Meteo otherwise.
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
import { pathToFileURL } from 'url';
import { CITY_COORDINATES, canonicalCityKey } from '../src/weather/noaaClient.js';
import {
  fetchWuHistoricalHourlyObservations,
  type WuHistoricalHourlyObservation,
} from '../src/weather/wuClient.js';

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const RISE_OUT = resolve('src/weather/data/climoExceedance.json');
const FALL_OUT = resolve('src/weather/data/climoFallExceedance.json');

interface Args {
  cities: string[];
  /** True when --all was passed: rebuild every runtime city from scratch (no merge). */
  all: boolean;
  yearRange: [number, number];
  outPath: string;
  /** 'high' → rise table (daily max); 'low' → fall table (daily min). */
  metric: 'high' | 'low';
  /** Historical source used to build hourly local-day paths. */
  source: 'open-meteo' | 'wu' | 'auto';
  /** Delay between WU daily calls. WU source makes one request per city/day. */
  wuDelayMs: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const cities: string[] = [];
  let all = false;
  let yearStart = 2010;
  let yearEnd = 2024;
  let outPath: string | null = null;
  let metric: 'high' | 'low' = 'high';
  let source: Args['source'] = 'open-meteo';
  let wuDelayMs = 250;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--city' && argv[i + 1]) {
      cities.push(argv[++i]!);
    } else if (argv[i] === '--all') {
      all = true;
    } else if (argv[i] === '--metric' && argv[i + 1]) {
      const m = argv[++i]!;
      if (m !== 'high' && m !== 'low') {
        console.error(`Invalid --metric '${m}': expected 'high' or 'low'`);
        process.exit(1);
      }
      metric = m;
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
    } else if (argv[i] === '--source' && argv[i + 1]) {
      const s = argv[++i]!;
      if (s !== 'open-meteo' && s !== 'wu' && s !== 'auto') {
        console.error(`Invalid --source '${s}': expected open-meteo, wu, or auto`);
        process.exit(1);
      }
      source = s;
    } else if (argv[i] === '--wu-delay-ms' && argv[i + 1]) {
      wuDelayMs = parseInt(argv[++i]!, 10);
      if (!Number.isFinite(wuDelayMs) || wuDelayMs < 0) {
        console.error(`Invalid --wu-delay-ms '${argv[i]}': expected non-negative integer`);
        process.exit(1);
      }
    }
  }

  // Default output path follows the metric so the two tables never overwrite.
  if (outPath === null) outPath = metric === 'low' ? FALL_OUT : RISE_OUT;

  return { cities, all, yearRange: [yearStart, yearEnd], outPath, metric, source, wuDelayMs };
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

function formatDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function* datesInYear(year: number): Generator<string> {
  const cursor = new Date(Date.UTC(year, 0, 1));
  while (cursor.getUTCFullYear() === year) {
    yield formatDateUtc(cursor);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function makeMemoryRedis() {
  const cache = new Map<string, string>();
  return {
    async get(key: string) {
      return cache.get(key) ?? null;
    },
    async set(key: string, value: string) {
      cache.set(key, value);
      return 'OK';
    },
  };
}

async function fetchWuHourlyForYear(
  city: string,
  icao: string,
  isoCountry: string,
  unit: 'fahrenheit' | 'celsius',
  year: number,
  delayMs: number,
  redis: ReturnType<typeof makeMemoryRedis>,
): Promise<Record<string, WuHistoricalHourlyObservation[]> | null> {
  const result: Record<string, WuHistoricalHourlyObservation[]> = {};
  let fetched = 0;
  let missing = 0;

  for (const day of datesInYear(year)) {
    const obs = await fetchWuHistoricalHourlyObservations(
      icao,
      isoCountry,
      day,
      unit,
      redis as never,
    );
    if (obs?.length) {
      result[day] = obs;
      fetched++;
    } else {
      missing++;
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  console.log(`    WU ${city} ${year}: ${fetched} days fetched, ${missing} missing`);
  return Object.keys(result).length ? result : null;
}

export function localDateHourFromUtc(
  utcIso: string,
  tz: string,
): { date: string; month: number; hour: number } | null {
  const date = new Date(utcIso);
  if (!Number.isFinite(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  if (!year || !month || !day || !hour) return null;
  return {
    date: `${year}-${month}-${day}`,
    month: parseInt(month, 10),
    hour: parseInt(hour, 10) % 24,
  };
}

function buildMonthHourMap(
  dailyHourly: Record<string, number[]>,
  tz: string,
  metric: 'high' | 'low' = 'high',
): MonthHourMap {
  const map: MonthHourMap = {};
  for (const [day, temps] of Object.entries(dailyHourly)) {
    if (temps.length < 20) continue; // incomplete day
    const date = new Date(day + 'T12:00:00Z');
    const month = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric' }).format(date), 10);

    // 'high': delta = finalMax − runningMax (how much further the day climbs).
    // 'low':  delta = runningMin − finalMin (how much further the day drops).
    // Both are ≥ 0 by construction, so the exceedance table semantics match.
    const finalExtreme = metric === 'low' ? Math.min(...temps) : Math.max(...temps);

    for (let h = 0; h < temps.length && h <= 23; h++) {
      let running = metric === 'low' ? Infinity : -Infinity;
      for (let i = 0; i <= h; i++) {
        const v = temps[i];
        if (v === undefined || !isFinite(v)) continue;
        if (metric === 'low' ? v < running : v > running) running = v;
      }
      if (!isFinite(running)) continue;
      const delta = metric === 'low' ? running - finalExtreme : finalExtreme - running;
      if (!map[month]) map[month] = {};
      if (!map[month]![h]) map[month]![h] = [];
      map[month]![h]!.push(delta);
    }
  }
  return map;
}

export function buildMonthHourMapFromWuObservations(
  dailyObservations: Record<string, WuHistoricalHourlyObservation[]>,
  tz: string,
  metric: 'high' | 'low' = 'high',
): MonthHourMap {
  const byLocalDay: Record<string, { month: number; byHour: Record<number, number[]> }> = {};

  for (const obs of Object.values(dailyObservations).flat()) {
    const local = localDateHourFromUtc(obs.observedAt, tz);
    if (!local || !Number.isFinite(obs.temp)) continue;
    byLocalDay[local.date] ??= { month: local.month, byHour: {} };
    byLocalDay[local.date]!.byHour[local.hour] ??= [];
    byLocalDay[local.date]!.byHour[local.hour]!.push(obs.temp);
  }

  const map: MonthHourMap = {};
  for (const { month, byHour } of Object.values(byLocalDay)) {
    const hourlyTemps = Object.entries(byHour)
      .map(([hour, temps]) => ({
        hour: parseInt(hour, 10),
        temp: metric === 'low' ? Math.min(...temps) : Math.max(...temps),
      }))
      .filter((entry) => Number.isFinite(entry.hour) && Number.isFinite(entry.temp))
      .sort((a, b) => a.hour - b.hour);
    if (hourlyTemps.length < 20) continue;

    const finalExtreme = metric === 'low'
      ? Math.min(...hourlyTemps.map((entry) => entry.temp))
      : Math.max(...hourlyTemps.map((entry) => entry.temp));

    for (const { hour } of hourlyTemps) {
      const elapsed = hourlyTemps.filter((entry) => entry.hour <= hour).map((entry) => entry.temp);
      const running = metric === 'low' ? Math.min(...elapsed) : Math.max(...elapsed);
      if (!Number.isFinite(running)) continue;
      const delta = metric === 'low' ? running - finalExtreme : finalExtreme - running;
      if (!map[month]) map[month] = {};
      if (!map[month]![hour]) map[month]![hour] = [];
      map[month]![hour]!.push(delta);
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
    console.log(
      'Usage: tsx scripts/build-climo-exceedance.ts (--all | --city chicago --city "hong kong" ...) ' +
      '[--years 2010-2024] [--metric high|low] [--source open-meteo|wu|auto] [--wu-delay-ms 250]',
    );
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
  const wuRedis = makeMemoryRedis();

  for (const cityArg of targetCities) {
    const city = canonicalCityKey(cityArg) ?? cityArg.toLowerCase();
    const coords = CITY_COORDINATES[city];
    if (!coords) {
      console.warn(`Unknown city: ${cityArg}. Must exist in CITY_COORDINATES (src/weather/noaaClient.ts).`);
      continue;
    }
    const sourceForCity = args.source === 'auto'
      ? (coords.resolutionSource === 'wu' ? 'wu' : 'open-meteo')
      : args.source;
    if (sourceForCity === 'wu' && (coords.resolutionSource !== 'wu' || !coords.isoCountry)) {
      console.warn(
        `Skipping ${city}: --source wu requires a WU-resolution city with isoCountry ` +
        `(resolutionSource=${coords.resolutionSource}, isoCountry=${coords.isoCountry ?? 'missing'}).`,
      );
      continue;
    }
    console.log(
      `Building climo table for ${city} (${args.yearRange[0]}–${args.yearRange[1]}, ` +
      `${sourceForCity}, ${coords.lat},${coords.lon})...`,
    );

    const combined: MonthHourMap = {};
    for (let year = args.yearRange[0]; year <= args.yearRange[1]; year++) {
      console.log(`  Fetching ${year}...`);
      const dailyHourly = sourceForCity === 'wu'
        ? await fetchWuHourlyForYear(
          city,
          coords.wuStation,
          coords.isoCountry!,
          coords.unit,
          year,
          args.wuDelayMs,
          wuRedis,
        )
        : await fetchHourlyForYear(coords.lat, coords.lon, coords.unit, year);
      if (!dailyHourly) continue;
      const yearMap = sourceForCity === 'wu'
        ? buildMonthHourMapFromWuObservations(
          dailyHourly as Record<string, WuHistoricalHourlyObservation[]>,
          coords.tz,
          args.metric,
        )
        : buildMonthHourMap(dailyHourly as Record<string, number[]>, coords.tz, args.metric);
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
      resolutionSource: coords.resolutionSource,
      wuStation: coords.wuStation,
      source: sourceForCity === 'wu' ? 'weather-underground-historical' : 'open-meteo-archive-era5',
      years: `${args.yearRange[0]}-${args.yearRange[1]}`,
      generatedAt: new Date().toISOString(),
    };
    console.log(`  Done: ${city}`);
  }

  const output = {
    _meta: {
      description: args.metric === 'low'
        ? 'Empirical conditional FALL exceedance table for the lowest-temperature conditional oracle.'
        : 'Empirical conditional RISE exceedance table for the conditional weather oracle.',
      metric: args.metric,
      schema: args.metric === 'low'
        ? 'city → month (1-12) → localHour (0-23) → sorted array of { delta, exceedance } where exceedance = P(runningMin − finalMin > delta)'
        : 'city → month (1-12) → localHour (0-23) → sorted array of { delta, exceedance } where exceedance = P(finalMax > runningMax + delta)',
      generatedAt: new Date().toISOString(),
      sourceRange: `${args.yearRange[0]}-${args.yearRange[1]}`,
      source: args.source,
      cityProvenance,
    },
    cities,
  };

  writeFileSync(args.outPath, JSON.stringify(output));
  console.log(`Written to ${args.outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
