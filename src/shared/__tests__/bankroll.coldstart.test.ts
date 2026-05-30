/**
 * Cold-start bankroll tests — separate file so lastKnownBalance starts as null.
 *
 * Vitest loads each test file in a fresh module registry, so module-level state
 * (lastKnownBalance) is guaranteed to be null at the start of this file.
 */
import { describe, it, expect, vi } from 'vitest';

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
  PUSD_ADDRESS: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  POLYGON_FALLBACK_RPCS: ['https://polygon-rpc.com'],
}));

// Fresh import — lastKnownBalance is null in this file's module instance.
const { getBankroll } = await import('../bankroll.js');

describe('bankroll — cold-start with no wallet key', () => {
  it('returns 0 when no wallet key configured (no prior balance cached)', async () => {
    // With no wallet key and no prior cache, getBankroll returns 0 (on-chain returns 0)
    const result = await getBankroll();
    expect(result).toBe(0);
  });
});
