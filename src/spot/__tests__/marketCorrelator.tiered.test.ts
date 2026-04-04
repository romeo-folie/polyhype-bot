import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as mc from '../marketCorrelator.js';
import * as gamma from '../../mapping/gamma.js';
import * as assets from '../../shared/assets.js';
import { loadConfig } from '../../shared/config.js';

vi.mock('../../mapping/gamma.js');
vi.mock('../../shared/assets.js');
vi.mock('../../shared/config.js');


vi.mock('../../shared/redis.js', () => ({
  getRedis: () => ({
    get: vi.fn().mockResolvedValue('positive'),
    set: vi.fn(),
    del: vi.fn(),
  }),
}));

describe('marketCorrelator Tiered Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadConfig as any).mockReturnValue({
      TIERED_LOGIC_ENABLED: true,
      STANDARD_MIN_VOLUME: 5000,
      STANDARD_MIN_LIQUIDITY: 10000,
      CRYPTO_MIN_LIQUIDITY: 50,
      CRYPTO_MIN_VOLUME: 100,
      SHORT_DURATION_HOURS: 1,
      SHORT_DURATION_MIN_LIQUIDITY: 50,
      SHORT_DURATION_MIN_VOLUME: 100,
      OPENAI_MODEL: 'gpt-4o-mini',
    });
  });

  it('allows crypto markets with $60 liquidity', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(true);
    (gamma.searchEvents as any).mockResolvedValue([{
      title: 'bitcoin news',
      markets: [{
        id: 'm1',
        active: true,
        volume: '150',
        liquidity: '60',
        outcomePrices: '["0.5", "0.5"]',
        clobTokenIds: '["t1", "t2"]',
        question: 'Bitcoin hits 100k?',
        endDate: new Date(Date.now() + 1000000).toISOString(),
      }]
    }]);
    (gamma.parseOutcomePrices as any).mockReturnValue(['0.5', '0.5']);
    (gamma.parseClobTokenIds as any).mockReturnValue(['t1', 't2']);

    const markets = await mc.findCorrelatedMarkets({
      assetId: 'bitcoin',
      currentPrice: 60000,
      referencePrice: 59000,
      changePercent: 1.6,
      windowMinutes: 5,
      detectedAt: new Date().toISOString(),
    });

    expect(markets.length).toBe(1);
    expect(markets[0].marketId).toBe('m1');
  });

  it('filters geopolitical markets with $60 liquidity', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(false);
    (gamma.searchEvents as any).mockResolvedValue([{
      title: 'election news',
      markets: [{
        id: 'm2',
        active: true,
        volume: '150',
        liquidity: '60',
        outcomePrices: '["0.5", "0.5"]',
        clobTokenIds: '["t1", "t2"]',
        question: 'Election result?',
        endDate: new Date(Date.now() + 100000000).toISOString(),
      }]
    }]);

    const markets = await mc.findCorrelatedMarkets({
      assetId: 'election',
      currentPrice: 1,
      referencePrice: 1,
      changePercent: 0,
      windowMinutes: 5,
      detectedAt: new Date().toISOString(),
    });

    expect(markets.length).toBe(0);
  });

  it('allows short-duration geopolitical markets with $60 liquidity', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(false);
    (gamma.searchEvents as any).mockResolvedValue([{
      title: 'politics news',
      markets: [{
        id: 'm3',
        active: true,
        volume: '150',
        liquidity: '60',
        outcomePrices: '["0.5", "0.5"]',
        clobTokenIds: '["t1", "t2"]',
        question: 'Trump says 5m?',
        endDate: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 min to end
      }]
    }]);
    (gamma.parseOutcomePrices as any).mockReturnValue(['0.5', '0.5']);
    (gamma.parseClobTokenIds as any).mockReturnValue(['t1', 't2']);

    const markets = await mc.findCorrelatedMarkets({
      assetId: 'politics',
      currentPrice: 1,
      referencePrice: 1,
      changePercent: 0,
      windowMinutes: 5,
      detectedAt: new Date().toISOString(),
    });

    expect(markets.length).toBe(1);
    expect(markets[0].marketId).toBe('m3');
  });
});
