import { describe, it, expect } from '@jest/globals';
import { getTimingMultiplier, applyTimingBoost } from '../timingWindow.js';
import type { ScoredItem } from '../scorer.js';

function makeItem(score: number): ScoredItem {
  return {
    title: 'Test headline',
    url: 'https://example.com',
    source: 'test',
    publishedAt: new Date(),
    urgencyScore: score,
    keywords: ['war'],
    categoryId: 'geopolitical',
    categoryLabel: 'Geopolitical',
    entityContext: 'country, leader',
  };
}

describe('getTimingMultiplier', () => {
  it('returns 1.2x during Asia/Pacific window (02:00 UTC)', () => {
    const { multiplier, windowName } = getTimingMultiplier(2);
    expect(multiplier).toBe(1.20);
    expect(windowName).toBe('asia_pacific');
  });

  it('returns 1.2x at overlap of Asia and Europe (07:00 UTC) — highest wins', () => {
    // 07:00 is in both windows (asia 00-08, europe 06-14); asia (1.2) > europe (1.15)
    const { multiplier, windowName } = getTimingMultiplier(7);
    expect(multiplier).toBe(1.20);
    expect(windowName).toBe('asia_pacific');
  });

  it('returns 1.15x during Europe/Middle East window (10:00 UTC)', () => {
    const { multiplier, windowName } = getTimingMultiplier(10);
    expect(multiplier).toBe(1.15);
    expect(windowName).toBe('europe_mideast');
  });

  it('returns 1.0x during US prime time (20:00 UTC)', () => {
    const { multiplier, windowName } = getTimingMultiplier(20);
    expect(multiplier).toBe(1.0);
    expect(windowName).toBeNull();
  });

  it('returns 1.0x at boundary (14:00 UTC — end of Europe window, exclusive)', () => {
    const { multiplier } = getTimingMultiplier(14);
    expect(multiplier).toBe(1.0);
  });
});

describe('applyTimingBoost', () => {
  it('boosts score during Asia window and caps at 10', () => {
    const items = [makeItem(9)];
    // 03:00 UTC — Asia window (1.2x) → 9 * 1.2 = 10.8 → capped at 10
    const result = applyTimingBoost(items, new Date('2026-03-25T03:00:00Z'));
    expect(result[0]!.urgencyScore).toBe(10);
  });

  it('boosts score during Europe window', () => {
    const items = [makeItem(6)];
    // 10:00 UTC — Europe window (1.15x) → 6 * 1.15 = 6.9
    const result = applyTimingBoost(items, new Date('2026-03-25T10:00:00Z'));
    expect(result[0]!.urgencyScore).toBeCloseTo(6.9);
  });

  it('does not modify scores outside timing windows', () => {
    const items = [makeItem(7)];
    // 20:00 UTC — no active window
    const result = applyTimingBoost(items, new Date('2026-03-25T20:00:00Z'));
    expect(result[0]!.urgencyScore).toBe(7);
  });

  it('handles empty input', () => {
    expect(applyTimingBoost([], new Date('2026-03-25T03:00:00Z'))).toEqual([]);
  });

  it('returns same array reference when no window active', () => {
    const items = [makeItem(5)];
    const result = applyTimingBoost(items, new Date('2026-03-25T20:00:00Z'));
    expect(result).toBe(items);
  });
});
