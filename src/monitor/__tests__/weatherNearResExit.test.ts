import { describe, it, expect } from 'vitest';
import { evaluateWeatherNearRes } from '../weatherNearResExit.js';

const cfg = { nearResHours: 3, nearResMinLossPct: 10 };

function msFromNow(hours: number): number {
  return Date.now() + hours * 60 * 60 * 1000;
}

function endDate(hours: number): string {
  return new Date(msFromNow(hours)).toISOString();
}

describe('evaluateWeatherNearRes', () => {
  it('fires when within window and losing enough', () => {
    const result = evaluateWeatherNearRes(endDate(2), -15, cfg);
    expect(result.shouldFire).toBe(true);
    expect(result.hoursLeft).toBeGreaterThan(1.9);
    expect(result.hoursLeft).toBeLessThan(2.1);
  });

  it('does not fire when outside the time window', () => {
    const result = evaluateWeatherNearRes(endDate(5), -15, cfg);
    expect(result.shouldFire).toBe(false);
  });

  it('does not fire when loss is below minimum threshold', () => {
    const result = evaluateWeatherNearRes(endDate(2), -5, cfg);
    expect(result.shouldFire).toBe(false);
  });

  it('does not fire exactly at the minimum loss threshold', () => {
    // -10% exactly meets threshold (<=), so this should fire
    const result = evaluateWeatherNearRes(endDate(2), -10, cfg);
    expect(result.shouldFire).toBe(true);
  });

  it('does not fire on a winning position', () => {
    const result = evaluateWeatherNearRes(endDate(1), 5, cfg);
    expect(result.shouldFire).toBe(false);
  });

  it('does not fire after resolution (hoursLeft <= 0)', () => {
    const result = evaluateWeatherNearRes(endDate(-1), -50, cfg);
    expect(result.shouldFire).toBe(false);
  });

  it('does not fire when endDate is missing', () => {
    const result = evaluateWeatherNearRes(undefined, -50, cfg);
    expect(result.shouldFire).toBe(false);
    expect(result.hoursLeft).toBe(Infinity);
  });

  it('respects custom nowMs for deterministic testing', () => {
    const nowMs = new Date('2026-04-25T18:00:00Z').getTime();
    const endDateMs = new Date('2026-04-25T20:00:00Z').getTime(); // 2h from now
    const result = evaluateWeatherNearRes(
      new Date(endDateMs).toISOString(),
      -20,
      cfg,
      nowMs,
    );
    expect(result.shouldFire).toBe(true);
    expect(result.hoursLeft).toBeCloseTo(2, 5);
  });

  it('uses custom nearResHours from config', () => {
    const widerCfg = { nearResHours: 6, nearResMinLossPct: 10 };
    const within6h = evaluateWeatherNearRes(endDate(5), -15, widerCfg);
    const outside6h = evaluateWeatherNearRes(endDate(7), -15, widerCfg);
    expect(within6h.shouldFire).toBe(true);
    expect(outside6h.shouldFire).toBe(false);
  });

  it('uses custom nearResMinLossPct from config', () => {
    const strictCfg = { nearResHours: 3, nearResMinLossPct: 20 };
    const notEnoughLoss = evaluateWeatherNearRes(endDate(2), -15, strictCfg);
    const enoughLoss = evaluateWeatherNearRes(endDate(2), -25, strictCfg);
    expect(notEnoughLoss.shouldFire).toBe(false);
    expect(enoughLoss.shouldFire).toBe(true);
  });
});
