/**
 * Unit tests for getOrderFillVwap — actual-fill-price attribution from CLOB
 * trade records.
 *
 * GTC limit orders can fill BELOW their posted price when they cross the book
 * at post time (BUY NO @ P is matched as SELL YES @ 1-P against resting YES
 * orders). These tests pin the attribution rules:
 *   - taker fills price at each counterparty maker order's price, flipped to
 *     (1 - p) for complementary-asset (mint) matches;
 *   - maker fills price at our own resting order's posted price;
 *   - unattributable / partial-coverage / corrupt data → null (callers fall
 *     back to the posted price).
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { z } from 'zod';

const mockGetTrades = vi.fn();

vi.mock('ethers', () => ({
  Wallet: vi.fn(() => ({
    address: '0xtest',
    signTypedData: vi.fn().mockResolvedValue('0xsig'),
    signingKey: {},
  })),
  Contract: vi.fn(() => ({})),
  Interface: vi.fn(() => ({
    encodeFunctionData: vi.fn(() => '0xencodeddata'),
  })),
  JsonRpcProvider: vi.fn(() => ({})),
  Network: vi.fn(() => ({})),
  FetchRequest: vi.fn(() => ({ timeout: 0 })),
  solidityPackedKeccak256: vi.fn(() => '0x' + 'ab'.repeat(32)),
}));

vi.mock('@polymarket/clob-client-v2', () => ({
  ClobClient: vi.fn(() => ({
    getTrades: mockGetTrades,
    createOrDeriveApiKey: vi
      .fn()
      .mockResolvedValue({ key: 'test', secret: 'test', passphrase: 'test' }),
  })),
  OrderType: { FOK: 'FOK', FAK: 'FAK', GTC: 'GTC' },
  Side: { BUY: 'BUY', SELL: 'SELL' },
  AssetType: { COLLATERAL: 'COLLATERAL' },
  Chain: { POLYGON: 137 },
}));

// Foundation from the REAL Zod schema defaults so the mock can't drift from
// config.ts (see feedback: hand-written literals crash on new cfg.X reads).
const { envSchema } = await vi.importActual<{ envSchema: z.AnyZodObject }>('../config.js');
function schemaDefaults(schema: z.AnyZodObject): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const parsed = field.safeParse(undefined);
    if (parsed.success && parsed.data !== undefined) defaults[key] = parsed.data;
  }
  return defaults;
}

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    ...schemaDefaults(envSchema),
    CLOB_FALLBACK_ENABLED: true,
    POLYGON_WALLET_PRIVATE_KEY:
      '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    POLYMARKET_SIGNATURE_TYPE: 0,
    POLYMARKET_FUNDER_ADDRESS: undefined,
    POLYGON_RPC_URL: 'http://mock-rpc.test',
  })),
  CTF_ADDRESS: '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  PUSD_ADDRESS: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  POLYGON_FALLBACK_RPCS: ['http://mock-rpc.test'],
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../redis.js', () => ({
  getRedis: vi.fn(() => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  })),
}));

const { getOrderFillVwap } = await import('../clob.js');

const OUR_ORDER = 'order-ours';
const NO_TOKEN = 'tok-no';
const YES_TOKEN = 'tok-yes';
const COND = '0xcond';

/** Minimal Trade shape — only the fields getOrderFillVwap reads. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTrade(overrides: Record<string, unknown>): any {
  return {
    id: 'trade-1',
    taker_order_id: 'order-someone-else',
    market: COND,
    asset_id: NO_TOKEN,
    side: 'BUY',
    size: '0',
    price: '0',
    status: 'CONFIRMED',
    maker_orders: [],
    trader_side: 'TAKER',
    ...overrides,
  };
}

describe('getOrderFillVwap', () => {
  beforeEach(() => {
    mockGetTrades.mockReset();
  });

  it('scopes the trades query to the given condition id', async () => {
    mockGetTrades.mockResolvedValue([]);
    await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(mockGetTrades).toHaveBeenCalledWith({ market: COND });
  });

  it('prices a maker-side fill at our resting order price', async () => {
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: 'order-counterparty',
        maker_orders: [
          { order_id: OUR_ORDER, matched_amount: '60', price: '0.62', asset_id: NO_TOKEN },
          // Another maker in the same trade — must NOT be attributed to us.
          { order_id: 'order-other-maker', matched_amount: '40', price: '0.61', asset_id: NO_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(res).toEqual({ sharesFilled: 60, avgFillPrice: 0.62 });
  });

  it('prices a taker cross-asset (mint) fill at 1 - makerPrice — the observed posted-0.26/filled-0.22 case', async () => {
    // We posted BUY NO @ 0.26; the engine matched us as SELL YES against a
    // resting BUY YES @ 0.78 → our NO cost is 1 - 0.78 = 0.22.
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: OUR_ORDER,
        maker_orders: [
          { order_id: 'order-yes-bidder', matched_amount: '28.69', price: '0.78', asset_id: YES_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(res?.sharesFilled).toBeCloseTo(28.69, 6);
    expect(res?.avgFillPrice).toBeCloseTo(0.22, 6);
  });

  it('prices a taker same-asset fill at the maker price directly', async () => {
    // BUY NO crossing a resting SELL NO @ 0.21 fills at 0.21 — no flip.
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: OUR_ORDER,
        maker_orders: [
          { order_id: 'order-no-seller', matched_amount: '10', price: '0.21', asset_id: NO_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(res?.sharesFilled).toBeCloseTo(10, 6);
    expect(res?.avgFillPrice).toBeCloseTo(0.21, 6);
  });

  it('volume-weights across multiple trades and maker orders', async () => {
    // 30 @ (1-0.78)=0.22 (taker mint) + 30 @ 0.26 (maker resting)
    // → VWAP = (30*0.22 + 30*0.26) / 60 = 0.24
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: OUR_ORDER,
        maker_orders: [
          { order_id: 'order-yes-bidder', matched_amount: '30', price: '0.78', asset_id: YES_TOKEN },
        ],
      }),
      makeTrade({
        id: 'trade-2',
        taker_order_id: 'order-counterparty',
        maker_orders: [
          { order_id: OUR_ORDER, matched_amount: '30', price: '0.26', asset_id: NO_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN, 60);
    expect(res?.sharesFilled).toBeCloseTo(60, 6);
    expect(res?.avgFillPrice).toBeCloseTo(0.24, 6);
  });

  it('returns null when attributed shares fall short of the expected matched size', async () => {
    // Only 50 of an expected 100 shares attributable — a subset VWAP could skew
    // either way, so the caller must fall back to the posted price.
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: 'order-counterparty',
        maker_orders: [
          { order_id: OUR_ORDER, matched_amount: '50', price: '0.62', asset_id: NO_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN, 100);
    expect(res).toBeNull();
  });

  it('returns null when no trades reference the order', async () => {
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: 'order-counterparty',
        maker_orders: [
          { order_id: 'order-other-maker', matched_amount: '60', price: '0.62', asset_id: NO_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(res).toBeNull();
  });

  it('returns null when the trades fetch fails', async () => {
    mockGetTrades.mockRejectedValue(new Error('CLOB 500'));
    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(res).toBeNull();
  });

  it('returns null when the order id or condition id is missing', async () => {
    expect(await getOrderFillVwap('', COND, NO_TOKEN)).toBeNull();
    expect(await getOrderFillVwap(OUR_ORDER, '', NO_TOKEN)).toBeNull();
    expect(mockGetTrades).not.toHaveBeenCalled();
  });

  it('skips corrupt maker entries (zero/NaN size or price) and returns null when nothing valid remains', async () => {
    mockGetTrades.mockResolvedValue([
      makeTrade({
        taker_order_id: OUR_ORDER,
        maker_orders: [
          { order_id: 'order-a', matched_amount: '0', price: '0.50', asset_id: NO_TOKEN },
          { order_id: 'order-b', matched_amount: 'abc', price: '0.50', asset_id: NO_TOKEN },
          { order_id: 'order-c', matched_amount: '10', price: '0', asset_id: NO_TOKEN },
        ],
      }),
    ]);

    const res = await getOrderFillVwap(OUR_ORDER, COND, NO_TOKEN);
    expect(res).toBeNull();
  });
});
