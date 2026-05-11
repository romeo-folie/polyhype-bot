/**
 * CryptoQuant alert structured message parser.
 *
 * Converts cryptoquant_alert messages into ScoredItems with a directional title
 * that mapNewsToFutures can act on. Falls back to null if no known pattern matches
 * (caller should route unrecognised messages through the normal scorer).
 *
 * Supported alert types and their directional interpretation:
 *   Exchange Inflow  → SHORT (coins moving to exchanges = impending sell)
 *   Exchange Outflow → LONG  (coins leaving exchanges = accumulation)
 *   Miner → Exchange → SHORT (miners offloading)
 *   High +ve Funding → SHORT (over-leveraged longs, mean-revert)
 *   High -ve Funding → LONG  (over-leveraged shorts, mean-revert)
 *   Whale deposit to exchange → SHORT
 *   Liquidation cascade    → LONG (forced SHORT liquidations = short squeeze bounce)
 */

import type { ScoredItem } from './scorer.js';

interface CqPattern {
  regex: RegExp;
  direction: 'LONG' | 'SHORT';
  urgency: number;
  label: string;
}

const CQ_PATTERNS: CqPattern[] = [
  {
    regex: /exchange\s+inflow/i,
    direction: 'SHORT',
    urgency: 7,
    label: 'exchange inflow',
  },
  {
    regex: /exchange\s+outflow/i,
    direction: 'LONG',
    urgency: 7,
    label: 'exchange outflow',
  },
  {
    regex: /miner.*?(?:to\s+exchange|outflow|sell)/i,
    direction: 'SHORT',
    urgency: 6,
    label: 'miner selling',
  },
  {
    regex: /funding\s+rate.*?(?:high|extremely\s+positive|spike|surge)|(?:high|positive)\s+funding/i,
    direction: 'SHORT',
    urgency: 7,
    label: 'high positive funding',
  },
  {
    regex: /funding\s+rate.*?(?:low|negative|extremely\s+negative)|(?:negative|low)\s+funding/i,
    direction: 'LONG',
    urgency: 7,
    label: 'high negative funding',
  },
  {
    regex: /whale.*?(?:deposit|sent?|transfer).*?exchange|large.*?deposit.*?exchange/i,
    direction: 'SHORT',
    urgency: 8,
    label: 'whale deposit to exchange',
  },
  {
    regex: /liquidat(?:ion|ed).*?(?:cascade|surge|spike)|large\s+liquidat/i,
    direction: 'LONG',
    urgency: 8,
    label: 'liquidation cascade',
  },
];

// Extracts an asset symbol from CryptoQuant alert text.
// CQ uses patterns like: "Exchange Inflow (BTC)" or "(BTC/USDT)" or "BTC:"
function extractSymbol(text: string): string {
  const parenMatch = /\(([A-Z]{2,6})(?:\/\w+)?\)/.exec(text);
  if (parenMatch) return parenMatch[1]!;
  const colonMatch = /^([A-Z]{2,6}):/.exec(text.trim());
  if (colonMatch) return colonMatch[1]!;
  // Default: BTC — CryptoQuant is predominantly BTC-focused
  return 'BTC';
}

export function parseCryptoQuantAlert(
  text: string,
  source: string,
  url: string,
  publishedAt: Date,
): ScoredItem | null {
  for (const pattern of CQ_PATTERNS) {
    if (!pattern.regex.test(text)) continue;

    const symbol = extractSymbol(text);
    const dirWord = pattern.direction === 'LONG' ? 'bullish' : 'bearish';
    const title = `${symbol} ${dirWord}: ${pattern.label} detected — on-chain signal`;

    return {
      title,
      url,
      publishedAt,
      source,
      urgencyScore: pattern.urgency,
      keywords: [symbol],
      categoryId: 'crypto-futures',
      categoryLabel: 'Crypto / Futures',
      entityContext: 'cryptocurrency, on-chain data, exchange flow',
      sentiment: 'NEUTRAL',
    };
  }

  return null;
}
