#!/usr/bin/env tsx
/**
 * Build the climatological exceedance table for the conditional weather oracle.
 *
 * Usage:
 *   npx tsx scripts/build-climo-exceedance.ts \
 *     --city chicago --city london --city "hong kong" \
 *     --years 2010-2024 --out src/weather/data/climoExceedance.json
 *
 * Data source: Open-Meteo Historical API (ERA5 reanalysis) for each city's
 * coordinates. For covered cities where WU station data is available, prefer
 * the station-matched source. ERA5 grid-point data is tagged 'proxy' confidence.
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

const ARCHIVE_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const DEFAULT_OUT = resolve('src/weather/data/climoExceedance.json');

interface Args {
  cities: string[];
  yearRange: [number, number];
  outPath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const cities: string[] = [];
  let yearStart = 2010;
  let yearEnd = 2024;
  let outPath = DEFAULT_OUT;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--city' && argv[i + 1]) {
      cities.push(argv[++i]!);
    } else if (argv[i] === '--years' && argv[i + 1]) {
      const parts = argv[++i]!.split('-');
      yearStart = parseInt(parts[0]!, 10);
      yearEnd = parseInt(parts[1]!, 10);
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = resolve(argv[++i]!);
    }
  }

  return { cities, yearRange: [yearStart, yearEnd], outPath };
}

// City coordinate lookup — matches CityCoordinates in noaaClient.ts.
const CITY_COORDS: Record<string, { lat: number; lon: number; unit: 'fahrenheit' | 'celsius'; tz: string }> = {
  // US (Fahrenheit)
  chicago:         { lat: 41.8781, lon: -87.6298,  unit: 'fahrenheit', tz: 'America/Chicago'       },
  dallas:          { lat: 32.7767, lon: -96.797,   unit: 'fahrenheit', tz: 'America/Chicago'       },
  houston:         { lat: 29.6454, lon: -95.2789,  unit: 'fahrenheit', tz: 'America/Chicago'       },
  miami:           { lat: 25.7617, lon: -80.1918,  unit: 'fahrenheit', tz: 'America/New_York'      },
  'new york':      { lat: 40.7128, lon: -74.006,   unit: 'fahrenheit', tz: 'America/New_York'      },
  denver:          { lat: 39.7016, lon: -104.7516, unit: 'fahrenheit', tz: 'America/Denver'        },
  seattle:         { lat: 47.6062, lon: -122.3321, unit: 'fahrenheit', tz: 'America/Los_Angeles'   },
  atlanta:         { lat: 33.749,  lon: -84.388,   unit: 'fahrenheit', tz: 'America/New_York'      },
  austin:          { lat: 30.2672, lon: -97.7431,  unit: 'fahrenheit', tz: 'America/Chicago'       },
  'los angeles':   { lat: 34.0522, lon: -118.2437, unit: 'fahrenheit', tz: 'America/Los_Angeles'   },
  'san francisco': { lat: 37.7749, lon: -122.4194, unit: 'fahrenheit', tz: 'America/Los_Angeles'   },
  // International (Celsius)
  london:          { lat: 51.5074, lon: -0.1278,   unit: 'celsius',    tz: 'Europe/London'         },
  paris:           { lat: 48.8566, lon: 2.3522,    unit: 'celsius',    tz: 'Europe/Paris'          },
  istanbul:        { lat: 40.9769, lon: 28.8146,   unit: 'celsius',    tz: 'Europe/Istanbul'       },
  amsterdam:       { lat: 52.3676, lon: 4.9041,    unit: 'celsius',    tz: 'Europe/Amsterdam'      },
  madrid:          { lat: 40.4168, lon: -3.7038,   unit: 'celsius',    tz: 'Europe/Madrid'         },
  milan:           { lat: 45.6306, lon: 8.7281,    unit: 'celsius',    tz: 'Europe/Rome'           },
  warsaw:          { lat: 52.2297, lon: 21.0122,   unit: 'celsius',    tz: 'Europe/Warsaw'         },
  moscow:          { lat: 55.5915, lon: 37.2615,   unit: 'celsius',    tz: 'Europe/Moscow'         },
  ankara:          { lat: 39.9334, lon: 32.8597,   unit: 'celsius',    tz: 'Europe/Istanbul'       },
  'tel aviv':      { lat: 31.9965, lon: 34.8906,   unit: 'celsius',    tz: 'Asia/Jerusalem'        },
  jeddah:          { lat: 21.4858, lon: 39.1925,   unit: 'celsius',    tz: 'Asia/Riyadh'           },
  'hong kong':     { lat: 22.3020, lon: 114.1740,  unit: 'celsius',    tz: 'Asia/Hong_Kong'        },
  shenzhen:        { lat: 22.5431, lon: 114.0579,  unit: 'celsius',    tz: 'Asia/Shanghai'         },
  tokyo:           { lat: 35.5494, lon: 139.7798,  unit: 'celsius',    tz: 'Asia/Tokyo'            },
  taipei:          { lat: 25.0777, lon: 121.2328,  unit: 'celsius',    tz: 'Asia/Taipei'           },
  seoul:           { lat: 37.5665, lon: 126.9780,  unit: 'celsius',    tz: 'Asia/Seoul'            },
  lucknow:         { lat: 26.8467, lon: 80.9462,   unit: 'celsius',    tz: 'Asia/Kolkata'          },
  toronto:         { lat: 43.6532, lon: -79.3832,  unit: 'celsius',    tz: 'America/Toronto'       },
  'mexico city':   { lat: 19.4326, lon: -99.1332,  unit: 'celsius',    tz: 'America/Mexico_City'   },
  'panama city':   { lat: 8.9833,  lon: -79.5556,  unit: 'celsius',    tz: 'America/Panama'        },
  'buenos aires':  { lat: -34.6037, lon: -58.3816, unit: 'celsius',    tz: 'America/Argentina/Buenos_Aires' },
  'sao paulo':     { lat: -23.5505, lon: -46.6333, unit: 'celsius',    tz: 'America/Sao_Paulo'     },
};

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
  if (args.cities.length === 0) {
    console.log('Usage: tsx scripts/build-climo-exceedance.ts --city chicago --city london --years 2010-2024');
    process.exit(0);
  }

  let existing: Record<string, unknown> = { _meta: {}, cities: {} };
  if (existsSync(args.outPath)) {
    existing = JSON.parse(readFileSync(args.outPath, 'utf-8')) as Record<string, unknown>;
  }

  const cities = (existing.cities ?? {}) as Record<string, unknown>;

  for (const city of args.cities) {
    const coords = CITY_COORDS[city.toLowerCase()];
    if (!coords) {
      console.warn(`Unknown city: ${city}. Add to CITY_COORDS in this script.`);
      continue;
    }
    console.log(`Building climo table for ${city} (${args.yearRange[0]}–${args.yearRange[1]})...`);

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
    cities[city.toLowerCase()] = cityTable;
    console.log(`  Done: ${city}`);
  }

  const output = {
    _meta: {
      description: 'Empirical conditional exceedance table for the conditional weather oracle.',
      schema: 'city → month (1-12) → localHour (0-23) → sorted array of { delta, exceedance }',
      generatedAt: new Date().toISOString(),
      sourceRange: `${args.yearRange[0]}-${args.yearRange[1]}`,
    },
    cities,
  };

  writeFileSync(args.outPath, JSON.stringify(output));
  console.log(`Written to ${args.outPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
