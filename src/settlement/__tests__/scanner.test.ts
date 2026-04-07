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

const executeSignalMock = vi.fn().mockResolvedValue({ skipped: false });
vi.mock('../../execution/executor.js', () => ({
  executeSignal: (...args: unknown[]) => executeSignalMock(...args),
}));

const {
  scanSettlementArb,
  detectOpportunities,
  extractCutoffPrice,
  impliedYesProb,
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
    expect(extractCutoffPrice('Silver above 32.5 by Friday?')).toBe(32.5);
    expect(extractCutoffPrice('Crude oil above $78.40?')).toBe(78.4);
  });
  it('returns null when no number present', () => {
    expect(extractCutoffPrice('Will gold rise?')).toBeNull();
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
    expect(executeSignalMock).not.toHaveBeenCalled();
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
    expect(executeSignalMock).toHaveBeenCalledOnce();
    const signal = executeSignalMock.mock.calls[0]?.[0] as { direction: string; marketId: string; stakeUsd: number; source: string };
    expect(signal.direction).toBe('YES');
    expect(signal.marketId).toBe('42');
    expect(signal.stakeUsd).toBe(10);
    expect(signal.source).toBe('spot');
  });
});
