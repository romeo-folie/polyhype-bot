/**
 * Whale Alert structured message parser.
 *
 * Converts whale_alert_io / whalebotalerts messages directly into ScoredItems,
 * bypassing LLM urgency scoring. Direction is determined by fund flow:
 *   - wallet/unknown → exchange = sell pressure → SHORT (title phrased bearishly)
 *   - exchange → wallet/unknown = accumulation → LONG (title phrased bullishly)
 *   - exchange → exchange = skip (internal settlement, not directional)
 */

import type { ScoredItem } from './scorer.js';

const KNOWN_EXCHANGES = new Set([
  'binance', 'coinbase', 'kraken', 'okx', 'bybit', 'huobi', 'htx',
  'bitfinex', 'gemini', 'kucoin', 'mexc', 'bitget', 'gate', 'gateio',
  'poloniex', 'bithumb', 'upbit', 'bitstamp', 'crypto', 'bitmex',
  'deribit', 'phemex', 'lbank', 'bitmart',
]);

// Stablecoins — transfers are not directional price signals; skip them.
const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'BUSD', 'TUSD', 'USDE', 'FDUSD', 'PYUSD']);

// Handles two live channel formats:
//   whale_alert_io:   "5,000 $BTC (421,000,000 USD) transferred from Unknown to Binance"
//   whalebotalerts:   "5,000 BTC ($421,000,000) transfered from Unknown wallet to Binance"
//   legacy/original:  "5,000 #BTC (421,000,000 USD) transferred from #Binance to unknown wallet"
// The USD suffix is optional to support the whalebotalerts dollar-prefix format.
// Protection against capturing the wrong parenthetical (e.g. a block count) is provided
// by the minUsdM threshold — both channels always put the dollar amount first after the symbol.
const TRANSFER_REGEX =
  /([\d,]+)\s+[$#]?(\w+)[\s\S]*?\(\$?([\d,]+(?:\.\d+)?)\s*(?:USD|USDT)?\)[\s\S]*?from\s+(#?\w+)[\s\S]*?to\s+(#?\w+)/i;

function classifyEndpoint(name: string): 'exchange' | 'unknown' {
  const normalized = name.replace(/^#/, '').toLowerCase().replace(/[._\-\s]/g, '');
  for (const ex of KNOWN_EXCHANGES) {
    if (normalized.includes(ex)) return 'exchange';
  }
  return 'unknown';
}

export function parseWhaleAlert(
  text: string,
  source: string,
  url: string,
  publishedAt: Date,
  minUsdM: number,
): ScoredItem | null {
  const match = TRANSFER_REGEX.exec(text);
  if (!match) return null;

  const [, , rawSymbol, rawUsd, fromRaw, toRaw] = match;
  if (!rawSymbol || !rawUsd || !fromRaw || !toRaw) return null;

  const usdValue = parseFloat(rawUsd.replace(/,/g, ''));
  if (isNaN(usdValue) || usdValue < minUsdM * 1_000_000) return null;

  const symbol = rawSymbol.toUpperCase();
  if (STABLECOINS.has(symbol)) return null;

  const fromType = classifyEndpoint(fromRaw);
  const toType = classifyEndpoint(toRaw);

  // Skip exchange↔exchange (internal settlement) and unknown↔unknown (non-directional)
  if (fromType === 'exchange' && toType === 'exchange') return null;
  if (fromType === 'unknown' && toType === 'unknown') return null;

  const usdM = (usdValue / 1_000_000).toFixed(0);

  let title: string;
  if (toType === 'exchange') {
    title = `${symbol} bearish: $${usdM}M transferred to exchange — sell pressure incoming`;
  } else {
    title = `${symbol} bullish: $${usdM}M moved off exchange — accumulation signal`;
  }

  // Urgency scales with transfer size: $20-50M → 7, $50-100M → 8, $100M+ → 9
  let urgencyScore = 7;
  if (usdValue >= 100_000_000) urgencyScore = 9;
  else if (usdValue >= 50_000_000) urgencyScore = 8;

  return {
    title,
    url,
    publishedAt,
    source,
    urgencyScore,
    keywords: [symbol],
    categoryId: 'crypto-futures',
    categoryLabel: 'Crypto / Futures',
    entityContext: 'cryptocurrency, whale transfer, exchange flow',
    sentiment: 'NEUTRAL',
  };
}
