import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({ POLYMARKET_FUNDER_ADDRESS: '0xWALLET' })),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { fetchPolymarketPositions } = await import('../polymarketData.js');

function pos(asset: string) {
  return { asset, avgPrice: 0.5, size: 1, conditionId: `c-${asset}`, currentValue: 0.5 };
}
function okResp(rows: unknown[]) {
  return { ok: true, status: 200, text: async () => '', json: async () => rows };
}
function errResp(status = 500) {
  return { ok: false, status, text: async () => 'error-body', json: async () => [] };
}

describe('fetchPolymarketPositions pagination', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns a single short page and requests limit+offset (no second call)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => pos(`a${i}`));
    const fetchMock = vi.fn().mockResolvedValue(okResp(rows));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPolymarketPositions();

    expect(result).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstUrl = String(fetchMock.mock.calls[0]![0]);
    expect(firstUrl).toContain('limit=500');
    expect(firstUrl).toContain('offset=0');
  });

  it('paginates across full pages until a short page ends it, advancing offset', async () => {
    const full = Array.from({ length: 500 }, (_, i) => pos(`p1-${i}`));
    const tail = Array.from({ length: 7 }, (_, i) => pos(`p2-${i}`));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResp(full))
      .mockResolvedValueOnce(okResp(tail));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPolymarketPositions();

    expect(result).toHaveLength(507);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]![0])).toContain('offset=500');
  });

  it('returns the partial snapshot (no throw) when a LATER page errors', async () => {
    // A truncated list is safe: the reconciler confirms every ghost via an
    // on-chain balance read before deleting, so a short list can't false-close.
    const full = Array.from({ length: 500 }, (_, i) => pos(`q-${i}`));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResp(full))
      .mockResolvedValueOnce(errResp(502));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPolymarketPositions();

    expect(result).toHaveLength(500);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns [] when the FIRST page errors (so the reconciler empty-abort guard fires)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResp(500));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPolymarketPositions();

    expect(result).toEqual([]);
  });

  it('returns [] when fetch throws on the first page', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPolymarketPositions();

    expect(result).toEqual([]);
  });
});
