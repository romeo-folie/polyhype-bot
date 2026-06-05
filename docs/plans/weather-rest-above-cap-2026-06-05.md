# Weather rest-above-cap: price caps as clamps, not eligibility filters (2026-06-05)

## Problem

The weather entry-price caps (`WEATHER_MAX_ENTRY_PRICE=0.75`, `WEATHER_EARLY_ENTRY_MAX_PRICE=0.55`)
do double duty today:

1. **Legitimate**: bound the price we *pay* (maker fairValue clamps + defense-in-depth final-price
   guards in `computeOutcomeMakerPrice`).
2. **Illegitimate**: act as a *participation filter* — the pre-execution gate at `executor.ts:1939`
   compares the **market's scan-time price** (`signal.outcomePrice`) against the cap and hard-skips
   (`entry_price_above_cap`) before any maker logic runs. On ghost books that price is often a junk
   quote (0.99 rebate-ask). Because the bracket leg only emits when the primary commits
   (`orderCommitted`, weatherScanner.ts), the skip also suppresses the bracket.

Desired behaviour: any market with genuine model edge gets a **resting GTC bid at our own
clamp-bounded price**, regardless of where the market trades right now. If price never comes to us,
the order rests harmlessly; if it collapses to our bid, we catch the trade.

## Risk analysis (why this needs three safety legs)

- **Adverse selection on real books**: a bid resting 15+ points below market fills mostly when new
  forecast runs move *against* the thesis — we'd get filled exactly when the scan-time edge is
  stale. Mitigation: revalidation/cancel pass (leg 2).
- **Unbounded contingent exposure**: resting orders deduct nothing from bankroll
  (`bankroll.ts` reads live on-chain pUSD) and per-scan caps reset every 30 min, so out-of-range
  bids could accumulate across scans and over-subscribe the bankroll — with *correlated* fills
  (one weather regime shift collapses several nearby-city markets at once). Mitigation: aggregate
  notional cap on the out-of-range pool (leg 1).
- **Per-scan slot crowd-out**: each posted out-of-range bid consumes one of
  `WEATHER_MAX_POSITIONS_PER_SCAN=3` slots + `WEATHER_MAX_SCAN_EXPOSURE_USD` budget
  (`governorStamped && !error`). On burst scans (new day's markets listed) lottery-ticket posts
  could starve in-range res-day entries. Mitigation: in-range-first ordering (leg 3). Bursty, not
  chronic — pending keys block re-emission after the first post.

## Changes

### 1. Executor: Gate-1 bypass + clamp-to-cap (`src/execution/executor.ts`)

- **Gate 1 (`:1939`)**: when `WEATHER_REST_ABOVE_CAP_ENABLED && source==='weather' &&
  !sizeUpSanctioned`, do NOT skip on `outcomePrice > effectivePriceCap`. Tag the signal
  `_restAboveCap: true` and log `[weather-rest-above-cap]`. Size-ups keep the legacy skip
  (top-ups must not chase above cap). Non-weather sources unchanged.
- **Maker final-price guards (`:851–884`)**: when the knob is on, weather prices above the cap are
  **clamped** (`roundDownToTick(min(price, cap))`) instead of rejected with
  `maker_price_above_cap`. If the clamped price falls below one tick, keep the reject. Knob off →
  exact legacy behaviour. Legacy gates (signal-drift / flat empty-book cap, active only when
  conviction discount is off) keep rejecting.
- Empty-book path needs no pricing change: fairValue is already conviction-discounted and
  ceiling'd at the caps — only Gate 1 was blocking it.
- Taker safety: weather patient real-book is post-and-leave (no taker fallback) and the taker
  fallback price gate re-blocks `outcomePrice > cap` independently, so out-of-range entries can
  never taker-fill.

### 2. Out-of-range resting-notional cap

- `PendingMakerOrder` gains `restAboveCap?: boolean` and `isBracketOpposite?: boolean`
  (written at post time).
- New helper `listPendingOrders(redis)` (SCAN `maker:open:*`) +
  `sumRestAboveCapNotional(redis)` in `pendingMakerOrders.ts`.
- Before posting a NEW weather maker order with `_restAboveCap`, if
  `sum(restAboveCap pool) + price*size > WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD` → return
  `maker_resting_notional_cap` → skip `resting_notional_cap` (no taker fallback).
- Cap bounds **only the out-of-range pool** — counting all weather resting orders would let
  lottery-ticket bids block in-range entries at the capital level (capital-level crowd-out).
- New skip_reason ⇒ enum additions in `src/db/schemas/{signal_decisions,execution_events}.ts` +
  SQL migration `ALTER TYPE skip_reason_t ADD VALUE IF NOT EXISTS`.

### 3. Scanner: revalidation/cancel pass (`src/weather/weatherScanner.ts`)

`revalidateRestingWeatherOrders(redis, opportunities)` — runs each scan (host cron, no rebuild),
gated on `WEATHER_RESTING_REVALIDATION_ENABLED`:

- For each weather `maker:open:*` **primary** (bracket legs excluded — they are *meant* to rest
  value-negative as the pairing leg; legacy blobs without the flag are identified by
  `edgeMagnitude === 0` and treated as brackets, i.e. never cancelled):
  - Look up the market in the current scan's opportunities. Absent (out of universe) → leave
    alone. This also makes the pass fail safe: a Gamma outage yields zero opportunities and
    therefore zero cancels.
  - `sideFV = direction==='YES' ? modelProbability : 1 - modelProbability`.
  - If `sideFV < posted price` → the resting bid is now value-negative at our own price → cancel.
    Natural hysteresis: posts go out at FV×(1−discount) or below the market, so cancel requires a
    ≳20% FV decline, no flapping.
- Partial-fill-safe cancel: read `size_matched`, cancel, re-read; if anything filled, **keep the
  pending key** so the reconciler's orphan-import links the on-chain fill to its metadata
  (existing machinery); only delete the key on a clean zero-fill cancel.

This closes the standing gap that forecast invalidation (PRs #425/#443) only covers *held
positions* — unfilled resting orders previously survived a thesis break untouched until TTL.

### 4. Scanner: in-range-first ordering

Stable partition of `tradable` before the execution loop: in-range (`outcomePrice ≤` mirrored
effective cap, or size-up scan rows) first, out-of-range last; edge-desc order preserved within
each group. Unconditional (when the knob is off, out-of-range rows skip at Gate 1 and consume no
caps, so the partition is harmless).

### 5. Cohort tag

- `[weather-rest-above-cap]` log line at bypass time (marketId, city via sourcedFrom, outcomePrice,
  cap, posted price).
- `restAboveCap: true` persisted on the pending blob.
- Durable DB slice needs no schema change: `signal_decisions` rows carry `outcome_price`; the
  cohort = weather rows with `outcome_price > effective cap`.

## New knobs (config.ts defaults / .env live values)

| Knob | Default | .env (post-merge) |
|---|---|---|
| `WEATHER_REST_ABOVE_CAP_ENABLED` | `false` | `true` |
| `WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD` | `0` (no posts allowed when feature on but cap unset → fail closed) | `100` |
| `WEATHER_RESTING_REVALIDATION_ENABLED` | `false` | `true` |
| `WEATHER_MAX_POSITIONS_PER_SCAN` | `3` (unchanged) | `5` |

## Explicitly NOT changing

- `ARB_GLOBAL_MAX_TRADES_PER_MIN` — pacing knob, ~0.2% utilised, protects API rate limits.
- `WEATHER_MAX_PER_CITY` — orthogonal concentration cap.
- Size-up gates — out-of-range size-ups still skip (`entry_price_above_cap`).
- Bracket emission logic — restored automatically once primaries commit.

## Deploy

- `src/execution/*` + `src/mapping/index.ts` changed → rebuild `pga-arb`, `pga-monitor`,
  `pga-futures`, `pga-copytrade` (off-scope, stopped — image refresh only), `pga-cron`.
- New skip_reason → `docker compose up -d --build --force-recreate pga-db-migrate pga-db-writer`.
- `weatherScanner.ts` runs on host cron — picks up on the next `*/30` run after merge + `.env` flip.

## Watch after go-live

- First out-of-range posts: `[weather-rest-above-cap]` lines; posted price ≤ cap.
- Revalidation cancels: `[weather-revalidate]` lines; confirm no bracket legs cancelled.
- `resting_notional_cap` skips once the pool reaches $100.
- Fill quality of the cohort after ~1–2 weeks: slice `signal_decisions` on `outcome_price > cap`,
  join outcomes — adverse-selection check (do these fills lose more than in-range fills?).
