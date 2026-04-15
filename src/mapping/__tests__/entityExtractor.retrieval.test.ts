/**
 * Unit tests for the retrieval layer refactor (2026-04-15):
 *   - word-boundary matching ("war" does NOT match "Warriors")
 *   - match-strength ranking (token_match_count desc, liquidity desc)
 *   - public-search retriever flow
 *
 * Tests use the `__testing` export to exercise pure helpers directly,
 * plus a mocked `publicSearch` for the end-to-end public-search path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as GammaModule from '../gamma.js';
import type { GammaMarket } from '../gamma.js';

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    MARKET_RETRIEVAL_MODE: 'public_search',
    PUBLIC_SEARCH_LIMIT_PER_ENTITY: 20,
    RELEVANCE_CANDIDATE_CAP: 30,
  })),
}));

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../db/writeQueue.js', () => ({
  enqueueWrite: vi.fn(),
}));

const mockPublicSearch = vi.fn();
vi.mock('../gamma.js', async () => {
  const actual = await vi.importActual<typeof GammaModule>('../gamma.js');
  return {
    ...actual,
    publicSearch: mockPublicSearch,
  };
});

const { __testing } = await import('../entityExtractor.js');
const {
  tokenizeQuery,
  countMatchingTokens,
  scoreMarketAgainstQueries,
  buildCandidate,
  retrieveFromCache,
  retrieveFromPublicSearch,
  rankCandidates,
} = __testing;

function makeMarket(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    id: overrides.id ?? 'm1',
    question: overrides.question ?? 'Will Iran declare war?',
    conditionId: overrides.conditionId ?? '0xabc',
    clobTokenIds: overrides.clobTokenIds ?? '["101","202"]',
    outcomePrices: overrides.outcomePrices ?? '["0.45","0.55"]',
    outcomes: overrides.outcomes ?? '["Yes","No"]',
    active: overrides.active ?? true,
    closed: overrides.closed ?? false,
    volume: overrides.volume ?? '1000',
    liquidity: overrides.liquidity ?? '5000',
    endDate: overrides.endDate ?? '2099-01-01T00:00:00Z',
    description: overrides.description ?? 'A market about Iran war.',
  };
}

describe('tokenizeQuery', () => {
  it('lowercases and splits on non-alphanum', () => {
    expect(tokenizeQuery('US-Iran War!')).toEqual(['iran', 'war']);
  });

  it('drops tokens shorter than 3 chars', () => {
    // "us" (2 chars) dropped; "iran" (4 chars) kept
    expect(tokenizeQuery('US vs Iran')).toEqual(['iran']);
  });

  it('returns empty array for all-short-tokens', () => {
    expect(tokenizeQuery('US a I')).toEqual([]);
  });
});

describe('countMatchingTokens (word-boundary)', () => {
  it('matches whole words', () => {
    expect(countMatchingTokens('Iran declares war', ['iran', 'war'])).toBe(2);
  });

  it('does NOT match substrings — "war" in "Warriors" returns 0', () => {
    // This is the exact bug that motivated the retrieval rework:
    // 'war' must not match 'Warriors' (sports market).
    expect(countMatchingTokens('Will the Warriors win?', ['war'])).toBe(0);
  });

  it('does NOT match "star" in "Starlink"', () => {
    expect(countMatchingTokens('Starlink coverage expands', ['star'])).toBe(0);
  });

  it('case-insensitive match', () => {
    expect(countMatchingTokens('IRAN declares WAR', ['iran', 'war'])).toBe(2);
  });

  it('returns 0 on empty tokens', () => {
    expect(countMatchingTokens('Any text', [])).toBe(0);
  });
});

describe('scoreMarketAgainstQueries', () => {
  it('unions query tokens and counts distinct matches', () => {
    const market = makeMarket({
      question: 'Will Iran and Israel declare war?',
      description: 'Middle East conflict.',
    });
    // Unioned tokens: {iran, war, israel} — all 3 match → score 3
    // matchedQuery: "iran war" (contributes 2 of its own tokens, the best)
    const result = scoreMarketAgainstQueries(market, ['iran war', 'israel']);
    expect(result.score).toBe(3);
    expect(result.matchedQuery).toBe('iran war');
  });

  it('returns 0 for no match and falls back to first query', () => {
    const market = makeMarket({ question: 'NBA finals MVP', description: '' });
    const result = scoreMarketAgainstQueries(market, ['iran', 'trump']);
    expect(result.score).toBe(0);
    expect(result.matchedQuery).toBe('iran');
  });

  it('scores against description as well as question', () => {
    const market = makeMarket({
      question: 'Will the event happen?',
      description: 'Details about Iran and nuclear weapons.',
    });
    expect(scoreMarketAgainstQueries(market, ['iran nuclear']).score).toBe(2);
  });
});

describe('buildCandidate gates', () => {
  it('builds a valid candidate from a healthy market', () => {
    const c = buildCandidate(makeMarket(), 'iran', 2);
    expect(c).not.toBeNull();
    expect(c?.marketId).toBe('m1');
    expect(c?.matchScore).toBe(2);
    expect(c?.matchedQuery).toBe('iran');
  });

  it('rejects sports markets via domain blocklist', () => {
    const c = buildCandidate(
      makeMarket({ question: 'Who wins the NBA championship?' }),
      'iran',
      1,
    );
    expect(c).toBeNull();
  });

  it('rejects expired markets', () => {
    const c = buildCandidate(
      makeMarket({ endDate: '2020-01-01T00:00:00Z' }),
      'iran',
      1,
    );
    expect(c).toBeNull();
  });

  it('rejects low-liquidity markets', () => {
    const c = buildCandidate(makeMarket({ liquidity: '50' }), 'iran', 1);
    expect(c).toBeNull();
  });

  it('rejects multi-outcome markets', () => {
    const c = buildCandidate(
      makeMarket({ outcomes: '["Yes","No","Maybe"]' }),
      'iran',
      1,
    );
    expect(c).toBeNull();
  });

  it('rejects markets with extreme YES price', () => {
    const c = buildCandidate(
      makeMarket({ outcomePrices: '["0.01","0.99"]' }),
      'iran',
      1,
    );
    expect(c).toBeNull();
  });
});

describe('rankCandidates — match-strength first, liquidity tiebreaker', () => {
  it('puts higher matchScore before higher liquidity', () => {
    const high_score_low_liq = buildCandidate(
      makeMarket({ id: 'a', liquidity: '100' }),
      'iran',
      3,
    )!;
    const low_score_high_liq = buildCandidate(
      makeMarket({ id: 'b', liquidity: '1000000' }),
      'iran',
      1,
    )!;
    const ranked = rankCandidates([low_score_high_liq, high_score_low_liq]);
    expect(ranked[0]?.marketId).toBe('a');
    expect(ranked[1]?.marketId).toBe('b');
  });

  it('tiebreaks by liquidity when matchScore is equal', () => {
    const lower_liq = buildCandidate(
      makeMarket({ id: 'a', liquidity: '500' }),
      'iran',
      2,
    )!;
    const higher_liq = buildCandidate(
      makeMarket({ id: 'b', liquidity: '50000' }),
      'iran',
      2,
    )!;
    const ranked = rankCandidates([lower_liq, higher_liq]);
    expect(ranked[0]?.marketId).toBe('b');
  });
});

describe('retrieveFromCache — word-boundary + match-strength integration', () => {
  it('does NOT surface a "Warriors" market for a "war" query', () => {
    const cache = [
      makeMarket({ id: 'warriors', question: 'Will the Warriors win?' }),
      makeMarket({ id: 'iran-war', question: 'Will Iran declare war?' }),
    ];
    const out = retrieveFromCache(['iran', 'war'], cache);
    // Warriors market (sports) must not appear even though substring "war" is present.
    expect(out.has('warriors')).toBe(false);
    expect(out.has('iran-war')).toBe(true);
  });

  it('skips domain-blocked markets entirely', () => {
    const cache = [
      makeMarket({ id: 'nba', question: 'Will the NBA game go to overtime?' }),
    ];
    const out = retrieveFromCache(['game'], cache);
    expect(out.size).toBe(0);
  });
});

describe('retrieveFromPublicSearch', () => {
  beforeEach(() => {
    mockPublicSearch.mockReset();
  });

  it('calls publicSearch per query and merges results', async () => {
    mockPublicSearch.mockImplementation(async ({ query }: { query: string }) => {
      if (query === 'iran') {
        return [{ id: 'e1', title: 'Iran event', slug: 'iran', active: true, closed: false, markets: [makeMarket({ id: 'iran-1', question: 'Will Iran declare war?' })] }];
      }
      if (query === 'trump') {
        return [{ id: 'e2', title: 'Trump event', slug: 'trump', active: true, closed: false, markets: [makeMarket({ id: 'trump-1', question: 'Will Trump declare war on Iran?' })] }];
      }
      return [];
    });

    const out = await retrieveFromPublicSearch(['iran', 'trump'], [], 20);
    expect(mockPublicSearch).toHaveBeenCalledTimes(2);
    expect(out.has('iran-1')).toBe(true);
    expect(out.has('trump-1')).toBe(true);
    // iran-1 matches only "iran" → score 1; trump-1 matches "iran" AND "trump" → score 2
    expect(out.get('trump-1')?.matchScore).toBe(2);
    expect(out.get('iran-1')?.matchScore).toBe(1);
  });

  it('swallows per-query errors and keeps going', async () => {
    mockPublicSearch
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([
        { id: 'e1', title: 'Iran event', slug: 'iran', active: true, closed: false, markets: [makeMarket({ id: 'iran-1' })] },
      ]);

    const out = await retrieveFromPublicSearch(['bad', 'iran'], [], 20);
    expect(out.has('iran-1')).toBe(true);
  });

  it('prefers cached market record when available', async () => {
    mockPublicSearch.mockResolvedValueOnce([
      {
        id: 'e1',
        title: 'Iran event',
        slug: 'iran',
        active: true,
        closed: false,
        markets: [makeMarket({ id: 'iran-1', liquidity: '999' })],
      },
    ]);
    const cached = [makeMarket({ id: 'iran-1', liquidity: '123456' })];
    const out = await retrieveFromPublicSearch(['iran'], cached, 20);
    // Liquidity should come from the cached record (123456), not the search payload (999).
    expect(out.get('iran-1')?.liquidity).toBe(123456);
  });

  it('assigns search-only sentinel score when word-boundary match fails', async () => {
    // Polymarket search can surface topically-related markets whose question
    // doesn't contain the literal query word (e.g. q="iran" → "Middle East
    // conflict escalates"). We still include the hit, at a 0.5 sentinel score
    // so it ranks below any word-boundary match but above nothing.
    mockPublicSearch.mockResolvedValueOnce([
      {
        id: 'e1',
        title: 'Middle East event',
        slug: 'me',
        active: true,
        closed: false,
        markets: [makeMarket({ id: 'me-1', question: 'Will the Middle East conflict escalate?', description: 'Regional tensions.' })],
      },
    ]);
    const out = await retrieveFromPublicSearch(['iran'], [], 20);
    expect(out.get('me-1')?.matchScore).toBe(0.5);
  });
});
