import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listUpDownMarkets,
  type GammaEventWithTags,
  type UpDownMarketsFetcher,
} from '../gamma.js';

// ─── Fixture helpers ────────────────────────────────────────────────────────
//
// The real Gamma `/events?tag=crypto` response nests markets under events
// and attaches a `tags` array on each event. We only populate fields the
// `listUpDownMarkets` filter predicate actually inspects; everything else
// is stubbed with defaults that satisfy `GammaEventWithTags`.

interface MakeEventOverrides {
  id?: string;
  title?: string;
  tagSlugs?: string[];
  markets: {
    id: string;
    slug: string;
    endDate: string | null;
    closed?: boolean;
    outcomePrices?: string | string[];
    clobTokenIds?: string | string[];
  }[];
}

function makeEvent(overrides: MakeEventOverrides): GammaEventWithTags {
  return {
    id: overrides.id ?? 'evt-updown-1',
    title: overrides.title ?? 'Bitcoin Up or Down',
    slug: 'bitcoin-up-or-down',
    active: true,
    closed: false,
    tags: (overrides.tagSlugs ?? ['up-or-down', 'crypto', 'bitcoin', '15M']).map((slug) => ({
      slug,
    })),
    markets: overrides.markets.map((m) => ({
      id: m.id,
      slug: m.slug,
      question: `Up/Down market ${m.id}`,
      conditionId: `cond-${m.id}`,
      clobTokenIds: m.clobTokenIds ?? '["11111","22222"]',
      outcomePrices: m.outcomePrices ?? '["0.505","0.495"]',
      outcomes: ['Up', 'Down'],
      active: true,
      closed: m.closed ?? false,
      volume: '1000',
      liquidity: '500',
      endDate: m.endDate,
      description: null,
    })),
  };
}

function cannedFetcher(events: GammaEventWithTags[]): UpDownMarketsFetcher {
  return (_limit: number) => Promise.resolve(events);
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('listUpDownMarkets filter predicate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" so a market ending at 2026-04-12T15:00:00Z has
    // timeToResolutionMs = 10 * 60_000 (10 minutes remaining).
    vi.setSystemTime(new Date('2026-04-12T14:50:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('includes a BTC 15m market with 10min time-to-resolution and "15M" tag', async () => {
    const events = [
      makeEvent({
        tagSlugs: ['up-or-down', 'crypto', 'bitcoin', '15M'],
        markets: [
          {
            id: '1947999',
            slug: 'btc-updown-15m-1776005100',
            endDate: '2026-04-12T15:00:00Z',
            outcomePrices: '["0.505","0.495"]',
            clobTokenIds: '["tok-up-btc","tok-down-btc"]',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toHaveLength(1);
    const market = result[0]!;
    expect(market.marketId).toBe('1947999');
    expect(market.slug).toBe('btc-updown-15m-1776005100');
    expect(market.lifetime).toBe('15m');
    expect(market.asset).toBe('bitcoin');
    expect(market.timeToResolutionMs).toBe(10 * 60_000);
    expect(market.endDate.toISOString()).toBe('2026-04-12T15:00:00.000Z');
  });

  it('excludes a BTC 5m market when asking for 15m lifetime', async () => {
    const events = [
      makeEvent({
        id: 'evt-5m',
        tagSlugs: ['up-or-down', 'crypto', 'bitcoin', '5M'],
        markets: [
          {
            id: '5m-1',
            slug: 'btc-updown-5m-1776005100',
            endDate: '2026-04-12T14:55:00Z', // 5 min from pinned now
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toEqual([]);
  });

  it('excludes a BTC 15m market whose time-to-resolution exceeds the cap', async () => {
    // 25 hours from pinned now (2026-04-13T15:50:00Z) — well past 15 min cap
    const events = [
      makeEvent({
        markets: [
          {
            id: 'far-future',
            slug: 'btc-updown-15m-9999999999',
            endDate: '2026-04-13T15:50:00Z',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toEqual([]);
  });

  it('excludes an already-resolved market (endDate in the past)', async () => {
    const events = [
      makeEvent({
        markets: [
          {
            id: 'already-resolved',
            slug: 'btc-updown-15m-1775000000',
            endDate: '2026-04-12T14:45:00Z', // 5 min before pinned now
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toEqual([]);
  });

  it('excludes wrong-asset (ETH) markets when asked for bitcoin', async () => {
    const events = [
      makeEvent({
        id: 'evt-eth',
        title: 'Ethereum Up or Down',
        tagSlugs: ['up-or-down', 'crypto', 'ethereum', '15M'],
        markets: [
          {
            id: 'eth-15m-1',
            slug: 'eth-updown-15m-1776005100',
            endDate: '2026-04-12T15:00:00Z',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toEqual([]);
  });

  it('excludes a market with a matching slug but missing "15M" tag (belt-and-braces)', async () => {
    const events = [
      makeEvent({
        id: 'evt-no-tag',
        tagSlugs: ['up-or-down', 'crypto', 'bitcoin'], // no "15M"
        markets: [
          {
            id: 'slug-only',
            slug: 'btc-updown-15m-1776005100',
            endDate: '2026-04-12T15:00:00Z',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toEqual([]);
  });

  it('handles an event with an empty markets array without throwing', async () => {
    const events: GammaEventWithTags[] = [
      {
        id: 'evt-empty',
        title: 'Empty event',
        slug: 'empty-event',
        active: true,
        closed: false,
        tags: [{ slug: '15M' }],
        markets: [],
      },
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toEqual([]);
  });

  it('parses JSON-encoded outcomePrices into a [number, number] tuple', async () => {
    const events = [
      makeEvent({
        markets: [
          {
            id: 'prices-json',
            slug: 'btc-updown-15m-1776005100',
            endDate: '2026-04-12T15:00:00Z',
            outcomePrices: '["0.505","0.495"]',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toHaveLength(1);
    const [upPrice, downPrice] = result[0]!.outcomePrices;
    expect(upPrice).toBeCloseTo(0.505);
    expect(downPrice).toBeCloseTo(0.495);
    expect(typeof upPrice).toBe('number');
    expect(typeof downPrice).toBe('number');
  });

  it('parses JSON-encoded clobTokenIds into a [string, string] tuple', async () => {
    const events = [
      makeEvent({
        markets: [
          {
            id: 'tokens-json',
            slug: 'btc-updown-15m-1776005100',
            endDate: '2026-04-12T15:00:00Z',
            clobTokenIds: '["up-token-abc","down-token-xyz"]',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.clobTokenIds).toEqual(['up-token-abc', 'down-token-xyz']);
  });

  it('sets yesTokenId to the UP (first) token and noTokenId to the DOWN (second) token', async () => {
    const events = [
      makeEvent({
        markets: [
          {
            id: 'alias-check',
            slug: 'btc-updown-15m-1776005100',
            endDate: '2026-04-12T15:00:00Z',
            clobTokenIds: '["UP_TOKEN","DOWN_TOKEN"]',
          },
        ],
      }),
    ];

    const result = await listUpDownMarkets(
      { asset: 'bitcoin', lifetime: '15m', maxTimeToResolutionMin: 15 },
      cannedFetcher(events),
    );

    expect(result).toHaveLength(1);
    const market = result[0]!;
    expect(market.yesTokenId).toBe('UP_TOKEN');
    expect(market.noTokenId).toBe('DOWN_TOKEN');
    expect(market.yesTokenId).toBe(market.clobTokenIds[0]);
    expect(market.noTokenId).toBe(market.clobTokenIds[1]);
  });
});
