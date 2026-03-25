# Phase 5: Spot Price Monitor

**Date:** 2026-03-20
**Status:** Draft — awaiting Romeo approval
**Author:** Devin (Developer)

---

## 1. Problem Statement

Our entire signal pipeline is news-driven: RSS/GDELT headline → LLM urgency score → LLM probability estimate → divergence check → execute. This introduces a 5–15 minute information lag for events that manifest as price movements before journalists write about them.

For Polymarket markets correlated to liquid spot assets (BTC price targets, crude oil benchmarks, currency pairs), the relevant information is the spot price itself — not the headline *about* the spot price. Liquidity providers on Polymarket adjust within seconds of a spot move, but our bot doesn't see the event until it becomes a news article.

**The gap:** We're trading stale information on markets where real-time data is freely available.

## 2. Goal

Add a parallel signal source that monitors spot asset prices and generates trade signals when significant moves occur — without waiting for the news pipeline. This runs alongside the existing OSINT pipeline (not replacing it).

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    cron:trade (existing)                         │
│  RSS/GDELT → scorer → mapping → divergence → executor           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    cron:spot  (NEW)                              │
│  SpotPoller → ThresholdDetector → MarketCorrelator              │
│      → FastPathConsensus → divergence → executor                │
└─────────────────────────────────────────────────────────────────┘
```

Both pipelines emit `TradeSignal[]` and share the same executor, position ledger, idempotency layer, and Telegram notifications. They are independent cron jobs that do not interact with each other.

## 4. Scope

### In scope
- Polling spot prices from free public APIs (CoinGecko primary, Binance fallback)
- Detecting significant moves (configurable threshold per asset)
- Mapping spot moves to relevant Polymarket markets via Gamma API
- Fast-path probability adjustment (not full LLM consensus — formula-based)
- Trade execution via existing executor (Simmer → CLOB fallback)
- Redis state for rolling price windows and move detection
- New config env vars for spot monitoring
- New cron entry (`cron:spot`)
- Unit tests for all new modules

### Out of scope
- WebSocket streaming (polling is sufficient at 1-min intervals for our execution speed)
- Custom price feeds or paid APIs
- Markets with no quantitative spot-asset correlation (e.g. "Will Biden pardon X?" — these stay news-only)
- Changes to the existing news pipeline
- Backtesting framework for spot signals

## 5. Detailed Design

### 5.1 Spot Poller (`src/spot/poller.ts`)

Polls spot prices from CoinGecko's free `/simple/price` endpoint (no API key required for basic tier, 30 calls/min rate limit). Stores a rolling 60-minute price window in Redis.

**Tracked assets (initial set — configurable):**

| Asset | CoinGecko ID | Rationale |
|-------|-------------|-----------|
| BTC | bitcoin | Most Polymarket crypto markets reference BTC |
| ETH | ethereum | DeFi/regulatory markets often correlated |
| Crude Oil (WTI) | — | Geopolitical conflict → oil markets (via proxy: use Binance oil token or skip for MVP) |
| Gold | — | Safe-haven asset for conflict escalation markets |

**Commodity assets** (via Yahoo Finance v8 chart endpoint — free, no API key, delayed 1-3 min):

| Asset | Yahoo Ticker | Rationale |
|-------|-------------|-----------|
| WTI Crude | `CL=F` | Iran/OPEC/sanctions markets — highest geopolitical signal density |
| Gold | `GC=F` | Safe-haven proxy for conflict escalation |

**Data source strategy:**
- CoinGecko (free, no key): BTC, ETH — single batch call, ~15-30s freshness
- Yahoo Finance (free, no key): WTI (`CL=F`), Gold (`GC=F`) — one call per ticker, ~1-3 min delayed
- Both sources polled in parallel per cycle. If either fails, the other still fires.
- Zero API keys required for the entire spot pipeline.

**Redis schema:**
```
spot:prices:{assetId}  →  SortedSet(timestamp → price)
spot:last:{assetId}    →  { price, timestamp }
```

Rolling window: 60 minutes. Entries older than 60 min are pruned on each poll cycle.

**Rate limiting:**
- CoinGecko: One batch call per cycle (`/simple/price?ids=bitcoin,ethereum&vs_currencies=usd`). Well within 30/min free tier.
- Yahoo Finance: One call per commodity ticker (2 calls total). No documented rate limit for this volume. User-Agent header required.

### 5.2 Threshold Detector (`src/spot/thresholdDetector.ts`)

Compares current price to the rolling window and detects significant moves.

```typescript
interface SpotMove {
  assetId: string;
  currentPrice: number;
  referencePrice: number;    // price N minutes ago
  changePercent: number;     // signed: +5.2 or -3.1
  windowMinutes: number;     // lookback window that triggered
  detectedAt: string;        // ISO timestamp
}
```

**Trigger logic:**
- Compare current price vs. price at `T - windowMinutes` (configurable, default: 5 min)
- If `|changePercent| >= SPOT_MOVE_THRESHOLD` (configurable, default: 3%), emit a `SpotMove`
- Cooldown: after triggering, suppress re-triggers for same asset + same direction for `SPOT_COOLDOWN_MINUTES` (default: 30 min) via Redis flag

**Why 3% in 5 minutes?** BTC moves ±3% in 5 minutes roughly 2–3 times per month. This is significant enough that Polymarket odds should shift meaningfully, but not so sensitive that we'd be triggering on noise.

### 5.3 Market Correlator (`src/spot/marketCorrelator.ts`)

Given a `SpotMove`, finds Polymarket markets whose resolution is plausibly affected.

**Strategy:** Query Gamma API with asset-specific search terms:

| Asset | Search queries |
|-------|---------------|
| BTC | `"bitcoin"`, `"BTC"`, `"crypto"` |
| ETH | `"ethereum"`, `"ETH"` |
| WTI Crude | `"oil"`, `"crude"`, `"OPEC"`, `"sanctions"` |
| Gold | `"gold"`, `"safe haven"`, `"precious metals"` |

For each matching active market, fetch current `outcomePrices`. Filter to markets with sufficient liquidity (`volume > $10k` or `liquidity > $5k`).

**Output:**
```typescript
interface CorrelatedMarket {
  marketId: string;
  conditionId: string;
  clobTokenIds: string[];
  question: string;
  description: string | null;
  currentYesPrice: number;
  correlationDirection: 'positive' | 'negative';
  // positive = asset price up → YES more likely
  // negative = asset price up → YES less likely
}
```

**Correlation direction inference:**
- Use a lightweight LLM call (single shot, Gemini Flash) with the market question + the spot move to determine: "Does BTC rising 5% make this market more or less likely to resolve YES?"
- Cache the correlation direction in Redis per market ID (TTL: 24h) — the relationship between "Will BTC hit $X by date Y?" and BTC spot price doesn't change intra-day.

### 5.4 Fast-Path Consensus (`src/spot/fastPathConsensus.ts`)

This is the key differentiator from the news pipeline. Instead of a full LLM probability estimate, we use a **formula-based probability adjustment** for price-target markets, with an LLM fallback for complex markets.

**Price-target markets** (e.g. "Will BTC be above $100k on June 30?"):
- Extract target price and deadline from market question (regex + lightweight LLM parse if regex fails)
- Calculate probability using current spot price, historical volatility, and time to expiry
- Formula: Black-Scholes-inspired binary option probability (normal CDF of log-price distance / vol√t)
- This runs in <1ms with zero API calls

**Non-price-target markets** (e.g. "Will the SEC approve a Bitcoin ETF?"):
- Fall back to the existing `estimateConsensusProbability()` from `consensusCalculator.ts`
- The spot move is injected as context: "Breaking: BTC just moved +5% in 5 minutes. Given this..."
- Still faster than news pipeline because we skip the ingestion/scoring stages entirely

**Output:** Same `consensusProbability` number (0–1) that feeds into the existing `computeDivergence()`.

### 5.5 Pipeline Orchestration (`src/spot/index.ts`)

```
poll() → detect() → correlate() → estimate() → diverge() → execute()
```

Reuses existing:
- `computeDivergence()` from `mapping/divergenceCalculator.ts`
- `executeSignals()` from `execution/executor.ts`
- `recordPosition()` from `execution/positionLedger.ts`
- `notifyTradeExecuted()` / `notifyTradeError()` from `execution/telegram.ts`

Emits standard `TradeSignal[]` — the executor doesn't know or care whether the signal came from news or spot.

### 5.6 Configuration

New env vars (all optional — spot monitor is disabled by default):

```env
# Enable/disable the spot price monitor
SPOT_MONITOR_ENABLED=true

# Minimum % move to trigger (default: 3)
SPOT_MOVE_THRESHOLD=3

# Lookback window in minutes (default: 5)
SPOT_LOOKBACK_MINUTES=5

# Cooldown per asset+direction after trigger (default: 30)
SPOT_COOLDOWN_MINUTES=30

# Divergence threshold for spot signals (default: 0.12 = 12%)
# News pipeline runs at 20%. Spot is lower because it's hard price data,
# but not drastically lower — still need meaningful edge before committing capital.
SPOT_DIVERGENCE_THRESHOLD=0.12

# Crypto assets to track via CoinGecko (comma-separated CoinGecko IDs)
SPOT_CRYPTO_ASSETS=bitcoin,ethereum

# Commodity assets to track via Yahoo Finance (comma-separated tickers)
SPOT_COMMODITY_ASSETS=CL=F,GC=F
```

Added to the Zod schema in `config.ts` with defaults. Entire module is no-op when `SPOT_MONITOR_ENABLED=false`.

## 6. Task Breakdown

### Epic: Phase 5 — Spot Price Monitor

| # | Task | Description | Files |
|---|------|-------------|-------|
| 5.1 | Spot price poller | CoinGecko (crypto) + Commodities-API (WTI, Gold) polling, Redis rolling window, rate limiting, parallel fetching | `src/spot/poller.ts`, `src/spot/__tests__/poller.test.ts` |
| 5.2 | Threshold detector | Rolling window comparison, configurable thresholds, per-asset cooldown | `src/spot/thresholdDetector.ts`, `src/spot/__tests__/thresholdDetector.test.ts` |
| 5.3 | Market correlator | Gamma query by asset, correlation direction via LLM, Redis cache | `src/spot/marketCorrelator.ts`, `src/spot/__tests__/marketCorrelator.test.ts` |
| 5.4 | Fast-path consensus | Binary option probability formula for price targets, LLM fallback for non-numeric markets | `src/spot/fastPathConsensus.ts`, `src/spot/__tests__/fastPathConsensus.test.ts` |
| 5.5 | Pipeline orchestration | Wire poll→detect→correlate→estimate→diverge→execute, `cron:spot` entry (1-min interval) | `src/spot/index.ts`, update `package.json` |
| 5.6 | Config & integration | Zod schema additions (`SPOT_DIVERGENCE_THRESHOLD`, commodity env vars), feature flag, README update | `src/shared/config.ts`, `README.md` |

**Estimated complexity:** Moderate-Complex. ~6 files of new code, heavy reuse of existing execution infra.

## 7. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| CoinGecko rate limit (30/min free) | Polling fails | Single batched call per cycle; exponential backoff on 429 |
| Yahoo Finance endpoint changes/blocks | Commodity polling fails | Graceful degradation (crypto still fires if Yahoo is down); User-Agent header; low call volume (2/min) minimises detection risk |
| False triggers on normal volatility | Wasted trades | 3% threshold + 30 min cooldown. Tunable post-launch. |
| Correlation direction wrong | Trade the wrong side | LLM inference + 24h cache. Manual override list as escape hatch. |
| Price-target formula miscalibration | Inaccurate probability | Conservative vol estimate (annualised 80% for BTC). Formula only for clean price-target markets; everything else uses LLM. |
| Double entry: news + spot trigger same market | Over-exposure | Existing idempotency layer (1h Redis TTL) + position-already-open check in executor handles this natively. |

## 8. Success Criteria

- Spot pipeline detects a ≥3% BTC move and generates a trade signal within 2 minutes of the move
- Signal reaches executor and produces a trade (or correctly skips if idempotency/position guard fires)
- Zero interference with existing news pipeline
- All new code has unit test coverage
- Feature is fully gated behind `SPOT_MONITOR_ENABLED` — off by default

## 9. Resolved Decisions

1. **Cron frequency:** 1 minute. Single CoinGecko + single Commodities-API call per cycle — well within free tier limits for both.
2. **Divergence threshold:** Separate `SPOT_DIVERGENCE_THRESHOLD=0.12` (12%) for spot signals, vs news pipeline at 20%. Spot data is higher-confidence hard data so a lower threshold is appropriate, but still requires meaningful edge. Ratio: spot fires at 60% of the news threshold.
3. **Commodity tracking:** Included in MVP. WTI Crude (`CL=F`) and Gold (`GC=F`) via Yahoo Finance v8 chart endpoint — free, no API key. Geopolitical climate makes oil/gold correlation to Polymarket markets too relevant to defer.
