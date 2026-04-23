import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const cfgMock = {
  SETTLEMENT_ARB_ENABLED: false,
  SETTLEMENT_MIN_EDGE: 0.03,
  SETTLEMENT_MAX_STAKE_USD: 10,
};
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => cfgMock),
}));

const cachedMarketsMock = vi.fn();
vi.mock('../../shared/watchlist.js', () => ({
  getCachedMarkets: (...args: unknown[]) => cachedMarketsMock(...args),
}));

const executeAndRecordSignalMock = vi.fn().mockResolvedValue({ skipped: false });
vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: (...args: unknown[]) => executeAndRecordSignalMock(...args),
}));

const {
  scanSettlementArb,
  detectOpportunities,
  extractCutoffPrice,
  impliedYesProb,
  impliedYesProbClosePrint,
  matchesKeyword,
} = await import('../scanner.js');

const now = Date.now();
const inHours = (h: number) => new Date(now + h * 3600 * 1000).toISOString();

function mkMarket(opts: {
  id: string;
  q: string;
  yesPrice: number;
  endHours?: number;
}) {
  return {
    id: opts.id,
    question: opts.q,
    conditionId: `c${opts.id}`,
    clobTokenIds: [`y${opts.id}`, `n${opts.id}`],
    outcomePrices: JSON.stringify([opts.yesPrice.toString(), (1 - opts.yesPrice).toString()]),
    endDate: inHours(opts.endHours ?? 6),
    feesEnabled: false,
  };
}

const fakeRedis = {
  get: vi.fn(),
} as unknown as Redis;

beforeEach(() => {
  vi.clearAllMocks();
  cfgMock.SETTLEMENT_ARB_ENABLED = false;
  cfgMock.SETTLEMENT_MIN_EDGE = 0.03;
  cfgMock.SETTLEMENT_MAX_STAKE_USD = 10;
});

describe('extractCutoffPrice', () => {
  it('parses dollar amounts with commas', () => {
    expect(extractCutoffPrice('Will gold close above $2,650 today?')).toBe(2650);
    expect(extractCutoffPrice('Crude oil above $78.40?')).toBe(78.4);
  });
  it('returns null when no $-denominated number present', () => {
    expect(extractCutoffPrice('Will gold rise?')).toBeNull();
    expect(extractCutoffPrice('Silver above 32.5 by Friday?')).toBeNull();
  });
  it('ignores date digits and captures the $-prefixed cutoff', () => {
    expect(extractCutoffPrice('Will WTI close above $100 on 2026-04-23?')).toBe(100);
    expect(extractCutoffPrice('Will crude oil be above $85 by April 30?')).toBe(85);
    expect(extractCutoffPrice('Gold above $4,700 on 2026-04-23?')).toBe(4700);
  });
});

describe('impliedYesProb', () => {
  it('produces ~0.5 at the cutoff', () => {
    expect(impliedYesProb(2650, 2650)).toBeCloseTo(0.5, 3);
  });
  it('produces >0.5 when spot is above cutoff', () => {
    expect(impliedYesProb(2680, 2650)).toBeGreaterThan(0.9);
  });
  it('produces <0.5 when spot is below cutoff', () => {
    expect(impliedYesProb(2620, 2650)).toBeLessThan(0.1);
  });
});

describe('matchesKeyword (word-boundary)', () => {
  it('matches whole word', () => {
    expect(matchesKeyword('Will gold close above $2,650?', 'gold')).toBe(true);
    expect(matchesKeyword('Crude oil tomorrow', 'oil')).toBe(true);
  });
  it('rejects substring of larger word', () => {
    expect(matchesKeyword('Spread: Golden Knights (-1.5)', 'gold')).toBe(false);
    expect(matchesKeyword('Mariners vs Red Sox', 'spx')).toBe(false);
  });
  it('handles multi-word keywords with internal space', () => {
    expect(matchesKeyword('Will sp 500 close above 5800?', 'sp 500')).toBe(true);
    expect(matchesKeyword('S&P futures', 's&p')).toBe(true);
  });
});

describe('detectOpportunities sanity gates', () => {
  it('rejects markets where cutoff is not within an order of magnitude of spot', () => {
    const markets = [
      { id: '1', question: 'Spread: Golden Knights (-1.5)', conditionId: 'c1',
        clobTokenIds: ['y1', 'n1'], outcomePrices: JSON.stringify(['0.5', '0.5']),
        endDate: inHours(6), feesEnabled: false },
    ];
    const spot = new Map([['GC=F', { price: 4687, timestamp: now }]]);
    expect(detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now)).toHaveLength(0);
  });
  it('rejects edges > 50% as parsing-bug suspects', () => {
    const markets = [
      { id: '1', question: 'Will gold close above $4,700?', conditionId: 'c1',
        clobTokenIds: ['y1', 'n1'], outcomePrices: JSON.stringify(['0.001', '0.999']),
        endDate: inHours(6), feesEnabled: false },
    ];
    const spot = new Map([['GC=F', { price: 4687, timestamp: now }]]);
    // implied YES would be ~0 (spot < cutoff), market YES = 0.001 → edge ~0, OK
    // Now flip: spot way above cutoff → implied YES ~1, market YES = 0.001 → edge ~0.999 → blocked
    const markets2 = [
      { id: '2', question: 'Will gold close above $4,000?', conditionId: 'c2',
        clobTokenIds: ['y2', 'n2'], outcomePrices: JSON.stringify(['0.001', '0.999']),
        endDate: inHours(6), feesEnabled: false },
    ];
    expect(detectOpportunities(markets2, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now)).toHaveLength(0);
    void markets;
  });
});

describe('impliedYesProbClosePrint', () => {
  it('is ~0.5 at the cutoff regardless of horizon', () => {
    expect(impliedYesProbClosePrint(5800, 5800, 6 * 3600 * 1000)).toBeCloseTo(0.5, 3);
    expect(impliedYesProbClosePrint(5800, 5800, 30 * 60 * 1000)).toBeCloseTo(0.5, 3);
  });
  it('collapses faster as the close approaches (tighter band)', () => {
    const farProb = impliedYesProbClosePrint(5810, 5800, 6 * 3600 * 1000);  // wide band
    const nearProb = impliedYesProbClosePrint(5810, 5800, 30 * 60 * 1000);  // tight band
    expect(nearProb).toBeGreaterThan(farProb);
  });
});

describe('detectOpportunities', () => {
  it('skips expired markets', () => {
    const markets = [mkMarket({ id: '1', q: 'Will gold close above $2,650 today?', yesPrice: 0.5, endHours: -1 })];
    const spot = new Map([['GC=F', { price: 2680, timestamp: now }]]);
    const out = detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now);
    expect(out).toHaveLength(0);
  });

  it('skips markets without matching commodity keyword', () => {
    const markets = [mkMarket({ id: '1', q: 'Will Trump win Iowa?', yesPrice: 0.5 })];
    const spot = new Map([['GC=F', { price: 2680, timestamp: now }]]);
    expect(detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now)).toHaveLength(0);
  });

  it('emits no signal when edge is below threshold', () => {
    const markets = [mkMarket({ id: '1', q: 'Will gold close above $2,650 today?', yesPrice: 0.99 })];
    const spot = new Map([['GC=F', { price: 2680, timestamp: now }]]);
    const out = detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now);
    expect(out).toHaveLength(0);
  });

  it('emits a YES opportunity when spot strongly implies YES but market is cheap', () => {
    const markets = [mkMarket({ id: '1', q: 'Will gold close above $2,650 today?', yesPrice: 0.4 })];
    const spot = new Map([['GC=F', { price: 2680, timestamp: now }]]);
    const out = detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.direction).toBe('YES');
  });

  it('emits a NO opportunity when spot is below cutoff but market priced for YES', () => {
    const markets = [mkMarket({ id: '1', q: 'Will silver above $32 today?', yesPrice: 0.7 })];
    const spot = new Map([['SI=F', { price: 30, timestamp: now }]]);
    const out = detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.direction).toBe('NO');
  });

  it('matches S&P / SPX equity index keywords with close-print resolution', () => {
    const markets = [mkMarket({ id: '1', q: 'Will S&P 500 close above $5,800 today?', yesPrice: 0.4 })];
    const spot = new Map([['ES=F', { price: 5850, timestamp: now }]]);
    const out = detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.direction).toBe('YES');
    expect(out[0]?.ticker).toBe('ES=F');
  });

  it('matches Nasdaq equity index keywords', () => {
    const markets = [mkMarket({ id: '1', q: 'Will Nasdaq close above $20,000 today?', yesPrice: 0.7 })];
    const spot = new Map([['NQ=F', { price: 19500, timestamp: now }]]);
    const out = detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now);
    expect(out).toHaveLength(1);
    expect(out[0]?.direction).toBe('NO');
    expect(out[0]?.ticker).toBe('NQ=F');
  });

  it('matches crude/wti/oil keywords', () => {
    const markets = [mkMarket({ id: '1', q: 'Will WTI crude oil close above $78?', yesPrice: 0.4 })];
    const spot = new Map([['CL=F', { price: 80, timestamp: now }]]);
    expect(detectOpportunities(markets, spot, { SETTLEMENT_MIN_EDGE: 0.03 }, now)).toHaveLength(1);
  });
});

describe('scanSettlementArb', () => {
  it('runs in log-only mode when SETTLEMENT_ARB_ENABLED=false', async () => {
    cachedMarketsMock.mockResolvedValue([
      mkMarket({ id: '1', q: 'Will gold close above $2,650 today?', yesPrice: 0.4 }),
    ]);
    (fakeRedis.get as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) => {
      if (k === 'spot:last:GC=F') return JSON.stringify({ price: 2680, timestamp: now });
      return null;
    });
    const result = await scanSettlementArb(fakeRedis);
    expect(result.opportunities).toBe(1);
    expect(result.emitted).toBe(0);
    expect(result.loggedOnly).toBe(true);
    expect(executeAndRecordSignalMock).not.toHaveBeenCalled();
  });

  it('emits a signal when enabled and edge clears the gate', async () => {
    cfgMock.SETTLEMENT_ARB_ENABLED = true;
    cachedMarketsMock.mockResolvedValue([
      mkMarket({ id: '42', q: 'Will gold close above $2,650 today?', yesPrice: 0.4 }),
    ]);
    (fakeRedis.get as ReturnType<typeof vi.fn>).mockImplementation(async (k: string) => {
      if (k === 'spot:last:GC=F') return JSON.stringify({ price: 2680, timestamp: now });
      return null;
    });
    const result = await scanSettlementArb(fakeRedis);
    expect(result.opportunities).toBe(1);
    expect(result.emitted).toBe(1);
    expect(executeAndRecordSignalMock).toHaveBeenCalledOnce();
    const signal = executeAndRecordSignalMock.mock.calls[0]?.[0] as { direction: string; marketId: string; stakeUsd: number; source: string };
    expect(signal.direction).toBe('YES');
    expect(signal.marketId).toBe('42');
    expect(signal.stakeUsd).toBe(10);
    expect(signal.source).toBe('spot');
  });
});
