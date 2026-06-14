/**
 * Tests for weather resolution-time parsing — specifically the omitted-year
 * inference in weatherTargetDateFromQuestion / weatherEndDateFromQuestion.
 *
 * Regression focus: a "December 31" market that redeems on January 1 UTC must
 * resolve to Dec 31 of the PREVIOUS year, not the January year. Reusing the
 * anchor's year shifts the target into the wrong year, which makes the daily
 * digest's weather-day match fail and silently hides the win/loss.
 *
 * Uses real cities from noaaClient's static table (lookupCity is a pure lookup,
 * no network) so the actual parser runs.
 */

import { describe, it, expect } from 'vitest';
import {
  weatherTargetDateFromQuestion,
  weatherEndDateFromQuestion,
} from '../resolutionTime.js';

describe('weatherTargetDateFromQuestion', () => {
  it('resolves a Dec 31 market redeeming on Jan 1 UTC to the PREVIOUS year', () => {
    // New York (UTC-5): "December 31" market settles ~2026-01-01T05:00Z.
    const q = 'Will the highest temperature in New York be 5°C on December 31?';
    expect(weatherTargetDateFromQuestion(q, '2026-01-01T05:00:00Z')).toBe('2025-12-31');
  });

  it('resolves a mid-year market to the anchor year', () => {
    const q = 'Will the highest temperature in New York be 30°C on June 13?';
    expect(weatherTargetDateFromQuestion(q, '2026-06-14T05:00:00Z')).toBe('2026-06-13');
  });

  it('resolves a Jan 1 market redeeming on Jan 1 UTC to the same year', () => {
    const q = 'Will the highest temperature in New York be 2°C on January 1?';
    expect(weatherTargetDateFromQuestion(q, '2026-01-01T05:00:00Z')).toBe('2026-01-01');
  });

  it('honours an explicit year in the question over the anchor', () => {
    const q = 'Will the highest temperature in New York be 5°C on December 31, 2025?';
    expect(weatherTargetDateFromQuestion(q, '2027-01-01T00:00:00Z')).toBe('2025-12-31');
  });

  it('returns null for an unrecognised city', () => {
    const q = 'Will the highest temperature in Atlantis be 5°C on June 13?';
    expect(weatherTargetDateFromQuestion(q, '2026-06-14T00:00:00Z')).toBeNull();
  });
});

describe('weatherEndDateFromQuestion (year boundary)', () => {
  it('derives the local resolution end for a Dec 31 market redeeming on Jan 1 UTC', () => {
    // The end instant must fall in the previous-year Dec-31 window, not Dec 2026.
    const q = 'Will the highest temperature in New York be 5°C on December 31?';
    const iso = weatherEndDateFromQuestion(q, '2026-01-01T05:00:00Z');
    expect(iso).not.toBeNull();
    // NY local midnight after Dec 31 2025 = 2026-01-01T05:00:00Z.
    expect(iso!.slice(0, 7)).toBe('2026-01');
    expect(new Date(iso!).getUTCFullYear()).toBe(2026);
    // Sanity: it is NOT a year-2027 instant (the bug would have produced Dec 2026 → Jan 2027).
    expect(new Date(iso!).getUTCFullYear()).toBeLessThan(2027);
  });
});
