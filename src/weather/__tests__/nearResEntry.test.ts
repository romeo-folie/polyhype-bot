import { describe, it, expect } from 'vitest';
import { evaluateWeatherNearResEntry } from '../nearResEntry.js';

function msFromNow(hours: number): number {
  return Date.now() + hours * 60 * 60 * 1000;
}

function endDate(hours: number): string {
  return new Date(msFromNow(hours)).toISOString();
}

describe('evaluateWeatherNearResEntry', () => {
  it('skips when within the time window', () => {
    const result = evaluateWeatherNearResEntry(endDate(8), 10);
    expect(result.shouldSkip).toBe(true);
    expect(result.hoursLeft).toBeGreaterThan(7.9);
    expect(result.hoursLeft).toBeLessThan(8.1);
  });

  it('does not skip when outside the time window', () => {
    const result = evaluateWeatherNearResEntry(endDate(12), 10);
    expect(result.shouldSkip).toBe(false);
  });

  it('skips exactly at the threshold boundary', () => {
    const nowMs = new Date('2026-04-25T06:00:00Z').getTime();
    const exactlyAtThreshold = new Date(nowMs + 10 * 60 * 60 * 1000).toISOString();
    const result = evaluateWeatherNearResEntry(exactlyAtThreshold, 10, nowMs);
    expect(result.shouldSkip).toBe(true);
    expect(result.hoursLeft).toBeCloseTo(10, 5);
  });

  it('does not skip when endDate is missing', () => {
    const result = evaluateWeatherNearResEntry(undefined, 10);
    expect(result.shouldSkip).toBe(false);
    expect(result.hoursLeft).toBe(Infinity);
  });

  it('does not skip when endDate is null', () => {
    const result = evaluateWeatherNearResEntry(null, 10);
    expect(result.shouldSkip).toBe(false);
    expect(result.hoursLeft).toBe(Infinity);
  });

  it('does not skip on a malformed endDate', () => {
    const result = evaluateWeatherNearResEntry('not-a-date', 10);
    expect(result.shouldSkip).toBe(false);
    expect(result.hoursLeft).toBe(Infinity);
  });

  it('does not skip after resolution (hoursLeft <= 0)', () => {
    const result = evaluateWeatherNearResEntry(endDate(-1), 10);
    expect(result.shouldSkip).toBe(false);
  });

  it('respects custom nowMs for deterministic testing', () => {
    const nowMs = new Date('2026-04-25T06:31:00Z').getTime();
    const endMs = new Date('2026-04-25T16:00:00Z').getTime(); // 9.48h from now
    const result = evaluateWeatherNearResEntry(new Date(endMs).toISOString(), 10, nowMs);
    expect(result.shouldSkip).toBe(true);
    expect(result.hoursLeft).toBeCloseTo(9.483, 2);
  });

  it('does not skip when the same nowMs scenario is outside the threshold', () => {
    const nowMs = new Date('2026-04-25T06:31:00Z').getTime();
    const endMs = new Date('2026-04-25T16:00:00Z').getTime(); // 9.48h from now
    const result = evaluateWeatherNearResEntry(new Date(endMs).toISOString(), 8, nowMs);
    expect(result.shouldSkip).toBe(false);
  });

  it('respects custom threshold hours', () => {
    const within = evaluateWeatherNearResEntry(endDate(7), 8);
    const outside = evaluateWeatherNearResEntry(endDate(9), 8);
    expect(within.shouldSkip).toBe(true);
    expect(outside.shouldSkip).toBe(false);
  });
});
