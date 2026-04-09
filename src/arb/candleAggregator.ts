/**
 * Candle aggregator.
 *
 * Primary source: real OHLCV klines stored by BinanceFeed at
 *   spot:klines:<symbol>:<timeframe>   (sorted set, score=openTime, member=JSON StoredKline)
 *
 * Fallback: when no kline data is available (warmup, non-Binance symbol, etc.),
 * resamples the legacy tick history at spot:prices:<symbol> into 1m candles.
 * Volume in the fallback path is the tick count (meaningless), so volume-aware
 * indicators must guard against it (handled in their own modules).
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';

export interface OHLCVCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Real base volume from kline source; tick count from fallback. */
  volume: number;
  /** Quote volume in USD (kline source only). */
  quoteVolume?: number;
  /** Trade count (kline source only). */
  tradeCount?: number;
  /**
   * True when Binance marked the kline as closed (`x:true`). The live in-progress
   * candle is continuously upserted until closed, so any consumer that compares
   * volume against a window of full bars MUST filter on this flag — otherwise it
   * ends up comparing a fractional-minute volume to full-minute averages.
   */
  closed?: boolean;
}

const MINUTE_MS = 60_000;
const DEFAULT_LOOKBACK_MS = 60 * MINUTE_MS;

/**
 * Map of Hyperliquid perp symbols → Binance spot pair names used as the
 * kline-store key suffix. Confluence/ATR callers pass HL perp symbols
 * (`BTC`, `ETH`, ...), but BinanceFeed writes klines under the lowercase
 * Binance pair (`btcusdt`, `ethusdt`, ...). Without this normalization the
 * primary kline lookup misses, the tick fallback also misses, and every
 * indicator returns null — silently disabling the entire confluence pipeline.
 */
const HL_TO_BINANCE_PAIR: Record<string, string> = {
  // --- Majors (subscribed since day 1) ---
  BTC: 'btcusdt',
  ETH: 'ethusdt',
  SOL: 'solusdt',
  XRP: 'xrpusdt',
  ADA: 'adausdt',
  DOGE: 'dogeusdt',
  LINK: 'linkusdt',
  DOT: 'dotusdt',
  BNB: 'bnbusdt',
  AVAX: 'avaxusdt',
  SUI: 'suiusdt',
  TAO: 'taousdt',
  // --- In HL_SYMBOL_MAP but missing from BINANCE_SYMBOLS (TA was dead) ---
  ARB: 'arbusdt',
  OP: 'opusdt',
  POL: 'polusdt',
  BERA: 'berausdt',
  JUP: 'jupusdt',
  PENDLE: 'pendleusdt',
  ONDO: 'ondousdt',
  // --- New high-volume alts ---
  TON: 'tonusdt',
  TRX: 'trxusdt',
  NEAR: 'nearusdt',
  APT: 'aptusdt',
  INJ: 'injusdt',
  RENDER: 'rndrusdt',    // Binance still lists under old RNDR ticker
  UNI: 'uniusdt',
  ATOM: 'atomusdt',
  STX: 'stxusdt',
  // --- Political / meme ---
  TRUMP: 'trumpusdt',
  MELANIA: 'melaniausdt',
  kPEPE: 'pepeusdt',      // HL 1000× unit; same price direction as Binance PEPEUSDT
  WIF: 'wifusdt',
  kBONK: 'bonkusdt',      // HL 1000× unit; same price direction as Binance BONKUSDT
  PENGU: 'penguusdt',
  // --- Narrative ---
  FET: 'fetusdt',
  VIRTUAL: 'virtualusdt',
  WLD: 'wldusdt',
  ENA: 'enausdt',
  TIA: 'tiausdt',
  ORDI: 'ordiusdt',
  RUNE: 'runeusdt',
};

/**
 * Normalize a caller-supplied symbol to the kline-store key suffix.
 * - HL perp symbols (`BTC`, `ETH`, ...) → mapped Binance pair (`btcusdt`, ...)
 * - Already-normalized pairs (`btcusdt`) → returned lowercased
 */
export function normalizeKlineSymbol(symbol: string): string {
  const upper = symbol.toUpperCase();
  if (HL_TO_BINANCE_PAIR[upper]) return HL_TO_BINANCE_PAIR[upper];
  return symbol.toLowerCase();
}

export interface BuildCandlesOpts {
  timeframe?: '1m' | '5m';
  lookbackMs?: number;
}

/**
 * Build OHLCV candles for a symbol. Reads from the kline store first; if empty,
 * falls back to tick resampling. Returns candles sorted oldest-first.
 */
export async function buildCandles(
  symbol: string,
  redis: Redis,
  optsOrLookback: BuildCandlesOpts | number = {},
): Promise<OHLCVCandle[]> {
  // Back-compat: legacy callers pass a bare lookbackMs number.
  const opts: BuildCandlesOpts =
    typeof optsOrLookback === 'number' ? { lookbackMs: optsOrLookback } : optsOrLookback;
  const timeframe = opts.timeframe ?? '1m';
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;

  const sym = normalizeKlineSymbol(symbol);
  const now = Date.now();
  const from = now - lookbackMs;

  // Primary path: read real klines.
  const klineKey = `spot:klines:${sym}:${timeframe}`;
  try {
    const raw = await redis.zrangebyscore(klineKey, from, '+inf');
    if (raw.length > 0) {
      const candles: OHLCVCandle[] = [];
      for (const entry of raw) {
        try {
          const k = JSON.parse(entry) as {
            t: number;
            o: number;
            h: number;
            l: number;
            c: number;
            v: number;
            q?: number;
            n?: number;
            closed?: boolean;
          };
          if (
            !Number.isFinite(k.t) ||
            !Number.isFinite(k.o) ||
            !Number.isFinite(k.c) ||
            k.c <= 0
          ) {
            continue;
          }
          const candle: OHLCVCandle = {
            openTime: k.t,
            open: k.o,
            high: k.h,
            low: k.l,
            close: k.c,
            volume: k.v,
          };
          if (typeof k.q === 'number') candle.quoteVolume = k.q;
          if (typeof k.n === 'number') candle.tradeCount = k.n;
          if (typeof k.closed === 'boolean') candle.closed = k.closed;
          candles.push(candle);
        } catch {
          // skip malformed entry
        }
      }
      if (candles.length > 0) {
        candles.sort((a, b) => a.openTime - b.openTime);
        return candles;
      }
    }
  } catch (err) {
    logger.warn('[candleAggregator] kline read failed, falling back to ticks', {
      symbol: sym,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback path: resample ticks (only meaningful for 1m).
  if (timeframe !== '1m') return [];
  logger.debug('[candleAggregator] kline_fallback to tick resampler', { symbol: sym });

  const pricesKey = `spot:prices:${sym}`;
  const entries = await redis.zrangebyscore(pricesKey, from, '+inf');
  if (entries.length === 0) return [];

  const buckets = new Map<number, number[]>();
  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) continue;
    const ts = parseInt(entry.slice(0, colonIdx), 10);
    const price = parseFloat(entry.slice(colonIdx + 1));
    if (!isFinite(ts) || !isFinite(price) || price <= 0) continue;

    const bucket = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
    const existing = buckets.get(bucket);
    if (existing) existing.push(price);
    else buckets.set(bucket, [price]);
  }

  if (buckets.size === 0) return [];

  const candles: OHLCVCandle[] = [];
  for (const [openTime, prices] of buckets) {
    candles.push({
      openTime,
      open: prices[0]!,
      high: prices.reduce((m, p) => (p > m ? p : m), prices[0]!),
      low: prices.reduce((m, p) => (p < m ? p : m), prices[0]!),
      close: prices[prices.length - 1]!,
      volume: prices.length,
    });
  }

  candles.sort((a, b) => a.openTime - b.openTime);
  return candles;
}
