import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectMoves } from '../thresholdDetector.js';
import * as poller from '../poller.js';
import * as assets from '../../shared/assets.js';
import { loadConfig } from '../../shared/config.js';

vi.mock('../poller.js');
vi.mock('../../shared/assets.js', () => ({
  isCryptoAsset: vi.fn(),
  BINANCE_SYMBOL_TO_ASSET: { btcusdt: 'bitcoin' },
}));
vi.mock('../../shared/config.js');
vi.mock('../../shared/redis.js', () => ({
  getRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    zrangebyscore: vi.fn().mockResolvedValue([]),
  }),
}));

describe('thresholdDetector Tiered Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (loadConfig as any).mockReturnValue({
      TIERED_LOGIC_ENABLED: true,
      CRYPTO_MOVE_THRESHOLD: 0.5,
      SPOT_MOVE_THRESHOLD: 3.0,
      SPOT_LOOKBACK_MINUTES: 5,
      SPOT_COOLDOWN_MINUTES: 30,
      CRYPTO_COOLDOWN_MINUTES: 5,
      SESSION_THRESHOLD_ENABLED: false,
      SESSION_MULTIPLIERS:
        '1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0',
      SPOT_TRIGGER_MODE: 'pct',
      SPOT_ZSCORE_THRESHOLD: 2.5,
      SPOT_ZSCORE_LOOKBACK_MIN: 60,
    });
  });

  it('triggers on 0.6% move for crypto assets', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(true);
    (poller.getPriceAtLookback as any).mockResolvedValue(100);

    const moves = await detectMoves([{
      assetId: 'bitcoin',
      price: 100.6,
      timestamp: Date.now(),
    }]);

    expect(moves.length).toBe(1);
    expect(moves[0].changePercent).toBeCloseTo(0.6);
  });

  it('does NOT trigger on 0.6% move for non-crypto assets', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(false);
    (poller.getPriceAtLookback as any).mockResolvedValue(100);

    const moves = await detectMoves([{
      assetId: 'crude-oil',
      price: 100.6,
      timestamp: Date.now(),
    }]);

    expect(moves.length).toBe(0);
  });

  it('triggers on 3.1% move for non-crypto assets', async () => {
    (assets.isCryptoAsset as any).mockReturnValue(false);
    (poller.getPriceAtLookback as any).mockResolvedValue(100);

    const moves = await detectMoves([{
      assetId: 'crude-oil',
      price: 103.1,
      timestamp: Date.now(),
    }]);

    expect(moves.length).toBe(1);
    expect(moves[0].changePercent).toBeCloseTo(3.1);
  });
});
