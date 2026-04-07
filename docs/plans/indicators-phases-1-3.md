# Plan: Indicator Phases 1–3

## Context

Our confluence scorer (`src/arb/confluenceScorer.ts`) currently votes only on RSI/MACD/Stochastic — all price-only. Worse, `src/arb/candleAggregator.ts:67` reports `volume = prices.length`, derived from a `@ticker` WebSocket subscription (`src/spot/feeds/binanceFeed.ts:40`) that pushes 1s mid-price snapshots. There is **no real volume in the system today**, and OHLC is reconstructed from snapshot mids rather than true trade prints. This makes the futures pre-entry gate and the post-entry TA-reversal exit blind to participation, lets thin-volume fakeouts trip indicators identically to real impulses, and means our 0.5%/5min spot-momentum trigger and our fixed `-3% / +6%` SL/TP cannot adapt to volatility regime.

The goal of Phases 1–3 is to (1) replace the broken data foundation with real OHLCV from Binance kline streams, (2) make confluence volume-aware, and (3) gate trades by trend/regime so we stop entering choppy ranges with momentum logic. Together these address the largest source of avoidable losses on the futures path: fakeouts and regime-mismatched entries.

Note from exploration: **ATR already exists** (`src/arb/indicators.ts:65 computeATRFromCandles`, `:95 computeATR`), and `FUTURES_ATR_PERIOD` / `FUTURES_VOL_SIZING_ENABLED` already exist in config. ATR is currently only used for optional stake sizing — Phase 1 mainly needs to re-purpose it for SL/TP placement and make it trustworthy by feeding it real candles.

---

## Phase 1 — Data foundation + ATR-based SL/TP + z-score trigger

### 1.1 Migrate Binance feed from `@ticker` to `@kline_1m` + `@kline_5m`

**Files**
- `src/spot/feeds/binanceFeed.ts` (lines 39–115): change stream subscription, message handler, Redis writes.
- `src/arb/candleAggregator.ts` (rewrite `buildCandles`): become a thin reader of stored klines.
- `src/spot/feeds/manager.ts`: no change expected (still spawns `BinanceFeed`).

**Approach**
- Subscribe to combined streams: `wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m/btcusdt@kline_5m/...` (each symbol ×2 timeframes).
- Message handler keys off `data.k` fields: `t` (open ms), `o/h/l/c`, `v` (base volume), `q` (quote volume USD), `n` (trade count), `x` (closed flag).
- **Keep existing `spot:last:{symbol}` and `spot:prices:{symbol}` writes intact** so the threshold detector, poller, correlator, and PM path keep working unchanged. Write the close price every kline update.
- **Add new candle storage**:
  - `spot:klines:{symbol}:1m` — Redis sorted set, score = `openTime`, member = JSON `{t,o,h,l,c,v,q,n,closed}`. Keep last ~240 entries (4h) via `ZREMRANGEBYRANK`.
  - `spot:klines:{symbol}:5m` — same shape, keep last ~288 entries (24h).
  - On every message, upsert the current bar (delete-by-score then add); when `x: true`, mark closed.
- Reconnect logic stays identical (exponential backoff, max 10).

**`buildCandles()` rewrite**
- New signature: `buildCandles(symbol, redis, opts?: { timeframe?: '1m' | '5m', lookbackMs?: number })`. Default `1m`, 60min lookback (matches today).
- Read from `spot:klines:{symbol}:{tf}` via `ZRANGEBYSCORE`, JSON.parse each.
- Return `OHLCVCandle[]` with the existing shape but `volume` is now real base volume (number of coins traded). Add an optional `quoteVolume` field for VWAP/MFI.
- **Fallback**: if the kline key is empty (e.g., warmup, or symbol not in kline subscription), fall back to the old tick-resampling path against `spot:prices:{symbol}`. Log a `kline_fallback` warning. This protects against deploy-time gaps and lets non-Binance assets (Helius/Pyth, CoinGecko poller) keep working with degraded volume.

**Type changes**
- Extend `OHLCVCandle` in `src/arb/candleAggregator.ts:10` with optional `quoteVolume?: number` and `tradeCount?: number`. All existing consumers ignore them.

**Tests**
- Update `src/arb/__tests__/candleAggregator.test.ts`: add a test path that mocks `spot:klines:btcusdt:1m` zset and asserts the parsed candles. Keep one test for the tick-fallback path.
- Add a small unit test in a new `src/spot/feeds/__tests__/binanceFeed.kline.test.ts` exercising the kline message handler (parse, upsert, closed flag) without a real WS.

### 1.2 ATR-based dynamic SL/TP for futures

**Files**
- `src/monitor/futuresMonitor.ts` (lines 165–171): replace fixed-percent SL/TP comparison with ATR-derived thresholds.
- `src/execution/executor.ts` (or wherever futures positions are recorded — check `executeHyperliquidSignal`): persist `entryAtr` and `entryAtrPct` to the position ledger at entry time so the monitor doesn't have to recompute against drifting candles.
- `src/shared/config.ts`: add new env vars (see below). Keep `FUTURES_STOP_LOSS_PCT` / `FUTURES_TAKE_PROFIT_PCT` as a fallback when ATR is unavailable.

**Approach**
- At entry (in `executor.ts` after the trade fills), call `computeATRFromCandles(candles, FUTURES_ATR_PERIOD)` using the same candle set already fetched for the confluence gate (pass it through to avoid a second Redis hit). Store `{atr, atrPct}` on the ledger entry alongside `entryPrice`.
- In `futuresMonitor.ts`, compute SL/TP distance as:
  - `slDistance = entryAtrPct * FUTURES_ATR_SL_MULT` (default 1.5)
  - `tpDistance = entryAtrPct * FUTURES_ATR_TP_MULT` (default 3.0)
  - Apply min/max clamps: `FUTURES_ATR_SL_MIN_PCT` (default 1.0), `FUTURES_ATR_SL_MAX_PCT` (default 5.0); same for TP.
- If `entryAtrPct` is missing on a legacy position, fall back to fixed `FUTURES_STOP_LOSS_PCT / FUTURES_TAKE_PROFIT_PCT`.
- Trailing-stop activation (`FUTURES_TRAILING_ACTIVATION_PCT`) and trail-stop distance (`FUTURES_TRAILING_STOP_PCT`) become ATR-multiples by the same pattern: `FUTURES_ATR_TRAIL_ACT_MULT` (default 2.0), `FUTURES_ATR_TRAIL_STOP_MULT` (default 1.0).
- Gated by new `FUTURES_ATR_SLTP_ENABLED` (default `false` initially so we can deploy and turn on after observing ATR values in logs).

**Tests**
- Extend `src/arb/__tests__/indicators.test.ts` ATR section if needed (already has ATR coverage).
- Add `src/monitor/__tests__/futuresMonitor.atr.test.ts` (or extend an existing monitor test) that mocks a position with `entryAtrPct` and asserts ATR-based exits trigger.

### 1.3 Z-score spot-momentum trigger

**Files**
- `src/spot/thresholdDetector.ts` (lines 49–121): add z-score path alongside the existing percent-threshold path.
- `src/shared/config.ts`: add `SPOT_TRIGGER_MODE`, `SPOT_ZSCORE_THRESHOLD`, `SPOT_ZSCORE_LOOKBACK_MIN`.

**Approach**
- New env `SPOT_TRIGGER_MODE: 'pct' | 'zscore' | 'both'` (default `pct` initially; flip after validation).
- For `zscore` mode:
  - Pull last N=`SPOT_ZSCORE_LOOKBACK_MIN` (default 60) 1m closes from `spot:klines:{symbol}:1m`.
  - Compute the rolling series of 5min log returns: `r_i = ln(c_i / c_{i-5})`.
  - Compute mean μ and stddev σ. Current return `r_now = ln(c_now / c_{now-5})`.
  - z = `(r_now - μ) / σ`. If `|z| >= SPOT_ZSCORE_THRESHOLD` (default 2.5), trigger; direction = sign of `r_now`.
- For `both` mode: trigger only if both percent and z-score agree (strictest).
- Cooldown logic untouched (`spot:cooldown:{assetId}:{direction}`).
- Session multipliers (`SESSION_MULTIPLIERS`) continue to apply to the percent path but not z-score (z-score is already regime-normalized).

**Tests**
- Extend `src/spot/__tests__/thresholdDetector.test.ts` with z-score cases: flat market, single spike, regime shift.

### 1.4 New env vars (Phase 1)

Add to `src/shared/config.ts` Zod schema and document in `.env.example`:

```
# Kline feed
BINANCE_KLINE_TIMEFRAMES=1m,5m       # comma list; 1m required
KLINE_RETENTION_1M=240                # bars retained per symbol (4h)
KLINE_RETENTION_5M=288                # bars retained per symbol (24h)

# ATR-based SL/TP
FUTURES_ATR_SLTP_ENABLED=false        # turn on after observing ATR in logs
FUTURES_ATR_SL_MULT=1.5
FUTURES_ATR_TP_MULT=3.0
FUTURES_ATR_SL_MIN_PCT=1.0
FUTURES_ATR_SL_MAX_PCT=5.0
FUTURES_ATR_TP_MIN_PCT=2.0
FUTURES_ATR_TP_MAX_PCT=10.0
FUTURES_ATR_TRAIL_ACT_MULT=2.0
FUTURES_ATR_TRAIL_STOP_MULT=1.0

# Z-score trigger
SPOT_TRIGGER_MODE=pct                 # pct | zscore | both
SPOT_ZSCORE_THRESHOLD=2.5
SPOT_ZSCORE_LOOKBACK_MIN=60
```

---

## Phase 2 — Volume-aware confluence

### 2.1 New volume indicators in `src/arb/indicators.ts`

Add pure-function versions (operate on `OHLCVCandle[]`) so they can be unit-tested without Redis:

- `computeOBV(candles): number[]` — running cumulative signed volume.
- `computeOBVSlope(candles, lookback=10): number` — slope of OBV over the last N bars (for "rising/falling/flat" signal).
- `computeMFI(candles, period=14): number | null` — typical price × volume, +/- by price direction, then RSI-style.
- `computeVWAP(candles, lookback=60): number | null` — `Σ(typical × volume) / Σ(volume)` over the lookback window.
- `computeCMF(candles, period=20): number | null` — Chaikin Money Flow.
- `computeVolumeSMA(candles, period=20): number | null` — for the volume-spike gate.

All take real `volume` (Phase 1 prerequisite). MFI/CMF gracefully return `null` if any candle has `volume === 0`.

**Config additions**
```
OBV_SLOPE_LOOKBACK=10
MFI_PERIOD=14
VWAP_LOOKBACK_MIN=60
CMF_PERIOD=20
VOLUME_SPIKE_PERIOD=20
VOLUME_SPIKE_MULT=2.0                 # currentVol > 2× SMA20(vol)
```

### 2.2 Volume spike hard gate

**Files**
- `src/spot/index.ts` (lines 104–128, futures TA confluence gate): add a pre-confluence gate.
- `src/mapping/index.ts` (lines 258–283, news→futures gate): same.

**Approach**
- After fetching candles for confluence, also compute `volSma = computeVolumeSMA(candles, VOLUME_SPIKE_PERIOD)` and current `vol = candles[last].volume`.
- If `VOLUME_SPIKE_GATE_ENABLED` (default `true`) and `vol < volSma * VOLUME_SPIKE_MULT`, log `volume_spike_block` and skip the trade. This is a hard gate, NOT a vote.
- Skip reason flows through the same Telegram-suppression path as `confluence_block`.

### 2.3 Extend `scoreFromValues()` with volume votes

**Files**
- `src/arb/confluenceScorer.ts` (lines 27–120): widen `ConfluenceScore.signals` and add OBV / MFI / VWAP / CMF voting.
- `scoreConfluence()`: fetch candles once, compute the new indicator values from them, pass into `scoreFromValues`.

**Voting rules** (each adds at most ±1 to up/down):
- **OBV**: if `obvSlope > 0` → +1 UP, if `< 0` → +1 DOWN, near-zero → neutral. Threshold: `OBV_SLOPE_EPS` (default 0).
- **MFI**: < 20 → oversold (+1 UP), > 80 → overbought (+1 DOWN).
- **VWAP**: `close > vwap * (1 + VWAP_BAND)` → +1 UP, `< vwap * (1 - VWAP_BAND)` → +1 DOWN. `VWAP_BAND` default 0.001 (10 bps).
- **CMF**: > +0.05 → +1 UP, < -0.05 → +1 DOWN.

**Score scale change**
- Max score is now 7 (RSI, MACD, Stoch, OBV, MFI, VWAP, CMF). Net agreement formula unchanged: `max(up,down) - min(up,down)`.
- **Increase `FUTURES_MIN_CONFLUENCE_SCORE` default from 2 → 3** (in `.env`, not necessarily in config defaults — leave Zod at 2 for back-compat). Document in `.env.example` that the recommended value scales with the number of voters.
- All existing call sites of `scoreConfluence` are unchanged (return type still `{ direction, score, signals }`).

**Tests**
- Add to `src/arb/__tests__/confluenceScorer.test.ts`: cases with new voters firing all-up, all-down, mixed.
- Add `src/arb/__tests__/indicators.volume.test.ts` for OBV/MFI/VWAP/CMF/SMA against hand-computed expected values.

### 2.4 New env vars (Phase 2)

```
VOLUME_SPIKE_GATE_ENABLED=true
VOLUME_SPIKE_PERIOD=20
VOLUME_SPIKE_MULT=2.0
OBV_SLOPE_LOOKBACK=10
OBV_SLOPE_EPS=0
MFI_PERIOD=14
MFI_OVERSOLD=20
MFI_OVERBOUGHT=80
VWAP_LOOKBACK_MIN=60
VWAP_BAND=0.001
CMF_PERIOD=20
CMF_THRESHOLD=0.05
```

---

## Phase 3 — Regime filters

### 3.1 New regime indicators in `src/arb/indicators.ts`

- `computeADX(candles, period=14): { adx, plusDI, minusDI } | null` — Wilder's ADX.
- `computeChoppinessIndex(candles, period=14): number | null` — log10(ATR sum / range) × scaling.
- `computeBollingerBands(candles, period=20, sigma=2): { upper, mid, lower, bandwidth, percentB } | null` — bandwidth = `(upper-lower)/mid`.

### 3.2 Regime gates in confluence path

**Files**
- `src/arb/confluenceScorer.ts`: extend `scoreConfluence()` to also compute ADX, Choppiness, BB bandwidth from the same candle set, and return them in an extended `regime` field on `ConfluenceScore`.
- `src/spot/index.ts`, `src/mapping/index.ts`: read `result.regime` and apply hard gates before checking score.
- `src/monitor/futuresMonitor.ts` TA re-eval: gates apply only at entry, NOT at exit (don't refuse to exit a losing position because the market just got choppy).

**Gate rules**
- **ADX gate**: skip if `adx < ADX_MIN` (default 20). Reason: `regime_no_trend`.
- **Choppiness gate**: skip if `choppiness > CHOPPINESS_MAX` (default 61.8). Reason: `regime_chop`.
- **BB regime classifier** (advisory, not a gate by default): bandwidth percentile over the last 24h → `calm | normal | explosive`. Optionally adapt `FUTURES_MIN_CONFLUENCE_SCORE` per regime via `FUTURES_MIN_CONFLUENCE_SCORE_CALM/NORMAL/EXPLOSIVE` env overrides. Default disabled (`BB_REGIME_ADAPT_ENABLED=false`) to keep the rollout incremental.

### 3.3 Extended `ConfluenceScore` shape

```ts
export interface ConfluenceScore {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  score: number;
  signals: { /* ... existing + obv, mfi, vwap, cmf */ };
  regime?: {
    adx: number | null;
    plusDI: number | null;
    minusDI: number | null;
    choppiness: number | null;
    bbBandwidth: number | null;
    bbRegime: 'calm' | 'normal' | 'explosive' | null;
  };
}
```

Backwards-compatible (regime is optional). All existing tests still pass.

### 3.4 Tests

- `src/arb/__tests__/indicators.regime.test.ts`: ADX (trending up, trending down, ranging), Choppiness (range vs trend), Bollinger (squeeze, expansion).
- Extend `confluenceScorer.test.ts`: assert regime fields are populated; assert scores still work without regime.
- Extend `src/spot/__tests__` or add a new `src/spot/__tests__/index.regimeGate.test.ts` that asserts `runSpotMonitor()` skips with `regime_no_trend` / `regime_chop`.

### 3.5 New env vars (Phase 3)

```
ADX_PERIOD=14
ADX_MIN=20
ADX_GATE_ENABLED=true

CHOPPINESS_PERIOD=14
CHOPPINESS_MAX=61.8
CHOPPINESS_GATE_ENABLED=true

BB_PERIOD=20
BB_SIGMA=2
BB_REGIME_ADAPT_ENABLED=false
FUTURES_MIN_CONFLUENCE_SCORE_CALM=3
FUTURES_MIN_CONFLUENCE_SCORE_NORMAL=3
FUTURES_MIN_CONFLUENCE_SCORE_EXPLOSIVE=4
```

---

## Critical files to be modified

| File | Phase | What changes |
|---|---|---|
| `src/spot/feeds/binanceFeed.ts` | 1 | Switch `@ticker` → `@kline_1m`+`@kline_5m`; new Redis kline writes; keep `spot:last/prices` writes |
| `src/arb/candleAggregator.ts` | 1 | Rewrite `buildCandles` as kline reader with tick fallback; extend `OHLCVCandle` |
| `src/arb/indicators.ts` | 2,3 | Add OBV, MFI, VWAP, CMF, VolumeSMA, ADX, ChoppinessIndex, BollingerBands |
| `src/arb/confluenceScorer.ts` | 2,3 | Extra voters; regime block; widened return type |
| `src/spot/thresholdDetector.ts` | 1 | Z-score trigger mode |
| `src/spot/index.ts` | 1,2,3 | Pass candles to executor for ATR; volume-spike gate; regime gates; consume new score |
| `src/mapping/index.ts` | 1,2,3 | Same volume-spike + regime gates on news→futures path |
| `src/execution/executor.ts` | 1 | Persist `entryAtr/entryAtrPct` to ledger at futures entry |
| `src/monitor/futuresMonitor.ts` | 1 | ATR-based SL/TP/trailing with fallback to fixed % for legacy positions |
| `src/shared/config.ts` | 1,2,3 | All new env vars (Zod) |
| `.env.example` | 1,2,3 | Document defaults |
| Tests under `src/arb/__tests__/`, `src/spot/__tests__/`, `src/monitor/__tests__/`, `src/spot/feeds/__tests__/` | 1,2,3 | Per-section additions above |

## Reused existing utilities (do not duplicate)

- `computeATRFromCandles` / `computeATR` — `src/arb/indicators.ts:65,95` (already exists; will gain real volume input via Phase 1)
- `computeEMA` — `src/arb/indicators.ts:24` (used by MACD; reusable for BB midline if we want EMA-based bands)
- `scoreFromValues` voting structure — `src/arb/confluenceScorer.ts:56`
- Redis singleton + lock helpers — `src/shared/redis.ts`
- Config Zod schema — `src/shared/config.ts`
- Stake floor / executor pipeline — `src/execution/executor.ts`
- HL_SYMBOL_MAP — already in `src/spot/index.ts:91`

## Rollout strategy (per phase, in order)

Each phase ships independently. After each: lint + typecheck + vitest + commit + push + `docker compose up -d --build` + post-deploy log check.

1. **Phase 1.1** (kline feed) — ship with kline writes active but `buildCandles` still falling back to ticks if klines empty. Verify `spot:klines:btcusdt:1m` populates in Redis. Then flip the reader to prefer klines. Watch for `kline_fallback` warnings.
2. **Phase 1.2** (ATR SL/TP) — ship with `FUTURES_ATR_SLTP_ENABLED=false`. Log `entryAtrPct` and would-be SL/TP for every new futures entry for ~24h. If values look sane, set `FUTURES_ATR_SLTP_ENABLED=true` in `.env`.
3. **Phase 1.3** (z-score trigger) — ship with `SPOT_TRIGGER_MODE=pct`. Add a parallel "would-have-triggered" log line for z-score. Compare for ~24h. Flip to `both`, then `zscore`.
4. **Phase 2.1–2.3** — ship with `VOLUME_SPIKE_GATE_ENABLED=false` and the new voters active but `FUTURES_MIN_CONFLUENCE_SCORE` unchanged. Observe new max score distribution in logs. Then raise `FUTURES_MIN_CONFLUENCE_SCORE=3`, then enable volume-spike gate.
5. **Phase 3** — ship gates disabled (`ADX_GATE_ENABLED=false`, `CHOPPINESS_GATE_ENABLED=false`); log values for ~24h; enable one at a time.

This staged enable-via-env approach matches our existing `CONFLUENCE_GATE_ENABLED` / `FUTURES_EXIT_ON_SIGNAL_FADE` pattern and lets us roll back any single change without redeploying code.

## Verification

After each phase:

1. `npx eslint src/` — zero errors
2. `npx tsc --noEmit` — clean
3. `npx vitest run` — all green (new tests included)
4. `docker compose up -d --build`
5. `redis-cli KEYS '*lock*'` — only active worker locks
6. `docker compose ps` — all Up
7. **Phase-specific live checks**:
   - Phase 1.1: `redis-cli ZCARD spot:klines:btcusdt:1m` should grow each minute; `docker logs polymarket-geopolitical-agent-pga-spot-feed-1 --since 2m | grep -i kline`
   - Phase 1.2: `tail -f ~/logs/pga/monitor.log | grep -E 'entryAtrPct|atr_sl|atr_tp'`
   - Phase 1.3: `tail -f ~/logs/pga/spot.log | grep -E 'zscore|trigger_mode'`
   - Phase 2: `tail -f ~/logs/pga/{spot,trade}.log | grep -E 'volume_spike|obv|mfi|vwap|cmf|confluence_(block|pass)'`
   - Phase 3: `... | grep -E 'regime_no_trend|regime_chop|adx|choppiness|bb_regime'`
8. Manual sanity: pick a current futures position and confirm via `redis-cli` that the ledger entry has `entryAtrPct`. Pick a recent skip from logs and confirm the reason matches the expected gate.
9. End-to-end: monitor for 24h after each enable-flip; abort and revert env flag if win-rate or stop-out frequency degrades materially.
