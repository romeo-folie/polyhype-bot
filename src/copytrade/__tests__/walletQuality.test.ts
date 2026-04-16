import { describe, it, expect } from 'vitest';
import {
  computeWalletStats,
  scoreWallet,
  type ActivityRedeem,
  type ActivityTrade,
  type QualityConfig,
} from '../walletQuality.js';

function makeTrade(overrides: Partial<ActivityTrade>): ActivityTrade {
  return {
    proxyWallet: '0xwallet',
    timestamp: 1_700_000_000,
    conditionId: '0xcond',
    type: 'TRADE',
    size: 100,
    usdcSize: 50,
    transactionHash: '0xtx',
    price: 0.5,
    asset: 'asset-1',
    side: 'BUY',
    outcomeIndex: 0,
    title: 'Will Trump win the election?',
    slug: 'will-trump-win',
    eventSlug: 'trump-event',
    outcome: 'YES',
    ...overrides,
  };
}

function makeRedeem(overrides: Partial<ActivityRedeem>): ActivityRedeem {
  return {
    proxyWallet: '0xwallet',
    timestamp: 1_700_000_100,
    conditionId: '0xcond',
    type: 'REDEEM',
    size: 100,
    usdcSize: 100,
    transactionHash: '0xredeem-tx',
    title: 'Will Trump win the election?',
    slug: 'will-trump-win',
    eventSlug: 'trump-event',
    ...overrides,
  };
}

const defaultConfig: QualityConfig = {
  maxTrades: 100,
  minAvgSizeUsd: 10_000,
  maxAvgSizeUsd: 50_000,
  minCategoryHhi: 0.5,
  winRateMinResolved: 10,
  winRateBonusMult: 1.2,
  winRatePenaltyMult: 0.8,
  weights: {
    tradeCount: 0.3,
    avgSize: 0.2,
    categoryFocus: 0.3,
    sharpe: 0.2,
  },
};

describe('walletQuality.computeWalletStats', () => {
  it('computes tradeCount, avgSize, and categoryHhi on a single-category wallet', () => {
    const trades = Array.from({ length: 20 }, (_i) =>
      makeTrade({ usdcSize: 15_000, title: 'Will Trump win the election?' }),
    );
    const stats = computeWalletStats('0xw', trades);
    expect(stats.tradeCount).toBe(20);
    expect(stats.avgTradeSizeUsd).toBeCloseTo(15_000);
    // All trades are us-politics → HHI = 1.0
    expect(stats.categoryHhi).toBeCloseTo(1);
  });

  it('computes HHI < 1 for multi-category wallet', () => {
    const trades = [
      ...Array.from({ length: 5 }, () =>
        makeTrade({ title: 'Will Trump win the election?', asset: 'a' }),
      ),
      ...Array.from({ length: 5 }, () =>
        makeTrade({ title: 'Will Bitcoin hit $100k?', asset: 'b' }),
      ),
    ];
    const stats = computeWalletStats('0xw', trades);
    // 50/50 split across two categories → HHI = 0.5
    expect(stats.categoryHhi).toBeCloseTo(0.5);
  });

  it('matches round-trip BUY+SELL pairs and classifies wins/losses', () => {
    const trades: ActivityTrade[] = [
      makeTrade({
        asset: 'a',
        side: 'BUY',
        size: 100,
        usdcSize: 50, // avg cost 0.50
        timestamp: 1,
      }),
      makeTrade({
        asset: 'a',
        side: 'SELL',
        size: 100,
        usdcSize: 80, // proceeds 0.80 → win
        timestamp: 2,
      }),
      makeTrade({
        asset: 'b',
        side: 'BUY',
        size: 100,
        usdcSize: 60,
        timestamp: 3,
      }),
      makeTrade({
        asset: 'b',
        side: 'SELL',
        size: 100,
        usdcSize: 40, // loss
        timestamp: 4,
      }),
    ];
    const stats = computeWalletStats('0xw', trades);
    expect(stats.overallResolvedTrades).toBe(2);
    expect(stats.overallWinRate).toBe(0.5);
  });

  it('does not credit unclosed positions as wins or losses', () => {
    const trades: ActivityTrade[] = [
      makeTrade({ asset: 'a', side: 'BUY', size: 100, usdcSize: 50, timestamp: 1 }),
      // no corresponding SELL
    ];
    const stats = computeWalletStats('0xw', trades);
    expect(stats.overallResolvedTrades).toBe(0);
    expect(stats.overallWinRate).toBeNull();
  });

  it('returns null sharpe when fewer than 5 round-trips', () => {
    const trades: ActivityTrade[] = [
      makeTrade({ asset: 'a', side: 'BUY', size: 100, usdcSize: 50, timestamp: 1 }),
      makeTrade({ asset: 'a', side: 'SELL', size: 100, usdcSize: 80, timestamp: 2 }),
    ];
    const stats = computeWalletStats('0xw', trades);
    expect(stats.sharpe).toBeNull();
  });

  it('REDEEM closes hold-to-resolution BUYs as wins', () => {
    // Whale buys YES at $0.50, market resolves YES, redeems at $1.00/share.
    const trades: ActivityTrade[] = [
      makeTrade({ asset: 'yes-a', conditionId: '0xA', side: 'BUY', size: 100, usdcSize: 50, timestamp: 1 }),
    ];
    const redeems: ActivityRedeem[] = [
      makeRedeem({ conditionId: '0xA', size: 100, usdcSize: 100, timestamp: 2 }),
    ];
    const stats = computeWalletStats('0xw', trades, redeems);
    expect(stats.overallResolvedTrades).toBe(1);
    expect(stats.overallWinRate).toBe(1);
  });

  it('multi-outcome REDEEM: winning asset at $1, losing assets at $0', () => {
    // Whale buys two candidates in a multi-outcome race; one wins.
    const trades: ActivityTrade[] = [
      makeTrade({ asset: 'horse-a', conditionId: '0xR', side: 'BUY', size: 100, usdcSize: 30, timestamp: 1 }),
      makeTrade({ asset: 'horse-b', conditionId: '0xR', side: 'BUY', size: 200, usdcSize: 40, timestamp: 2 }),
    ];
    // horse-b is the winner (size 200 matches REDEEM size)
    const redeems: ActivityRedeem[] = [
      makeRedeem({ conditionId: '0xR', size: 200, usdcSize: 200, timestamp: 3 }),
    ];
    const stats = computeWalletStats('0xw', trades, redeems);
    // 1 win (horse-b: +$160) + 1 loss (horse-a: -$30) = 50% WR
    expect(stats.overallResolvedTrades).toBe(2);
    expect(stats.overallWinRate).toBe(0.5);
  });

  it('REDEEM after a partial SELL closes only the remaining inventory', () => {
    // Whale buys 100 @ $0.50, sells 40 @ $0.90 (partial win), holds 60 to redemption.
    const trades: ActivityTrade[] = [
      makeTrade({ asset: 'yes-a', conditionId: '0xA', side: 'BUY', size: 100, usdcSize: 50, timestamp: 1 }),
      makeTrade({ asset: 'yes-a', conditionId: '0xA', side: 'SELL', size: 40, usdcSize: 36, timestamp: 2 }),
    ];
    const redeems: ActivityRedeem[] = [
      makeRedeem({ conditionId: '0xA', size: 60, usdcSize: 60, timestamp: 3 }),
    ];
    const stats = computeWalletStats('0xw', trades, redeems);
    // Two round-trips, both wins
    expect(stats.overallResolvedTrades).toBe(2);
    expect(stats.overallWinRate).toBe(1);
  });

  it('REDEEM with no matching inventory is a silent no-op (truncated history)', () => {
    // BUY for conditionId 0xA was outside the fetch window; only a REDEEM shows up.
    const redeems: ActivityRedeem[] = [
      makeRedeem({ conditionId: '0xA', size: 100, usdcSize: 100, timestamp: 2 }),
    ];
    const stats = computeWalletStats('0xw', [], redeems);
    expect(stats.overallResolvedTrades).toBe(0);
    expect(stats.overallWinRate).toBeNull();
  });

  it('does not double-count a conditionId redeemed across multiple REDEEM events', () => {
    // Whale buys 100 YES and 100 NO, market resolves YES.
    // The winning side is redeemed in two chunks (60 + 40).
    const trades: ActivityTrade[] = [
      makeTrade({ asset: 'yes-a', conditionId: '0xA', side: 'BUY', size: 100, usdcSize: 50, timestamp: 1 }),
      makeTrade({ asset: 'no-a', conditionId: '0xA', side: 'BUY', size: 100, usdcSize: 50, timestamp: 2 }),
    ];
    const redeems: ActivityRedeem[] = [
      makeRedeem({ conditionId: '0xA', size: 60, usdcSize: 60, timestamp: 3, transactionHash: '0xr1' }),
      makeRedeem({ conditionId: '0xA', size: 40, usdcSize: 40, timestamp: 4, transactionHash: '0xr2' }),
    ];
    const stats = computeWalletStats('0xw', trades, redeems);
    // First REDEEM: closes 60 of winner at $1 (pnl = +30) AND zeros NO side (pnl = -50).
    // Second REDEEM: closes remaining 40 of winner at $1 (pnl = +20).
    // Total: 3 round-trips, 2 wins + 1 loss.
    expect(stats.overallResolvedTrades).toBe(3);
    expect(stats.overallWinRate).toBeCloseTo(2 / 3);
  });
});

describe('walletQuality.scoreWallet', () => {
  it('sweet-spot whale (few trades, good avg size, single category) scores high', () => {
    const stats = computeWalletStats(
      '0xw',
      Array.from({ length: 40 }, () =>
        makeTrade({ usdcSize: 20_000, title: 'Will Trump win?' }),
      ),
    );
    const { score } = scoreWallet(stats, defaultConfig);
    expect(score).toBeGreaterThan(0.5);
  });

  it('bot-shaped whale (lots of trades, tiny avg size, diverse categories) scores below filter cutoff', () => {
    // Diverse categories + tiny size + huge trade count is the bot fingerprint.
    const titles = [
      'Will Trump win?',
      'Will Bitcoin hit $100k?',
      'Will the Lakers win the championship?',
      'Will Fed cut rates?',
      'Will Biden sign this bill?',
    ];
    const trades = Array.from({ length: 2000 }, (_v, i) =>
      makeTrade({ usdcSize: 5, title: titles[i % titles.length]!, asset: `asset-${i}` }),
    );
    const stats = computeWalletStats('0xw', trades);
    const { score, factors } = scoreWallet(stats, defaultConfig);
    expect(factors.tradeCount).toBe(0); // 2000 > 5× maxTrades → 0
    expect(factors.avgSize).toBeLessThan(0.1);
    // Below the default COPYTRADE_WALLET_MIN_SCORE cutoff of 0.5.
    expect(score).toBeLessThan(0.5);
  });

  it('win-rate bonus applies when resolved >= threshold and WR >= 0.60', () => {
    const winTrade = (ts: number, asset: string) => [
      makeTrade({ asset, side: 'BUY' as const, size: 100, usdcSize: 50, timestamp: ts }),
      makeTrade({ asset, side: 'SELL' as const, size: 100, usdcSize: 80, timestamp: ts + 1 }),
    ];
    const loseTrade = (ts: number, asset: string) => [
      makeTrade({ asset, side: 'BUY' as const, size: 100, usdcSize: 50, timestamp: ts }),
      makeTrade({ asset, side: 'SELL' as const, size: 100, usdcSize: 30, timestamp: ts + 1 }),
    ];
    // 8 wins, 2 losses = 80% WR on 10 resolved
    const trades: ActivityTrade[] = [];
    for (let i = 0; i < 8; i++) trades.push(...winTrade(i * 10, `asset-${i}`));
    for (let i = 8; i < 10; i++) trades.push(...loseTrade(i * 10, `asset-${i}`));
    const stats = computeWalletStats('0xw', trades);
    const { factors } = scoreWallet(stats, defaultConfig);
    expect(factors.winRateMultiplier).toBeCloseTo(1.2);
  });

  it('win-rate unknown → neutral 1.0 multiplier', () => {
    const trades = Array.from({ length: 5 }, () => makeTrade({ usdcSize: 20_000 }));
    const stats = computeWalletStats('0xw', trades);
    const { factors } = scoreWallet(stats, defaultConfig);
    expect(factors.winRateMultiplier).toBe(1);
  });

  it('score is clamped to [0, 1]', () => {
    const stats = computeWalletStats('0xw', []);
    const { score } = scoreWallet(stats, defaultConfig);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('weights sum to 1 even with arbitrary non-normalized input', () => {
    const trades = Array.from({ length: 40 }, () =>
      makeTrade({ usdcSize: 20_000, title: 'Will Trump win?' }),
    );
    const stats = computeWalletStats('0xw', trades);
    const exotic: QualityConfig = {
      ...defaultConfig,
      weights: { tradeCount: 3, avgSize: 2, categoryFocus: 3, sharpe: 2 },
    };
    const { score } = scoreWallet(stats, exotic);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
