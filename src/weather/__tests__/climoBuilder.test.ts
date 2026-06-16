import { describe, expect, it } from 'vitest';
import {
  buildMonthHourMapFromWuObservations,
  localDateHourFromUtc,
} from '../../../scripts/build-climo-exceedance.js';

describe('build-climo-exceedance WU helpers', () => {
  it('derives local date/hour from WU UTC timestamps', () => {
    expect(localDateHourFromUtc('2026-06-01T05:30:00.000Z', 'America/Chicago')).toEqual({
      date: '2026-06-01',
      month: 6,
      hour: 0,
    });
  });

  it('buckets WU running-rise deltas by actual local hour, not observation array index', () => {
    const observations = Array.from({ length: 24 }, (_, localHour) => ({
      observedAt: new Date(Date.UTC(2026, 5, 1, localHour + 5)).toISOString(),
      temp: localHour,
    }));

    const table = buildMonthHourMapFromWuObservations(
      { '2026-06-01': [...observations].reverse() },
      'America/Chicago',
      'high',
    );

    expect(table[6]?.[0]).toEqual([23]);
    expect(table[6]?.[12]).toEqual([11]);
    expect(table[6]?.[23]).toEqual([0]);
  });
});
