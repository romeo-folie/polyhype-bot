import { jest, describe, it, expect, afterEach } from '@jest/globals';
import type { Position } from '../../execution/positionLedger.js';

jest.unstable_mockModule('../../shared/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock the gamma module
jest.unstable_mockModule('../../mapping/gamma.js', () => ({
  getMarket: jest.fn(),
  parseOutcomePrices: jest.fn(),
  searchEvents: jest.fn(),
  parseYesPrice: jest.fn(),
}));

const { getMarket, parseOutcomePrices } = await import('../../mapping/gamma.js');
const { fetchCurrentPrice, fetchAllCurrentPrices } = await import('../priceFetcher.js');

const mockGetMarket = getMarket as jest.MockedFunction<typeof getMarket>;
const mockParseOutcomePrices = parseOutcomePrices as jest.MockedFunction<typeof parseOutcomePrices>;

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will X happen?',
    direction: 'YES',
    entryPrice: 0.4,
    stakeUsd: 5.0,
    consensusProbability: 0.7,
    edgeMagnitude: 0.3,
    sourcedFrom: 'headline',
    openedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMarket(yesPrice = '0.65', active = true, closed = false) {
  return {
    id: 'mkt-1',
    question: 'Will X happen?',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    outcomePrices: `["${yesPrice}","${(1 - parseFloat(yesPrice)).toFixed(2)}"]`,
    outcomes: ['Yes', 'No'],
    active,
    closed,
    volume: '5000',
    liquidity: '1500',
    endDate: null,
    description: null,
  };
}

afterEach(() => {
  mockGetMarket.mockReset();
  mockParseOutcomePrices.mockReset();
});

describe('fetchCurrentPrice', () => {
  it('returns current YES price for a YES position', async () => {
    mockGetMarket.mockResolvedValue(makeMarket('0.65'));
    mockParseOutcomePrices.mockReturnValue(['0.65', '0.35']);

    const result = await fetchCurrentPrice(makePosition({ direction: 'YES' }));

    expect(result).not.toBeNull();
    expect(result!.currentYesPrice).toBeCloseTo(0.65);
    expect(result!.currentOutcomePrice).toBeCloseTo(0.65);
    expect(result!.direction).toBe('YES');
  });

  it('returns (1 - yesPrice) as outcome price for a NO position', async () => {
    mockGetMarket.mockResolvedValue(makeMarket('0.65'));
    mockParseOutcomePrices.mockReturnValue(['0.65', '0.35']);

    const result = await fetchCurrentPrice(makePosition({ direction: 'NO' }));

    expect(result).not.toBeNull();
    expect(result!.currentYesPrice).toBeCloseTo(0.65);
    expect(result!.currentOutcomePrice).toBeCloseTo(0.35); // 1 - 0.65
  });

  it('returns null for a closed market', async () => {
    mockGetMarket.mockResolvedValue(makeMarket('0.65', false, true));

    const result = await fetchCurrentPrice(makePosition());
    expect(result).toBeNull();
  });

  it('returns null when getMarket throws', async () => {
    mockGetMarket.mockRejectedValue(new Error('Network error'));

    const result = await fetchCurrentPrice(makePosition());
    expect(result).toBeNull();
  });

  it('returns null when outcomePrices is empty', async () => {
    mockGetMarket.mockResolvedValue(makeMarket('0.65'));
    mockParseOutcomePrices.mockReturnValue([]);

    const result = await fetchCurrentPrice(makePosition());
    expect(result).toBeNull();
  });
});

describe('fetchAllCurrentPrices', () => {
  it('returns a map keyed by marketId:direction with prices for all fetchable positions', async () => {
    mockGetMarket.mockResolvedValue(makeMarket('0.65'));
    mockParseOutcomePrices.mockReturnValue(['0.65', '0.35']);

    const positions = [makePosition({ marketId: 'mkt-1', direction: 'YES' })];
    const result = await fetchAllCurrentPrices(positions);

    expect(result.size).toBe(1);
    expect(result.get('mkt-1:YES')!.currentYesPrice).toBeCloseTo(0.65);
  });

  it('does not overwrite when same market has both YES and NO positions', async () => {
    mockGetMarket.mockResolvedValue(makeMarket('0.65'));
    mockParseOutcomePrices.mockReturnValue(['0.65', '0.35']);

    const positions = [
      makePosition({ marketId: 'mkt-1', direction: 'YES' }),
      makePosition({ marketId: 'mkt-1', direction: 'NO' }),
    ];
    const result = await fetchAllCurrentPrices(positions);

    expect(result.size).toBe(2);
    // YES position: outcome price = currentYesPrice = 0.65
    expect(result.get('mkt-1:YES')!.currentOutcomePrice).toBeCloseTo(0.65);
    // NO position: outcome price = 1 - currentYesPrice = 0.35
    expect(result.get('mkt-1:NO')!.currentOutcomePrice).toBeCloseTo(0.35);
  });

  it('omits positions where fetch failed', async () => {
    mockGetMarket.mockRejectedValue(new Error('not found'));

    const positions = [makePosition()];
    const result = await fetchAllCurrentPrices(positions);

    expect(result.size).toBe(0);
  });

  it('returns empty map for empty positions', async () => {
    const result = await fetchAllCurrentPrices([]);
    expect(result.size).toBe(0);
    expect(mockGetMarket).not.toHaveBeenCalled();
  });
});
