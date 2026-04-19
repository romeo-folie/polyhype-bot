import { describe, it, expect } from 'vitest';
import { nbaWinProb, nhlWinProb, mlbWinProb } from '../winProb.js';

describe('nbaWinProb', () => {
  it('home up 10 with 1 minute left → > 0.95', () => {
    const p = nbaWinProb({ scoreDiff: 10, secondsRemaining: 60 });
    expect(p).toBeGreaterThan(0.95);
  });

  it('tied with 1 minute left → roughly 0.5 (+/- 0.1)', () => {
    const p = nbaWinProb({ scoreDiff: 0, secondsRemaining: 60 });
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.65);
  });

  it('away up 10 with 1 minute left → < 0.05', () => {
    const p = nbaWinProb({ scoreDiff: -10, secondsRemaining: 60 });
    expect(p).toBeLessThan(0.05);
  });

  it('tied at final buzzer → exactly 0.5 (OT coin-flip)', () => {
    const p = nbaWinProb({ scoreDiff: 0, secondsRemaining: 0 });
    expect(p).toBe(0.5);
  });

  it('home up 1 at final buzzer → 1.0', () => {
    expect(nbaWinProb({ scoreDiff: 1, secondsRemaining: 0 })).toBe(1);
  });
});

describe('mlbWinProb', () => {
  it('tied at start of game → ~0.54 (home edge)', () => {
    const p = mlbWinProb({ scoreDiff: 0, inning: 1, isTop: true });
    expect(p).toBeGreaterThan(0.50);
    expect(p).toBeLessThan(0.60);
  });

  it('home up 3 entering bottom 9th → > 0.95', () => {
    const p = mlbWinProb({ scoreDiff: 3, inning: 9, isTop: false });
    expect(p).toBeGreaterThan(0.95);
  });

  it('away up 1 entering bottom 9th → < 0.40 (home can tie)', () => {
    const p = mlbWinProb({ scoreDiff: -1, inning: 9, isTop: false });
    expect(p).toBeLessThan(0.40);
  });

  it('home up 2 in top 7th → > 0.70', () => {
    const p = mlbWinProb({ scoreDiff: 2, inning: 7, isTop: true });
    expect(p).toBeGreaterThan(0.70);
  });

  it('away up 3 at start → < 0.40', () => {
    const p = mlbWinProb({ scoreDiff: -3, inning: 1, isTop: true });
    expect(p).toBeLessThan(0.40);
  });
});

describe('nhlWinProb', () => {
  it('home up 1 with empty net and 30s left → > 0.85', () => {
    const p = nhlWinProb({
      scoreDiff: 1,
      secondsRemaining: 30,
      emptyNet: true,
      period: 3,
    });
    expect(p).toBeGreaterThan(0.85);
  });

  it('tied at final buzzer → 0.5', () => {
    expect(nhlWinProb({ scoreDiff: 0, secondsRemaining: 0 })).toBe(0.5);
  });

  it('home up 2 with 5 minutes left → > 0.75', () => {
    const p = nhlWinProb({ scoreDiff: 2, secondsRemaining: 300, period: 3 });
    expect(p).toBeGreaterThan(0.75);
  });

  it('away up 2 mid-game → < 0.45', () => {
    const p = nhlWinProb({ scoreDiff: -2, secondsRemaining: 1200, period: 2 });
    expect(p).toBeLessThan(0.45);
  });
});
