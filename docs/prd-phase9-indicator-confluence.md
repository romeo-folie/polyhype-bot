# PRD: Phase 9 — Indicator Confluence Engine for BTC Short-Duration Markets

**Date:** 2026-03-30
**Author:** Devin
**Status:** Draft — awaiting Romeo sign-off

---

## Context

@0x_Punisher (72K views, March 29 2026) documented a wallet that turned $5.67 → $19,000 in one week on Polymarket's BTC 5-minute Up/Down contracts using 1,200+ trades with systematic indicator logic. The key insight: edge comes from **RSI + MACD + Stochastic confluence**, not raw price movement.

PGA's current crypto-arb path (Phase 7) fires on any `spot:price_moved` event and estimates probability using a Black-Scholes binary formula. It has no awareness of whether the market is trending, momentum-confirmed, or at an extreme. This phase adds a technical indicator layer that gates entries on confluence, dramatically improving signal precision.

---

## Scope

Phase 9 applies specifically to **BTC 5-minute Up/Down markets** on Polymarket — the highest-liquidity, most systematic crypto markets. The indicator stack is computed from the BinanceFeed rolling price series already stored in Redis.

---

## Architecture

### New module: `src/arb/indicators.ts`

Computes technical indicators from the `spot:prices:<symbol>` sorted set in Redis.

The BinanceFeed stores price ticks as a sorted set:
- Key: `spot:prices:btcusdt`
- Members: `"<timestamp>:<price>"`
- Score: timestamp (ms)
- TTL: 2 hours
- Retention: last 1 hour of ticks

Indicator functions read directly from this series — no external API calls.

#### Exported functions:

```typescript
// Returns RSI (0–100) for the last `period` price changes
// Standard Wilder smoothing: RS = avgGain / avgLoss
export async function computeRSI(symbol: string, redis: Redis, period?: number): Promise<number | null>

// Returns MACD line, signal line, histogram
export async function computeMACD(
  symbol: string,
  redis: Redis,
  fastPeriod?: number,   // default 12
  slowPeriod?: number,   // default 26
  signalPeriod?: number, // default 9
): Promise<{ macdLine: number; signalLine: number; histogram: number } | null>

// Returns %K and %D stochastic oscillator
export async function computeStochastic(
  symbol: string,
  redis: Redis,
  kPeriod?: number,  // default 14
  dPeriod?: number,  // default 3
): Promise<{ k: number; d: number } | null>
```

All functions return `null` if insufficient data. All use the same `spot:prices:<symbol>` Redis key.

---

### Confluence scorer: `src/arb/confluenceScorer.ts`

```typescript
export interface ConfluenceScore {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  score: number;         // 0 (no signal) to 3 (all 3 indicators agree)
  signals: {
    rsi?: 'oversold' | 'overbought' | 'neutral';
    macd?: 'bullish_cross' | 'bearish_cross' | 'neutral';
    stochastic?: 'oversold_cross' | 'overbought_cross' | 'neutral';
  };
}

export async function scoreConfluence(
  symbol: string,
  redis: Redis,
): Promise<ConfluenceScore>
```

Logic:
- **RSI**: < 30 → oversold signal (+1 UP), > 70 → overbought signal (+1 DOWN)
- **MACD**: histogram > 0 AND macdLine > signalLine → bullish cross (+1 UP), histogram < 0 AND macdLine < signalLine → bearish cross (+1 DOWN)
- **Stochastic**: %K crossing above %D below 20 → oversold cross (+1 UP), %K crossing below %D above 80 → overbought cross (+1 DOWN)

`score` = count of indicators agreeing on same direction. `direction` = majority direction. Threshold configurable via `CRYPTO_ARB_MIN_CONFLUENCE_SCORE` (default 2).

---

### Integration in `src/arb/cryptoArbScanner.ts`

After the volatility gate (Phase 7 enhancement), before market lookup:

```typescript
// Confluence gate for BTC markets specifically
if (cfg.CONFLUENCE_GATE_ENABLED && move.assetId === 'bitcoin') {
  const confluence = await scoreConfluence('btcusdt', redis);
  if (confluence.score < cfg.CRYPTO_ARB_MIN_CONFLUENCE_SCORE) {
    logger.debug('[crypto-arb] insufficient indicator confluence — skipping', {
      score: confluence.score,
      direction: confluence.direction,
      signals: confluence.signals,
    });
    return [];
  }
  // Bias direction: only look for UP opportunities on bullish confluence, DOWN on bearish
  // This replaces the bidirectional scan with a directional one
}
```

When confluence is confirmed, pass the `direction` to filter correlated markets:
- `direction: 'UP'` → only evaluate markets where the YES outcome correlates with BTC rising
- `direction: 'DOWN'` → only evaluate markets where NO outcome correlates with BTC falling

---

### Config additions

```
CONFLUENCE_GATE_ENABLED=true          # master switch, default true
CRYPTO_ARB_MIN_CONFLUENCE_SCORE=2     # min indicators agreeing (0-3), default 2
RSI_PERIOD=14                         # default 14
MACD_FAST=12                          # default 12
MACD_SLOW=26                          # default 26
MACD_SIGNAL=9                         # default 9
STOCHASTIC_K_PERIOD=14               # default 14
STOCHASTIC_D_PERIOD=3                # default 3
```

---

## Tests

### `src/arb/__tests__/indicators.test.ts`
- RSI: computed correctly for known price series
- RSI: returns null when insufficient data
- MACD: crossover detection correct
- Stochastic: %K/%D crossover in oversold zone triggers signal
- All: handle empty Redis key gracefully

### `src/arb/__tests__/confluenceScorer.test.ts`
- 3/3 indicators bullish → score=3, direction=UP
- 2/3 indicators bearish → score=2, direction=DOWN
- All neutral → score=0, direction=NEUTRAL
- Mix → direction=UP when 2 UP vs 1 DOWN

---

## Phases

**Phase 9a** — Indicator engine + confluence scorer (indicators.ts, confluenceScorer.ts, tests)
**Phase 9b** — Integration into cryptoArbScanner + directional market filtering
**Phase 9c** — Extend to ETH, SOL markets (BTC-only in 9a/b)

---

## Open Questions for Romeo

1. **Tick resolution:** BinanceFeed stores every tick. Indicators at tick-level may be noisy. Should we resample to 1-min candles before computing RSI/MACD? Requires storing OHLCV, not just close prices.
2. **Confluence threshold:** Default 2/3 — conservative. For higher frequency, 1/3 with tight RSI threshold might be better. Want to start conservative or aggressive?
3. **5-min BTC Up/Down markets only, or all BTC price targets?** The author focused on 5-min contracts. Should we filter to only those in the arb scan?
4. **Branch timing:** Build off `feat/latency-optimization-and-flexibility` after current PRs merge?
