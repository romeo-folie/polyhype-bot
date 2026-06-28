import { describe, it, expect } from 'vitest';
import { envSchema } from '../config.js';

// Isolate a single field's schema via .pick() so we test the bound without
// supplying every other (defaulted/required) env var.
const shrinkSchema = envSchema.pick({ WEATHER_KELLY_SHRINK_WEIGHT: true });
const weatherGateSchema = envSchema.pick({
  WEATHER_REQUIRE_CALIBRATION_COHORT_FOR_ENTRY: true,
  WEATHER_BLOCK_EXACT_OPEN_METEO_NO_WITHOUT_LIVE_CONFIRMATION: true,
  WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED: true,
});

describe('WEATHER_KELLY_SHRINK_WEIGHT bound', () => {
  it('defaults to 0.5 when unset', () => {
    const parsed = shrinkSchema.parse({});
    expect(parsed.WEATHER_KELLY_SHRINK_WEIGHT).toBe(0.5);
  });

  it('rejects 0 — would zero the Kelly edge and skip every entry (use WEATHER_SCANNER_ENABLED to disable)', () => {
    expect(shrinkSchema.safeParse({ WEATHER_KELLY_SHRINK_WEIGHT: '0' }).success).toBe(false);
  });

  it('accepts values in (0,1]', () => {
    expect(shrinkSchema.safeParse({ WEATHER_KELLY_SHRINK_WEIGHT: '0.01' }).success).toBe(true);
    expect(shrinkSchema.safeParse({ WEATHER_KELLY_SHRINK_WEIGHT: '0.5' }).success).toBe(true);
    expect(shrinkSchema.safeParse({ WEATHER_KELLY_SHRINK_WEIGHT: '1' }).success).toBe(true);
  });

  it('rejects values above 1', () => {
    expect(shrinkSchema.safeParse({ WEATHER_KELLY_SHRINK_WEIGHT: '1.5' }).success).toBe(false);
  });
});

describe('weather entry hardening gates', () => {
  it('defaults new live-affecting gates off for shadow-first rollout', () => {
    const parsed = weatherGateSchema.parse({});
    expect(parsed.WEATHER_REQUIRE_CALIBRATION_COHORT_FOR_ENTRY).toBe(false);
    expect(parsed.WEATHER_BLOCK_EXACT_OPEN_METEO_NO_WITHOUT_LIVE_CONFIRMATION).toBe(false);
    expect(parsed.WEATHER_RES_DAY_LIVE_CONFIRMATION_REQUIRED).toBe(false);
  });
});
