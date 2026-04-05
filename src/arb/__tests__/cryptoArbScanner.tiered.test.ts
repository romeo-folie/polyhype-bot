import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scanCryptoArb } from '../cryptoArbScanner.js';
import * as assets from '../../shared/assets.js';
import * as correlator from '../../spot/marketCorrelator.js';
import * as consensus from '../../spot/fastPathConsensus.js';
import { loadConfig } from '../../shared/config.js';

vi.mock('../../spot/poller.js');
vi.mock('../../shared/assets.js');
vi.mock('../../spot/marketCorrelator.js');
vi.mock('../../spot/fastPathConsensus.js');
vi.mock('../../shared/config.js');
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: () => Promise.resolve(1000),
}));

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
  zrange: vi.fn().mockResolvedValue([]),
  del: vi.fn(),
};

describe('cryptoArbScanner Tiered Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadConfig as any).mockReturnValue({
      TIERED_LOGIC_ENABLED: true,
      CRYPTO_ARB_ENABLED: true,
      CRYPTO_ARB_MIN_EDGE: 0.04,
      ARB_FEE_RATE: 0.02,
      MAX_BET_FRACTION: 0.1,
      CRYPTO_ARB_MAX_STAKE_FRACTION: 0.05,
      CRYPTO_ARB_VOLATILITY_GATE_ENABLED: false,
    });
  });

  it('detects opportunity with 5% edge', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(true);
    (correlator.findCorrelatedMarkets as any).mockResolvedValue([{
      marketId: 'm1',
      conditionId: 'c1',
      clobTokenIds: ['t1', 't2'],
      currentYesPrice: 0.5,
      correlationDirection: 'positive',
      question: 'BTC 70k?',
      feesEnabled: false,
    }]);
    (consensus.estimateFastConsensus as any).mockResolvedValue({
      probability: 0.57, // 7% raw edge
      method: 'formula',
    });

    const ops = await scanCryptoArb({
      assetId: 'bitcoin',
      currentPrice: 65000,
      referencePrice: 64000,
      changePercent: 1.5,
      windowMinutes: 0,
      detectedAt: new Date().toISOString(),
    }, mockRedis as any);

    expect(ops.length).toBe(1);
    expect(ops[0].edge).toBeCloseTo(0.05); // 0.07 - 0.02 fee
  });

  it('allows fee markets when edge exceeds threshold', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(true);
    (correlator.findCorrelatedMarkets as any).mockResolvedValue([{
      marketId: 'm1',
      conditionId: 'c1',
      clobTokenIds: ['t1', 't2'],
      currentYesPrice: 0.5,
      correlationDirection: 'positive',
      question: 'BTC 70k?',
      feesEnabled: true, // fee market
    }]);
    (consensus.estimateFastConsensus as any).mockResolvedValue({
      probability: 0.57, // 7% raw edge → 5% net after fees
      method: 'formula',
    });

    const ops = await scanCryptoArb({
      assetId: 'bitcoin',
      currentPrice: 65000,
      referencePrice: 64000,
      changePercent: 1.5,
      windowMinutes: 0,
      detectedAt: new Date().toISOString(),
    }, mockRedis as any);

    expect(ops.length).toBe(1);
    expect(ops[0].feesEnabled).toBe(true);
    expect(ops[0].edge).toBeCloseTo(0.05);
  });

  it('filters opportunity with 1% edge (below 4% min)', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(true);
    (correlator.findCorrelatedMarkets as any).mockResolvedValue([{
      marketId: 'm1',
      conditionId: 'c1',
      clobTokenIds: ['t1', 't2'],
      currentYesPrice: 0.5,
      correlationDirection: 'positive',
      question: 'BTC 70k?',
      feesEnabled: false,
    }]);
    (consensus.estimateFastConsensus as any).mockResolvedValue({
      probability: 0.53, // 3% raw edge -> 1% net
      method: 'formula',
    });

    const ops = await scanCryptoArb({
      assetId: 'bitcoin',
      currentPrice: 65000,
      referencePrice: 64000,
      changePercent: 1.5,
      windowMinutes: 0,
      detectedAt: new Date().toISOString(),
    }, mockRedis as any);

    expect(ops.length).toBe(0);
  });
});
