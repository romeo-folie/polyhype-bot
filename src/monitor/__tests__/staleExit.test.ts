import { describe, it, expect } from 'vitest';
import { evaluateStale, normalizeCategory, getCategoryAgeH } from '../staleExit.js';
import type { Position } from '../../execution/positionLedger.js';
import type { AppConfig } from '../../shared/config.js';

function makeCfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    STALE_EXIT_ENABLED: true,
    STALE_PEAK_PNL_TARGET_PCT: 3.0,
    STALE_MIN_AGE_H_DEFAULT: 12,
    STALE_MIN_AGE_H_SPORTS: 6,
    STALE_MIN_AGE_H_CRYPTO_REGULATORY: 8,
    STALE_MIN_AGE_H_AI_TECH: 12,
    STALE_MIN_AGE_H_MACRO: 18,
    STALE_MIN_AGE_H_US_POLITICS: 24,
    STALE_MIN_AGE_H_GEOPOLITICAL: 24,
    STALE_UNDERWATER_EXTRA_H: 12,
    STALE_VOL_WINDOW_H: 6,
    STALE_VOL_MAX_PCT: 1.5,
    STALE_REENTRY_COOLDOWN_H: 24,
    ...overrides,
  } as unknown as AppConfig;
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: '123',
    question: 'Will Hungary elect TISZA?',
    direction: 'YES',
    entryPrice: 0.5,
    stakeUsd: 10,
    edgeMagnitude: 0.1,
    sourcedFrom: 'osint:news',
    openedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    executionVenue: 'simmer',
    ...overrides,
  };
}

const H = 3600 * 1000;

describe('normalizeCategory', () => {
  it('collapses sports sub-categories into sports', () => {
    expect(normalizeCategory('sports-nba')).toBe('sports');
    expect(normalizeCategory('sports-nfl')).toBe('sports');
    expect(normalizeCategory('sports')).toBe('sports');
  });

  it('passes canonical categories through', () => {
    expect(normalizeCategory('geopolitical')).toBe('geopolitical');
    expect(normalizeCategory('crypto-regulatory')).toBe('crypto-regulatory');
    expect(normalizeCategory('us-politics')).toBe('us-politics');
  });

  it('maps unknown categories to default', () => {
    expect(normalizeCategory('mentions')).toBe('default');
    expect(normalizeCategory('weird')).toBe('default');
  });
});

describe('getCategoryAgeH', () => {
  it('returns per-category thresholds', () => {
    const cfg = makeCfg();
    expect(getCategoryAgeH('sports', cfg)).toBe(6);
    expect(getCategoryAgeH('crypto-regulatory', cfg)).toBe(8);
    expect(getCategoryAgeH('geopolitical', cfg)).toBe(24);
    expect(getCategoryAgeH('default', cfg)).toBe(12);
  });
});

describe('evaluateStale', () => {
  const cfg = makeCfg();

  it('holds when tracker has not observed long enough (grace period)', () => {
    // Position is 48h old but tracker only just started (trackedH=1h)
    const position = makePosition({
      openedAt: new Date(Date.now() - 48 * H).toISOString(),
    });
    const result = evaluateStale({
      position,
      currentPnlPct: -5,
      peakPnlPct: -5,
      firstSeenMs: Date.now() - 1 * H,
      priceRangePct: 0.1,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
    expect(result.rule).toBeUndefined();
  });

  it('fires Rule A when peak never reached 3% and tracked long enough', () => {
    const position = makePosition({
      question: 'Will Hungary elect TISZA?',
      openedAt: new Date(Date.now() - 48 * H).toISOString(),
    });
    const result = evaluateStale({
      position,
      currentPnlPct: 1.0,
      peakPnlPct: 2.5, // never hit +3
      firstSeenMs: Date.now() - 25 * H, // tracked > 24h (geopolitical threshold)
      priceRangePct: 0.5,
      cfg,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.rule).toBe('stale_peak_miss');
  });

  it('holds Rule A when peak cleared 3% target', () => {
    const position = makePosition({
      question: 'Will Hungary elect TISZA?',
    });
    const result = evaluateStale({
      position,
      currentPnlPct: 1.0,
      peakPnlPct: 4.0, // cleared target previously
      firstSeenMs: Date.now() - 25 * H,
      priceRangePct: 0.5,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });

  it('fires Rule B when underwater + flat + tracked past extra window', () => {
    const position = makePosition({
      question: 'Will Hungary elect TISZA?',
    });
    const result = evaluateStale({
      position,
      currentPnlPct: -1.5,
      peakPnlPct: 3.5, // already cleared A
      firstSeenMs: Date.now() - 37 * H, // 24 + 12 + buffer
      priceRangePct: 1.0, // < 1.5 flat
      cfg,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.rule).toBe('stale_flat_underwater');
  });

  it('holds Rule B when volatility is high enough', () => {
    const position = makePosition({ question: 'Will Hungary elect TISZA?' });
    const result = evaluateStale({
      position,
      currentPnlPct: -1.5,
      peakPnlPct: 3.5,
      firstSeenMs: Date.now() - 37 * H,
      priceRangePct: 2.5, // > 1.5, still moving
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });

  it('holds Rule B when position is currently green', () => {
    const position = makePosition({ question: 'Will Hungary elect TISZA?' });
    const result = evaluateStale({
      position,
      currentPnlPct: 0.5,
      peakPnlPct: 3.5,
      firstSeenMs: Date.now() - 37 * H,
      priceRangePct: 0.5,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });

  it('uses sports threshold for sports questions', () => {
    const position = makePosition({ question: 'Will the Lakers win the NBA finals?' });
    // Tracked 7h — past sports (6h) threshold
    const result = evaluateStale({
      position,
      currentPnlPct: 0,
      peakPnlPct: 0,
      firstSeenMs: Date.now() - 7 * H,
      priceRangePct: 0.5,
      cfg,
    });
    expect(result.shouldExit).toBe(true);
    expect(result.rule).toBe('stale_peak_miss');
    expect(result.categoryAgeH).toBe(6);
  });

  it('holds when trackedH is between grace and underwater extra for Rule B', () => {
    // Peak cleared (so Rule A won't fire), currently underwater, but not enough
    // extra time past the category window for Rule B yet.
    const position = makePosition({ question: 'Will Hungary elect TISZA?' });
    const result = evaluateStale({
      position,
      currentPnlPct: -1.0,
      peakPnlPct: 3.5,
      firstSeenMs: Date.now() - 30 * H, // 24 + 6, less than 24 + 12
      priceRangePct: 0.5,
      cfg,
    });
    expect(result.shouldExit).toBe(false);
  });
});
