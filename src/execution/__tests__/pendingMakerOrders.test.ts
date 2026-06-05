import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { listPendingOrders, sumRestAboveCapNotional } = await import('../pendingMakerOrders.js');

/** Minimal fake redis exposing SCAN + MGET over a fixed key→value map. */
function makeRedis(store: Record<string, string>) {
  const keys = Object.keys(store);
  return {
    scan: vi.fn(async (_cursor: string) => ['0', keys] as [string, string[]]),
    mget: vi.fn(async (...requested: string[]) => requested.map((k) => store[k] ?? null)),
  } as unknown as Redis;
}

function blob(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    orderId: 'o1',
    tokenId: 'tok',
    price: 0.5,
    size: 10,
    postedAt: 1,
    expiresAt: 2,
    consensusP: 0.7,
    direction: 'YES',
    source: 'weather',
    ...overrides,
  });
}

describe('listPendingOrders', () => {
  it('parses marketId and direction from maker:open keys', async () => {
    const redis = makeRedis({
      'maker:open:123:YES': blob(),
      'maker:open:456:NO': blob({ direction: 'NO' }),
    });
    const entries = await listPendingOrders(redis);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marketId: '123', direction: 'YES' }),
        expect.objectContaining({ marketId: '456', direction: 'NO' }),
      ]),
    );
  });

  it('skips corrupt blobs and malformed keys without throwing', async () => {
    const redis = makeRedis({
      'maker:open:123:YES': 'not-json{',
      'maker:open:456:SIDEWAYS': blob(), // invalid direction suffix
      'maker:open:789:NO': blob({ direction: 'NO' }),
    });
    const entries = await listPendingOrders(redis);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.marketId).toBe('789');
  });

  it('returns [] when redis scan fails (non-fatal)', async () => {
    const redis = {
      scan: vi.fn().mockRejectedValue(new Error('conn refused')),
      mget: vi.fn(),
    } as unknown as Redis;
    await expect(listPendingOrders(redis)).resolves.toEqual([]);
  });
});

describe('sumRestAboveCapNotional', () => {
  it('sums price*size for restAboveCap blobs only', async () => {
    const redis = makeRedis({
      'maker:open:1:YES': blob({ price: 0.5, size: 10, restAboveCap: true }), // 5.0
      'maker:open:2:NO': blob({ price: 0.4, size: 20, restAboveCap: true, direction: 'NO' }), // 8.0
      'maker:open:3:YES': blob({ price: 0.6, size: 100 }), // in-range — excluded
      'maker:open:4:NO': blob({ price: 0.3, size: 50, isBracketOpposite: true, direction: 'NO' }), // excluded
    });
    await expect(sumRestAboveCapNotional(redis)).resolves.toBeCloseTo(13.0, 6);
  });

  it('ignores blobs with non-finite or non-positive notional', async () => {
    const redis = makeRedis({
      'maker:open:1:YES': blob({ price: Number.NaN, size: 10, restAboveCap: true }),
      'maker:open:2:YES': blob({ price: 0.5, size: 0, restAboveCap: true }),
    });
    await expect(sumRestAboveCapNotional(redis)).resolves.toBe(0);
  });
});
