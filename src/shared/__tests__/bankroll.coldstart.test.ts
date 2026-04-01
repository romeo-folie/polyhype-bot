/**
 * Cold-start bankroll tests — separate file so lastKnownBalance starts as null.
 *
 * Vitest loads each test file in a fresh module registry, so module-level state
 * (lastKnownBalance) is guaranteed to be null at the start of this file.
 */
import { describe, it, expect, vi } from 'vitest';

const mockGetPortfolio = vi.fn<() => Promise<never>>();

vi.mock('../simmer.js', () => ({
  getPortfolio: mockGetPortfolio,
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    POLYGON_WALLET_PRIVATE_KEY: undefined, // no on-chain check in cold-start tests
    POLYGON_RPC_URL: undefined,
  })),
  USDC_E_ADDRESS: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
}));

// Fresh import — lastKnownBalance is null in this file's module instance.
const { getBankroll } = await import('../bankroll.js');

describe('bankroll — cold-start error propagation', () => {
  it('throws when Simmer fails and no prior balance has been cached', async () => {
    mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));
    await expect(getBankroll()).rejects.toThrow('Simmer API returned HTTP 503');
  });
});
