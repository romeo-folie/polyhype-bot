/**
 * Cold-start bankroll tests — separate file so lastKnownBalance starts as null.
 *
 * Jest loads each test file in a fresh module registry, so module-level state
 * (lastKnownBalance) is guaranteed to be null at the start of this file.
 */
import { jest, describe, it, expect } from '@jest/globals';

const mockGetPortfolio = jest.fn<() => Promise<never>>();

jest.unstable_mockModule('../simmer.js', () => ({
  getPortfolio: mockGetPortfolio,
}));

jest.unstable_mockModule('../logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Fresh import — lastKnownBalance is null in this file's module instance.
const { getBankroll } = await import('../bankroll.js');

describe('bankroll — cold-start error propagation', () => {
  it('throws when Simmer fails and no prior balance has been cached', async () => {
    mockGetPortfolio.mockRejectedValue(new Error('Simmer API returned HTTP 503'));
    await expect(getBankroll()).rejects.toThrow('Simmer API returned HTTP 503');
  });
});
