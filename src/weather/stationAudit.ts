/**
 * Weather resolution-station audit.
 *
 * Every Polymarket weather market names its resolution station in the market
 * description (a Wunderground history URL, a NOAA weather.gov timeseries link,
 * or the Hong Kong Observatory). Our forecasts and ground truth are only as
 * good as `CITY_COORDINATES` agreeing with those descriptions — a silent
 * station switch (or a wrong assumption like Istanbul LTBA vs the market's
 * LTFM) makes the model price a different thermometer than the one the market
 * settles on, which cityBias cannot absorb.
 *
 * This audit parses the descriptions of all active weather events, compares
 * each city's station/source against our table, and alerts on mismatches.
 * Cities Polymarket trades that we don't track are surfaced (deduped) as
 * expansion candidates.
 *
 * Log marker: [weather-station-audit]
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { notify } from '../execution/telegram.js';
import { lookupCity, canonicalCityKey } from './noaaClient.js';
import {
  fetchWeatherEvents,
  extractCityFromTitle,
  type WeatherGammaEvent,
} from './weatherScanner.js';

const MISMATCH_ALERT_TTL_S = 3 * 24 * 60 * 60; // re-alert a persisting mismatch every 3 days
const UNKNOWN_CITY_TTL_S = 30 * 24 * 60 * 60; // surface each untracked city once a month
const AUDIT_EVENT_LIMIT = 100;

export type ResolutionSourceType = 'wu' | 'noaa' | 'hko' | 'unknown';

export interface ParsedResolutionSource {
  sourceType: ResolutionSourceType;
  /** ICAO/station id when the description embeds one (WU URL path or weather.gov ?site=). */
  stationId: string | null;
  /** Human-readable station name from the prose, when present. */
  stationName: string | null;
}

export interface StationMismatch {
  city: string;
  eventSlug: string;
  expectedStation: string;
  expectedSource: string;
  actual: ParsedResolutionSource;
}

export interface StationAuditResult {
  checked: number;
  mismatches: StationMismatch[];
  /** Cities with active markets that are absent from CITY_COORDINATES. */
  unknownCities: string[];
  /** Cities whose description carried no comparable station id. */
  uncomparable: string[];
}

/**
 * Extract the resolution source type and station from a market description.
 *
 * Order matters: the Hong Kong Observatory's domain is `weather.gov.hk`,
 * which contains `weather.gov` — match HKO before NOAA.
 */
export function parseResolutionStation(description: string): ParsedResolutionSource {
  const nameMatch = description.match(
    /recorded (?:by (?:NOAA|the Hong Kong Observatory) )?at the (.+?)(?: Station)? in degrees/i,
  );
  const stationName = nameMatch?.[1]?.trim() ?? null;

  if (/Hong Kong Observatory|weather\.gov\.hk/i.test(description)) {
    return { sourceType: 'hko', stationId: 'HKO', stationName: stationName ?? 'Hong Kong Observatory' };
  }

  const noaaSite = description.match(/weather\.gov\/wrh\/timeseries\?site=([A-Z0-9]{3,5})/i)?.[1];
  if (noaaSite) {
    return { sourceType: 'noaa', stationId: noaaSite.toUpperCase(), stationName };
  }

  const wuUrl = description.match(
    /wunderground\.com\/history\/daily\/[^/\s]+\/[^/\s]+\/([A-Z0-9]{3,5})/i,
  )?.[1];
  if (/wunderground/i.test(description)) {
    return { sourceType: 'wu', stationId: wuUrl ? wuUrl.toUpperCase() : null, stationName };
  }

  return { sourceType: 'unknown', stationId: null, stationName };
}

/**
 * Whether a parsed market source is compatible with our configured fetcher.
 *
 * WU, NOAA's timeseries page, and METAR all render the same ICAO observation
 * feed — any of them is acceptable as long as the STATION matches. HKO is its
 * own network with no ICAO, so source type must match exactly.
 */
function sourceCompatible(ourSource: string, marketSource: ResolutionSourceType): boolean {
  if (ourSource === 'hko' || marketSource === 'hko') return ourSource === 'hko' && marketSource === 'hko';
  return marketSource === 'wu' || marketSource === 'noaa';
}

/**
 * Compare active weather events against CITY_COORDINATES. Pure — callers
 * handle alerting. Events with unparseable titles are skipped; one event per
 * city is enough (all of a city's events share the same description template).
 */
export function auditWeatherStations(events: WeatherGammaEvent[]): StationAuditResult {
  const mismatches: StationMismatch[] = [];
  const unknownCities = new Set<string>();
  const uncomparable = new Set<string>();
  const seenCities = new Set<string>();
  let checked = 0;

  for (const event of events) {
    const cityRaw = extractCityFromTitle(event.title);
    if (!cityRaw) continue;

    const canonical = canonicalCityKey(cityRaw);
    if (!canonical) {
      unknownCities.add(cityRaw.toLowerCase());
      continue;
    }
    if (seenCities.has(canonical)) continue;
    seenCities.add(canonical);

    const description = event.markets?.find((m) => m.description)?.description;
    if (!description) {
      uncomparable.add(canonical);
      continue;
    }

    const coords = lookupCity(canonical);
    if (!coords) continue; // canonicalCityKey already guarantees presence; defensive

    const parsed = parseResolutionStation(description);
    if (parsed.sourceType === 'unknown') {
      // Unrecognized description format — nothing to compare against. Don't
      // alert: a Polymarket template change would otherwise page once per
      // city. The uncomparable list in the audit log is the signal to update
      // parseResolutionStation.
      uncomparable.add(canonical);
      continue;
    }
    checked++;

    const stationMismatch = parsed.stationId !== null && parsed.stationId !== coords.wuStation;
    const srcMismatch = !sourceCompatible(coords.resolutionSource, parsed.sourceType);
    if (parsed.stationId === null && parsed.sourceType !== 'hko') {
      // Prose-only description (most US markets) — no machine-comparable id.
      // Source-type conflicts are still meaningful (e.g. ours=hko, market=wu).
      if (srcMismatch) {
        mismatches.push({
          city: canonical,
          eventSlug: event.slug,
          expectedStation: coords.wuStation,
          expectedSource: coords.resolutionSource,
          actual: parsed,
        });
      } else {
        uncomparable.add(canonical);
      }
      continue;
    }

    if (stationMismatch || srcMismatch) {
      mismatches.push({
        city: canonical,
        eventSlug: event.slug,
        expectedStation: coords.wuStation,
        expectedSource: coords.resolutionSource,
        actual: parsed,
      });
    }
  }

  return {
    checked,
    mismatches,
    unknownCities: [...unknownCities].sort(),
    uncomparable: [...uncomparable].sort(),
  };
}

/**
 * Fetch active weather events, audit them, and alert on findings.
 * Mismatch alerts re-fire every 3 days while the mismatch persists; untracked
 * cities are mentioned at most once every 30 days. Never throws.
 */
export async function runStationAudit(
  redis: Redis,
  events?: WeatherGammaEvent[],
): Promise<StationAuditResult | null> {
  try {
    const evts = events ?? (await fetchWeatherEvents(AUDIT_EVENT_LIMIT));
    if (evts.length === 0) {
      logger.info('[weather-station-audit] no events to audit');
      return null;
    }

    const result = auditWeatherStations(evts);
    logger.info('[weather-station-audit] audit complete', {
      checked: result.checked,
      mismatches: result.mismatches.length,
      unknownCities: result.unknownCities.length,
      uncomparable: result.uncomparable,
    });

    for (const mm of result.mismatches) {
      const dedupKey = `weather:station_audit:mismatch:${mm.city}:${mm.actual.stationId ?? mm.actual.sourceType}`;
      const fresh = await redis.set(dedupKey, '1', 'EX', MISMATCH_ALERT_TTL_S, 'NX');
      logger.error('[weather-station-audit] resolution station mismatch', { ...mm });
      if (fresh === 'OK') {
        await notify(
          `🚨 *Weather station mismatch* — ${mm.city}\n` +
            `Market resolves: ${mm.actual.stationId ?? mm.actual.stationName ?? '?'} (${mm.actual.sourceType})\n` +
            `We track: ${mm.expectedStation} (${mm.expectedSource})\n` +
            `Event: ${mm.eventSlug}\n` +
            `Forecasts/ground truth for this city are mispointed — fix CITY_COORDINATES.`,
        ).catch(() => {});
      }
    }

    const newCities: string[] = [];
    for (const city of result.unknownCities) {
      const fresh = await redis.set(
        `weather:station_audit:unknown_city:${city}`,
        '1',
        'EX',
        UNKNOWN_CITY_TTL_S,
        'NX',
      );
      if (fresh === 'OK') newCities.push(city);
    }
    if (newCities.length > 0) {
      logger.info('[weather-station-audit] untracked cities with active markets', { cities: newCities });
      await notify(
        `🌍 Weather: Polymarket runs markets for ${newCities.length} cit${newCities.length === 1 ? 'y' : 'ies'} we don't track yet:\n` +
          `${newCities.join(', ')}\n` +
          `Each needs a CITY_COORDINATES entry (station, coords, tz) to trade.`,
      ).catch(() => {});
    }

    return result;
  } catch (err) {
    logger.warn('[weather-station-audit] audit failed — continuing', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
