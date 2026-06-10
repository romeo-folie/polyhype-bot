# Weather Probabilistic Oracle — Intraday Conditional Pricing

**Date:** 2026-06-10
**Status:** Proposed — for implementation by a dedicated agent
**Revision:** v2 (2026-06-10) — conditioned-ensemble estimator made primary, climatology demoted to
fallback/clamp; fixed-threshold exit replaced with a bid-vs-fair-value rule; native-unit and
observation-staleness requirements added; measurable outcomes and test plan added; integrated with
the PR #470 interim heuristics (Tier 2 res-day exits, bid-velocity exits, any-day
`oracle_impossible`, lowered thresholds) — precedence rules, audit gates, and post-#470 baselines.
Phase D added: the end state — signal-priced entries replace static price caps for covered
res-day markets once exit reliability is proven.

---

## Problem

The current live-observation oracle (Phase 5 of the drift strategy) fires only at **mathematical
certainty**: `observedMax > bracket_high + 0.5`. This means the scanner can observe a temperature
sitting at or near the bracket boundary for hours without triggering any action.

The deeper issue is that our forecast model produces a **static daily-max distribution** (ensemble
mean + stddev → Gaussian) and never conditions it intraday on observed temperatures. The market does
the opposite: as soon as it sees a Shenzhen reading of 29°C at 14:00 local time, it implicitly runs a
conditional probability model —

> *Given that the running maximum is already 29°C at 2pm, what is P(final daily maximum exceeds
> 29.5°C)?*

— and prices accordingly. This is why positions like Shenzhen June 2026 (`NO`, bracket `29°C`)
collapsed from 0.40 to 0.10 across six consecutive scans while our model remained near 0.99 and the
certainty oracle returned `null`. The market had real-time thermometer access; we were waiting for a
certainty gate that would never fire. Live confirmation on 2026-06-10: position 4833 (Shenzhen 29°C
NO) sat in `market_against` tier 2 with model heldProb 0.747 against a market bid of 0.10.

Between "no signal" and "certainty" there is currently nothing. This plan fills that gap.

---

## The Fix: `conditionalHeldProbability`

A function that returns the probability our held side wins **given the intraday running max**:

```typescript
conditionalHeldProbability(input: {
  city: string;
  direction: 'YES' | 'NO';
  bracket: { low: number | null; high: number | null }; // native unit (°C or °F)
  observedMax: number;        // running max so far today, native unit
  observedAtLocalHour: number; // local hour of the OBSERVATION timestamp (not wall clock)
  remainingHourlyMembers: number[][] | null; // per-member hourly temps for the rest of the day
  climoTable: ClimoExceedanceTable | null;   // empirical fallback
}): { heldProb: number; estimator: 'ensemble' | 'climo' | 'degenerate'; members: number } | null
```

Internally it estimates the distribution of the **final daily max** = `max(observedMax, remaining
hours)` and integrates it over the bracket's rounding window, using the exact same boundary
semantics as `classifyOracleState` (`[low − 0.5, high + 0.5)` in the city's native unit — for °F
cities with 2-degree brackets like `90–91°F`, the upper boundary is `91.5`).

It must handle both bracket cases for a held YES, not just one-sided exceedance:

- `observedMax` already ≥ `low − 0.5` (in or above bracket): `P(win) = P(final < high + 0.5)`.
- `observedMax` still < `low − 0.5` (below bracket): `P(win) = P(final ≥ low − 0.5) − P(final ≥ high + 0.5)`.

Tails and NO positions compose from the same final-max distribution. When `observedMax` already
crosses an irreversible boundary, the function degenerates to 0/1 and **must agree with
`classifyOracleState`** (the existing binary oracle remains as the fast path).

### Estimator 1 (primary): conditioned ensemble

For each ensemble member, take its **hourly trajectory for the remaining hours of the local day**;
that member's final max = `max(observedMax, member's remaining hourly temps)`. `P(final > t)` =
fraction of members exceeding `t` (after spread inflation, below).

Why primary:

- **Synoptic-aware.** The days that hurt us are the atypical ones — a front passing at 14:00, rain
  onset, late marine-layer burnoff. Climatology says "+0.8°C more is typical"; today's NWP hourly
  knows whether *today* has anything left. The Shenzhen/Istanbul failures were exactly
  atypical-day failures.
- **No new data dependency.** It is one parameter change (`hourly=temperature_2m`) on the
  ensemble API call the scanner already makes every cycle. No precompute pipeline, no static asset,
  no staleness management.
- **Distribution for free.** Member samples give the full final-max distribution, so bracket
  windows, tails, and flip fair values all come from one estimator.

Implementation notes:

- Fetch hourly member trajectories only when needed: resolution-day (or `daysOut ≤ 1`) positions
  with a live observation available. Limit the request window to the target local day to keep
  payloads small.
- Apply the existing city bias correction (same delta used on the daily max) to member
  trajectories. Whether intraday bias differs from daily-max bias is a Phase A measurement.
- Apply a **spread inflation factor** (`WEATHER_COND_ORACLE_SPREAD_INFLATION`, default 1.0,
  calibrated in Phase A): intraday ensemble spread is typically underdispersed, and member hourly
  errors are correlated with the running max.

### Estimator 2 (fallback/clamp): empirical climatological exceedance

A precomputed per-city, per-month table of **empirical** conditional exceedance:

```
P(final daily max > observedMax + δ | local hour H, month M, city)
```

counted directly from 10–20 years of history. **Not a fitted log-normal** — after ~15:00 local the
remaining-rise distribution has a large point mass at zero (the max is already set), and any
parametric right-tail fit systematically overestimates remaining rise exactly when the signal
matters most. Empirical counting handles the point mass natively.

Role:

- **Fallback** when the ensemble hourly fetch fails (Open-Meteo outages are a known failure mode —
  see the 2026-06-04 incident) or returns < `WEATHER_COND_ORACLE_MIN_MEMBERS` members.
- **Sanity clamp** on the ensemble estimate: if the two estimators disagree by more than a
  configured gap, log a shadow disagreement row and use the more conservative value for any live
  action (conservative = the value that implies *less* confidence in our held side).

Build requirements:

- Built from the **settlement station's** observation history wherever possible (WU/ISD station
  history, HKO climate records — the same stations the reconciler settles from), not ERA5 or model
  grid. Grid-vs-station bias of even 0.5° is fatal at rounding-boundary precision. Open-Meteo
  Historical (ERA5) is acceptable only for cities where station history is unavailable, and those
  cities get `proxy` confidence.
- Native units per city. Table shape: `city → month → localHour → sorted empirical quantiles of
  (finalMax − runningMaxAtHour)`, stored as JSON under `src/weather/data/`. A one-time generation
  script lives in `scripts/` and records its source + date range in the JSON header.

### Observation-staleness handling

- Use the **local hour of `observedAt`**, not wall clock. WU readings lag up to ~1h; computing
  "fraction of warming done by 16:00" from a 14:00 reading overstates how done the day is.
- If observation age > `WEATHER_COND_ORACLE_MAX_OBS_AGE_MIN` (default 90), do not produce a
  conditional probability for live actions — shadow-log with `stale_obs` and fall back to
  forecast-only drift. (The existing `WEATHER_DRIFT_LIVE_OBS_MAX_AGE_MIN=30` cache TTL already
  bounds typical staleness; this knob bounds action eligibility.)

---

## Decision Rules

### Exit rule (Phase B): bid vs fair value — no fixed probability threshold

The original proposal exited when `conditionalP < 0.40`. That repeats the calibration mistake we
have already paid for twice (entry-model overconfidence → PR #445 Kelly shrink; modal exits →
PR #444 market floor). Instead:

> **Sell the held side when `bestBid > conditionalHeldProb + WEATHER_COND_ORACLE_EXIT_COST_BUFFER`.**

If `conditionalHeldProb` is calibrated, selling above fair value is +EV by definition — no magic
threshold to tune. The buffer (default 0.05) covers fees, slippage, and estimator noise. The rule is
two-sided for free:

- `bid > P + buffer` → exit (the market is paying more than the position is worth).
- `bid < P` → hold; large gap = the `oracle_contradicts_market` case → do **not** panic-exit on
  `market_against` tiers alone (hold-confidence guard, see below).

Execution rides the existing `tryWeatherExit` path unchanged: depth-ratio gate, min-bid floor,
cooldown keys, `weather:forecast_exited:` idempotency, notify dedup. The conditional oracle adds a
new drift state (`oracle_likely_against`) into the existing state machine — **not** a parallel exit
path.

Interaction with existing exits (including the PR #470 heuristics — see the dedicated section
below):

- `oracle_impossible` / `oracle_confirmed` (binary certainty) keep priority — the conditional state
  only applies while the binary oracle returns `null`. The conditional oracle can **never** veto a
  binary oracle state.
- `market_against` Tier 1 (market drop + model drop) exits remain. Whether a fresh conditional
  estimate may veto Tier 1 is an open question (the model-drop confirmation makes Tier 1 stronger
  evidence than market-only signals); start with no veto.
- `market_against` Tier 2 res-day exits (PR #470) stand as authoritative: on ≤ 0.49 cap-clamped
  entries an entry-relative 25% drop + 0.55 model-market gap is, per operator experience, a dead
  position (Phase A gate A.5 validates this empirically before any revisit).
- **Bid-velocity exits** (PR #470) are the one market-only signal the calibrated oracle
  arbitrates: peak-relative collapses include genuine whipsaws on appreciated winners. A fresh
  settlement-aligned conditionalP confirms the exit (now with a fair-value basis) or vetoes it via
  the hold guard (below). Without a fresh estimate (stale obs, no live source, fetch failure), the
  #470 behavior stands unchanged.

### Hold-confidence guard (Phase B)

When `conditionalHeldProb − bestBid ≥ WEATHER_COND_ORACLE_HOLD_GUARD_GAP` (default 0.30) with a
fresh, settlement-aligned observation, suppress **market-only** drift exit actions for that scan
and emit a `weather_cond_oracle_hold` shadow row + notification. This is the symmetric protection:
prevents dumping winners into res-day whipsaws (the documented Amsterdam pattern) while still
alerting.

Veto scope (explicit, because PR #470 made market signals authoritative on res-day). The scope is
shaped by an entry-structure fact: weather entries are clamped at ≤ 0.49 (rest-above-cap), and a
maker fill at the cap is an adverse-selection fill by construction — the market has already moved
down through our price to fill us. The Tier thresholds measure **entry-relative** drop
(`(entry − bid) / entry`), so on a ≤ 0.49 entry a 20–25% drop (bid ≲ 0.39) is continuation of the
move that filled us, not a dip — operator experience says these are dead. The whipsaw-on-winners
case is structurally invisible to entry-relative drop (0.49 → 0.95 → 0.40 is only an 18%
entry-relative drop despite −58% from peak) and lives entirely in the **prev-scan-relative
bid-velocity rule**. The guard therefore targets velocity, not the Tiers:

| Exit trigger | Guard may veto? | Rationale |
|---|---|---|
| Binary oracle (`oracle_impossible`) | **Never** | Settlement-certain |
| `market_against` Tier 1 | No | Model-drop confirmation = stronger evidence |
| `market_against` Tier 2 res-day (#470) | **No** (default; Phase A may revisit) | Entry-relative 25% drop + 0.55 gap on cap-clamped entries ≈ dead; veto only if Phase A recovery data contradicts this |
| Bid-velocity exit (#470) | **Yes** | Peak-relative price action; exactly the whipsaw shape (0.95→0.55 = 42% velocity trigger on a possible winner) |
| Forecast-state exits (`thesis_weakened`/`modal_against`) | Yes | Static model is the weaker source on res-day with fresh obs |

A vetoed exit is not silent: the notification and shadow row always fire, so vetoes are auditable
from day one.

### Resting-order revalidation (Phase B) — closing the adverse-selection gap at entry

The exit rule protects positions we already hold. But the same intraday blindness poisons us **at
fill time**: weather entries rest at the ≤ 0.49 cap while the market trades above; the bid only
fills when the market crashes through it. The fill-priority shadow analysis (PR #441) documented
this — resting orders "rest far below until the longshot collapses." The current defense,
`revalidateRestingWeatherOrders`, cancels on **model**-derived fair value — and the model is static
intraday. So on resolution day the sequence is: informed flow sees the thermometer → market
reprices → model still says 0.99 → revalidation does not cancel → our resting bid is picked off at
the moment the market learns we're wrong. PR #465 (makers held resting through expiry until
post-resolution sweep) extends the exposure window across the entire resolution day.

Fix: apply the same fair-value rule to resting weather makers that have a fresh, settlement-aligned
conditional estimate:

> **Cancel the resting order when `postedPrice > conditionalSideProb + WEATHER_COND_ORACLE_EXIT_COST_BUFFER`** —
> i.e. when filling at our posted price would be a negative-EV entry given what the thermometer
> already shows.

Constraints:

- This becomes a **fourth cancel rule** alongside FV-rule / partial-fill / post-resolution sweep,
  riding the existing revalidation pass (same pattern as the PR #461 expiry sweep). It must NOT
  create a second cancel path.
- Cancelling forfeits CLOB queue priority (the entire point of PR #465), so the bar is high: fresh
  + settlement-aligned obs only, res-day only, and the conditional estimate must fail the posted
  price by the full buffer. No cancellation on stale obs, proxy confidence, or model-only drift —
  those keep today's behavior.
- Knob: `WEATHER_COND_ORACLE_RESTING_CANCEL_ENABLED=false` (Phase B, enabled separately from the
  exit rule so each can be evaluated on its own).

This is the only intervention in the plan that attacks the *cause* of the adverse-selection
pattern (being filled by the crash) rather than its consequence (exiting after).

### Flip fair value (Phase C)

`tryWeatherFlip` currently uses `1.0` for `confirmed_flip` and `1 − currentHeldProb` (the static
model) otherwise. Replace the non-confirmed fair value with `1 − conditionalHeldProb` when a fresh
conditional estimate exists. This lets `market_oracle_flip` candidates price correctly *before*
binary certainty. Flip gating, caps, and `confirmed_only` semantics are unchanged.

### Nowcast entry (Phase C, dark first)

The mirror image of the Shenzhen loss: at 15:30 local, `observedMax` sits inside bracket X with
`conditionalHeldProb = 0.92` while the market prices YES at 0.70 → 22% edge. Today
`weatherOracleScanner` only buys winners the **next day** after ground truth; the conditional oracle
covers the whole intraday window. Ship as shadow rows (`weather_nowcast_entry`, `wouldTrade` flag)
gated behind `WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED=false`; flip on only after the Phase C
review criteria below are met. Entries would route through the standard executor (idempotency,
stake floor, governor) with `_isResolutionDay: true`.

---

## Relationship to PR #470 Interim Heuristics

PR #470 (`feat/weather-drift-exit-recs-1-2-4-5`) shipped four market-authoritative exit behaviors
as the immediate stop-loss response to the Shenzhen/Paris/Istanbul/Tel Aviv pattern:

1. Tier 2 `market_against` exits on resolution day (`WEATHER_DRIFT_TIER2_EXIT_ON_RES_DAY`).
2. Bid-velocity exits — held-side bid drops ≥ 40% in one scan cycle on res-day
   (`WEATHER_DRIFT_BID_VELOCITY_EXIT_ENABLED`, prev bid in `weather:drift_prev_bid:<posId>`).
3. `oracle_impossible` exits on any day, not just res-day.
4. Market-drop thresholds lowered: `DROP_EXIT` 0.50→0.20, `DROP_NOTIFY` 0.65→0.25.

These are the right interim stance: with no intraday repricing ability, the market *is* the best
available oracle. But (1), (2), and (4) are deliberately one-sided — they trust every adverse price
move, including whipsaws on eventual winners. The conditional oracle is the principled replacement
for that trust, and this plan treats #470 as follows:

- **Arbiter where whipsaws live, deference where they don't.** Entry-relative drop thresholds
  (items 1 and 4) are authoritative on cap-clamped ≤ 0.49 entries — a 20–25% entry-relative drop
  is continuation of the adverse move that filled us, and operator experience says it's dead
  (validated empirically by Phase A gate A.5). The whipsaw-on-winners risk is structurally
  invisible to entry-relative measurement (0.49 → 0.95 → 0.40 is only −18% from entry despite
  −58% from peak) and concentrates in item (2), the peak-relative bid-velocity rule — that is the
  one signal a fresh settlement-aligned conditionalP arbitrates (confirm or hold-guard veto). When
  no fresh estimate exists, all #470 behavior stands. Item (3) is permanent and untouched — it is
  the binary oracle, already settlement-certain.
- **Permanent backstop for uncovered cities.** Cities with `confidence: 'none'` (no viable live
  obs source) can never get a conditional estimate. The #470 heuristics remain their only intraday
  defense and must not be retired globally.
- **Retuning path, not removal.** If Phase B shows the oracle confirms/vetoes reliably, the #470
  knobs can be re-tightened for covered cities (e.g. velocity threshold back up) to reduce
  whipsaw selling — driven by the Phase A audit data below, never by assumption.
- **Audit from day one.** Phase A shadow rows record, for every live exit fired by a #470
  heuristic, what conditionalP would have said (`wouldConfirm` / `wouldVeto` + the gap). This
  quantifies both the oracle's agreement rate and the realized cost of heuristic whipsaw sales
  (exits where the position went on to win).

---

## Data Sources

| Source | Role | Notes |
|--------|------|-------|
| **Open-Meteo Ensemble API** (`hourly=temperature_2m`) | Primary estimator input | Same API/coords the scanner already calls; add hourly fields for res-day fetches only |
| **WU / HKO / METAR live obs** | `observedMax`, `observedAt` | Already implemented (`liveObservation.ts`); confidence tags already exist |
| **Settlement-station history** (WU/ISD, HKO climate) | Climatology table build | Same stations the reconciler settles from |
| **Open-Meteo Historical (ERA5)** | Climatology build fallback only | Tag affected cities `proxy`; never for live-action cities if station history exists |

---

## Integration Points

| File | Change |
|------|--------|
| `src/weather/openMeteoClient.ts` | Optional hourly-member fetch for the target local day (`fetchEnsembleHourly`), reusing retry/cache conventions |
| `src/weather/conditionalOracle.ts` | New — `conditionalHeldProbability()`, both estimators, clamp logic, staleness gate |
| `src/weather/data/climoExceedance.json` | New — empirical table asset (generated, with provenance header) |
| `scripts/build-climo-exceedance.ts` | New — one-time/refreshable table builder from station history |
| `src/weather/weatherDriftStrategy.ts` | Compute conditionalP when `observedMax` available; new `oracle_likely_against` state + hold guard; shadow fields on `weather_drift_decision` |
| `src/weather/weatherScanner.ts` (`revalidateRestingWeatherOrders`) | Phase B: fourth cancel rule — cancel resting maker when fresh conditionalSideProb fails the posted price (res-day, settlement-aligned obs only) |
| `src/weather/weatherFlip.ts` | Phase C: conditional fair value for non-confirmed candidates |
| `src/shared/config.ts` + `.env.example` | New knobs (below) |

New knobs (all dark by default):

```env
WEATHER_COND_ORACLE_ENABLED=false               # Phase A: compute + shadow-log only
WEATHER_COND_ORACLE_SOFT_EXIT_ENABLED=false     # Phase B: bid-vs-fair-value exit rule
WEATHER_COND_ORACLE_RESTING_CANCEL_ENABLED=false # Phase B: cancel picked-off-pending resting makers
WEATHER_COND_ORACLE_EXIT_COST_BUFFER=0.05
WEATHER_COND_ORACLE_HOLD_GUARD_ENABLED=false    # Phase B: suppress exits when bid << P
WEATHER_COND_ORACLE_HOLD_GUARD_GAP=0.30
WEATHER_COND_ORACLE_MAX_OBS_AGE_MIN=90
WEATHER_COND_ORACLE_SPREAD_INFLATION=1.0
WEATHER_COND_ORACLE_MIN_MEMBERS=10
WEATHER_COND_ORACLE_CLIMO_FALLBACK_ENABLED=true
WEATHER_COND_ORACLE_ESTIMATOR_MAX_GAP=0.25      # ensemble-vs-climo disagreement clamp trigger
WEATHER_COND_ORACLE_FLIP_FAIR_VALUE_ENABLED=false   # Phase C
WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED=false     # Phase C, shadow rows regardless
```

---

## Phasing, Measurable Outcomes, and Flip Criteria

### Phase A — shadow + calibration (1–2 weeks of data minimum)

Compute `conditionalHeldProb` (both estimators when available) on every drift evaluation that has a
live observation; write it into `weather_drift_decision` payloads and a dedicated
`weather_cond_oracle` shadow row. No actions. In parallel, run a **backtest** against history we
already hold (`weather_ground_truth`, WU/HKO station history, May–June drift shadow rows — including
the Shenzhen and Istanbul cases).

**Measurable outcomes / go-gates for Phase B:**

1. **Coverage:** ≥ 80% of res-day position-scans for WU/HKO cities produce a non-null, fresh
   conditionalP (measures hourly-fetch reliability + obs availability).
2. **Calibration:** reliability curve from backtest + shadow rows; Brier score of conditionalP at
   scan time **≤ market bid's Brier** at the same timestamps (the market is the benchmark to match,
   not the static model — beating the static model is assumed and not sufficient).
3. **Counterfactual PnL — three-policy comparison:** replay the May–June cohort under (a) the
   pre-#470 regime, (b) the #470 heuristics as merged, and (c) the bid-vs-fair-value rule with
   hold guard. Gate: policy (c) shows net-positive savings over (b): `(losses avoided on eventual
   losers) − (EV given up on exited eventual winners) > 0`, in dollars. Comparing against (b), not
   (a), is the point — #470 already captures most of the easy savings; the oracle must prove
   *incremental* value (fewer whipsaw sales, earlier correct exits).
4. **#470 heuristic audit:** for every live exit fired by Tier 2 res-day or bid-velocity while in
   shadow, record `wouldConfirm`/`wouldVeto`. Report the veto rate and the settled outcome of
   vetoed-but-exited positions. Gate (velocity vetoes, the guard's target): among velocity exits
   the oracle would have vetoed (with fresh, settlement-aligned obs), > 50% settled as winners.
   If the vetoes are mostly wrong, the hold guard gap/freshness gates need rework before Phase B.
5. **Dead-at-20% validation:** measure the recovery rate of positions after a ≥ 20% entry-relative
   drop (join drift `currentHeldBid` history to settlement outcomes). Expectation per operator
   experience on ≤ 0.49 cap-clamped entries: recovery is rare. If the data agrees (< 10% recover
   to win), Tier 2 stays un-vetoable and DROP_EXIT=0.20 is confirmed; if it disagrees materially,
   revisit the veto table before Phase B.
6. **Adverse-fill rate (quantifies "joining an already losing market"):** for every res-day maker
   fill with obs available at fill time, record whether `conditionalSideProb` was already below the
   posted price (`pickedOff=true`). This measures what fraction of our fills are informed flow
   picking off a stale bid. No gate — this is the baseline number the Phase B resting-cancel rule
   must improve, and it directly tests the operator hypothesis that cap-clamped fills are
   adversely selected.
7. **Estimator agreement:** ensemble-vs-climo gap distribution logged; clamp trigger rate < 10% of
   evaluations (higher means one estimator is broken — investigate before Phase B).
8. **Degenerate consistency:** zero cases where conditionalP and `classifyOracleState` disagree at
   irreversible boundaries (hard invariant, also unit-tested).

### Phase B — soft exit + hold guard (res-day only)

Enable `SOFT_EXIT` + `HOLD_GUARD` after Phase A gates pass. Review after 3–4 weeks or ≥ 15 live
conditional-exit decisions, whichever first.

**Measurable outcomes:**

1. **Stale-loss reduction:** average realized loss per losing res-day weather position drops ≥ 15%
   vs the **post-#470 baseline** (the weeks where the #470 heuristics ran live without the
   oracle). The original ≥ 30% target applied to the pre-#470 do-nothing regime; #470 will have
   captured much of that already, so the oracle's bar is incremental improvement on top — the
   dollar value now comes from both fewer stale losses *and* fewer whipsaw sales of winners.
2. **Exit quality:** of positions exited by the rule, the EV check holds ex post: average
   `(exitPrice − settlementValue)` per exit > 0 (we sold above what the position was worth).
   Tolerate individual winners sold; the average must be positive.
3. **Hold-guard value:** positions where the guard vetoed a bid-velocity or forecast-state exit
   settle in our favor ≥ 60% of the time (else the guard is protecting losers and its gap knob
   needs raising). Track separately per vetoed trigger type.
4. **Picked-off fill reduction (resting-cancel rule):** the adverse-fill rate (Phase A metric A.6)
   drops by ≥ 50% for covered cities once `RESTING_CANCEL` is enabled, without the weather maker
   fill *count* collapsing (cancelled bids that would have been picked off are wins; cancelled
   bids that would have filled profitably are the cost — track both).
5. **No regression:** weather drawdown events > $15/position do not increase; drift-exit cooldown
   and depth gates show no new failure modes in logs; for `confidence: 'none'` cities (no
   conditional coverage) the #470 heuristics demonstrably still fire; queue priority is never
   forfeited on stale/proxy obs (audit cancel logs against obs confidence).

### Phase C — offense (flip fair value, then nowcast entries)

Flip fair value first (it reuses existing flip caps), nowcast entries after.

**Flip criteria / measurable outcomes:**

1. Flip fair-value change: only enabled if Phase B exit-quality metric (B.2) held for ≥ 15 exits.
2. Nowcast entries stay dark until shadow shows ≥ 30 `wouldTrade` signals with: median edge ≥ 8
   points vs market, and realized-if-filled EV positive over the cohort (using actual market asks
   at signal time, not mid).
3. Once live: nowcast entry win rate and ROI reported separately from morning-forecast entries —
   they are a different strategy and must not contaminate the entry-model calibration data.

### Phase D — end state: signal-priced entries replace static price caps

**The goal of this whole plan.** The current entry caps (`WEATHER_MAX_ENTRY_PRICE`, the 0.49
rest-above-cap clamp, `WEATHER_EARLY_ENTRY_MAX_PRICE`, the Kelly shrink) are defensive constants —
they exist because the static model cannot be trusted intraday, so exposure is capped at entry
time and the position rides mostly blind. They are also the direct cause of the adverse-selection
fill pattern (resting far below market means being filled by crashes). Once the conditional oracle
is calibrated and the exit/cancel rules are proven, the regime changes:

> **For covered res-day markets: enter at any price where `conditionalSideProb − ask ≥ minEdge`,
> size by Kelly on conditionalP, and let the lifecycle rules (soft exit, resting cancel, hold
> guard) manage capital — instead of capping entry price and hoping.**

Capital protection moves from entry-time constants to signal-triggered lifecycle management. The
0.49 problem dissolves: we stop being the stale bid below a moving market and become a priced
participant at fair value.

Hard preconditions (all must hold before any cap is lifted):

1. Phase B exit-quality metric (B.2) sustained across ≥ 30 exits, and resting-cancel gate (B.4)
   passed — the exits we will be trusting must already have a track record.
2. Phase C nowcast-entry cohort EV-positive (these *are* signal-priced entries, run small behind
   the caps first).
3. **Exit-liquidity gate, priced per entry:** an entry above the legacy cap is allowed only when
   the book shows depth to exit the full position within `WEATHER_DRIFT_EXIT_MAX_SLIPPAGE` of the
   current bid. The acceptable entry price scales with demonstrated exit reliability — downside
   per failed exit grows with entry price, so a thin book re-imposes a low cap naturally.
4. Per-city enablement, covered cities only, freshest-obs scans only. Pre-res-day entries
   (daysOut ≥ 1, no thermometer to condition on) keep the caps **permanently** — the static model
   only ties the market there, and caps remain the correct defense.

Scope of retirement (per-city, res-day):

| Constant | Phase D fate |
|---|---|
| `WEATHER_MAX_ENTRY_PRICE` / res-day 0.75 cap | Replaced by min-edge + exit-liquidity gate |
| Rest-above-cap 0.49 clamp | Replaced by posting at `conditionalP − minEdge` (a priced quote, not a stale floor) |
| `WEATHER_EARLY_ENTRY_MAX_PRICE` | Unchanged (pre-obs window) |
| `WEATHER_KELLY_SHRINK_WEIGHT` | Re-evaluated: shrink toward market is a patch for an uncalibrated model; a calibrated conditionalP should need less of it (data decides, gate on B.2-style ex-post EV) |
| Pre-res-day caps (daysOut ≥ 1) | **Permanent** |

**Measurable outcomes:**

1. ROI by entry-price bucket above the legacy cap (0.50–0.65, 0.65–0.80, 0.80+) — each bucket must
   be EV-positive on ≥ 20 settled entries before the next bucket opens (laddered rollout, not a
   cliff).
2. **Exit-trust metric:** when the signal flips on a Phase D position, the exit fills within
   slippage tolerance ≥ 90% of the time. This is the number that justifies the whole regime — if
   it degrades, caps come back automatically (per-city kill switch).
3. Adverse-fill rate (A.6) for Phase D quotes ≈ 0 — a quote at fair value minus edge should almost
   never be a picked-off stale bid.
4. Max drawdown per position does not exceed the cap-era distribution despite higher entry prices
   (the lifecycle rules, not the entry price, bound the loss).

**Tests:** entry gate refuses when obs stale/proxy/uncovered (falls back to legacy caps — the cap
code path is retained, not deleted); exit-liquidity gate blocks high entries on thin books; ladder
config only opens the next price bucket when the knob for it is explicitly set; per-city kill
switch restores caps end-to-end.

#### Phase D extension: bracket legs revived as signal-gated two-sided quoting

The weather bracket-maker strategy (PRs #437/#438) posted an opposite-side GTC leg alongside
empty-book primaries; whipsaw fills produced wins and lock-ins. It effectively died when its
trigger went extinct — MMs now seed weather books within hours of listing, so `wasEmptyBook`
almost never fires. The emptiness gate was always a proxy: with no fair value for the opposite
side, "nobody else is quoting" was the only safety condition available (and its failure mode was
Taipei — $10 on a 13% tail when the gate was misjudged).

The conditional oracle replaces the proxy with the real condition:

> **Post the opposite leg whenever it independently shows edge at its price:**
> `(1 − conditionalSideProb) − oppositeLegPrice ≥ minEdge` — regardless of book state.

Properties:

- **Taipei is structurally excluded:** a 13% tail shows `1 − P ≈ 0.13` and fails the edge gate at
  any meaningful posted price.
- **Locked boxes priced explicitly:** when both legs rest such that
  `primaryPrice + oppositePrice < 1 − minLockInEdge`, a double fill is profit regardless of
  outcome. Track box completion as its own metric rather than a lucky accident.
- **Same lifecycle rules apply to the leg:** the resting-cancel rule covers the bracket leg too —
  when intraday obs move the opposite side's fair value below its posted price, the leg is
  cancelled instead of being the next stale bid to get picked off.
- Pre-res-day bracket legs (no obs) stay behind the existing empty-book gate — the proxy remains
  correct where no signal exists.

**Measurable outcomes:** bracket-leg fill rate and per-leg EV vs conditional fair value at fill;
box-completion rate and locked PnL per box; zero legs posted where the edge gate fails
(Taipei-class incidents = 0, hard gate).

**Tests:** leg posted only when opposite-side edge gate passes (book state irrelevant on covered
res-day markets); leg NOT posted when `1 − conditionalP` fails the gate even on an empty book;
box-cost arithmetic includes fees; leg cancellation rides the resting-cancel rule; pre-res-day
legs keep the legacy empty-book gate.

---

## Metrics To Track (shadow row fields)

Every `weather_cond_oracle` row carries: positionId, city, targetDate, bracket, direction,
observedMax, observedAt + age, observedAtLocalHour, estimator used, members, conditionalHeldProb
(both estimators when available), staticModelHeldProb, bestBid/bidSource, decision
(none/would_exit/would_hold_guard), and settlement outcome joined later.

Dashboard slices:

```sql
-- Calibration: conditionalP vs settled outcome, bucketed
SELECT width_bucket((payload->>'conditionalHeldProb')::float, 0, 1, 10) AS bucket,
       count(*) AS n,
       avg((payload->>'settledWin')::int::float) AS realized
FROM shadow_observations
WHERE kind = 'weather_cond_oracle' AND payload ? 'settledWin'
GROUP BY 1 ORDER BY 1;

-- Counterfactual exits: would-exit rows and what the position settled at
SELECT observed_at, payload->>'city', payload->>'bracketLabel', payload->>'direction',
       payload->>'conditionalHeldProb', payload->>'bestBid', payload->>'settledWin'
FROM shadow_observations
WHERE kind = 'weather_cond_oracle' AND payload->>'decision' = 'would_exit'
ORDER BY observed_at DESC;

-- Estimator disagreement
SELECT date_trunc('day', observed_at), count(*) FILTER (WHERE (payload->>'estimatorGap')::float
  > 0.25) AS clamped, count(*) AS total
FROM shadow_observations WHERE kind = 'weather_cond_oracle' GROUP BY 1 ORDER BY 1 DESC;
```

---

## Tests

`src/weather/__tests__/conditionalOracle.test.ts` (new):

**Final-max distribution math**
- Member with no remaining hours → final max = observedMax exactly (late-day point mass).
- `P(final > t) = 1` for any `t < observedMax` (running max floors the distribution).
- Interior YES, observedMax below bracket: P(win) uses both boundaries
  (`P(≥ low−0.5) − P(≥ high+0.5)`).
- Interior YES, observedMax inside bracket: P(win) = `P(final < high+0.5)` only.
- NO positions = 1 − YES math for the same bracket; tails compose correctly (high-tail YES,
  low-tail YES).
- °F city with 2-degree bracket (`90–91°F`): boundaries at 89.5/91.5, native unit throughout.

**Consistency invariants**
- For observedMax past an irreversible boundary, output is exactly 0/1 and matches
  `classifyOracleState` for all four direction×bracket-type combinations (property-style test
  across a grid of observedMax values).
- Spread inflation widens the distribution (P moves toward 0.5, never past it).

**Estimator selection + degradation**
- Hourly members < MIN_MEMBERS → climo fallback used and tagged.
- Both unavailable → returns null (caller falls back to forecast-only drift).
- Ensemble-vs-climo gap > MAX_GAP → conservative value chosen for action, disagreement flagged.
- Observation older than MAX_OBS_AGE → no action-eligible output, `stale_obs` tagged.
- ObservedAt local hour (not wall clock) drives the climo lookup — test with a 2h-stale reading.

**Climatology table**
- Builder produces monotone non-increasing exceedance in δ and (after peak hours) decreasing
  remaining-rise mass; point mass at zero present for late hours (fixture-driven, synthetic
  history).
- Lookup interpolates between hours and handles missing city/month by returning null (no
  fabrication).

**Fixtures**
- Captured ensemble hourly payloads (gfs + ecmwf shapes) for a °C and a °F city; malformed/partial
  payloads → graceful null.

`src/weather/__tests__/weatherDriftStrategy.test.ts` (extend):

- `oracle_likely_against` state set when fresh conditionalP and `bid > P + buffer`; exit routed
  through `tryWeatherExit` with all existing gates (depth, floor, cooldown) still enforced.
- Hold guard vetoes a **bid-velocity exit** when `P − bid ≥ gap` with fresh settlement-aligned obs
  (the 0.95→0.55 whipsaw case); notification still fires; shadow row records `would_hold_guard` +
  trigger type. Velocity exit proceeds when conditionalP is stale or absent (#470 behavior
  preserved).
- Hold guard **never** vetoes `oracle_impossible` (binary oracle priority is absolute).
- Tier 1 and Tier 2 exits are not vetoed (current scope — entry-relative drops on cap-clamped
  entries are treated as authoritative) — test asserts the guard does not interfere with either.
- `confidence: 'none'` city (no live source) → no conditional estimate, #470 heuristics fire
  exactly as before (coverage-boundary regression guard).
- Phase A audit fields (`wouldConfirm`/`wouldVeto` + gap) written on heuristic-triggered exits
  while soft exit is dark.
- Soft exit disabled → state computed and shadow-logged, no action (dark-mode contract).
- No conditionalP (null) → behavior identical to today (regression guard).

`src/weather/__tests__/weatherScanner.test.ts` (extend — resting-cancel rule):

- Resting maker cancelled when fresh settlement-aligned conditionalSideProb fails the posted price
  by the buffer (res-day); routed through the existing revalidation pass, not a new cancel path.
- NOT cancelled on: stale obs, `proxy`/`none` confidence, non-res-day, model-only drift, or
  conditionalP within the buffer of posted price (queue priority preserved in all five cases).
- Cancel reason recorded distinctly (e.g. `cond_oracle_picked_off`) so PnL attribution can
  separate this rule from FV-rule and expiry-sweep cancels.
- `pickedOff` shadow field written at fill time when obs were available (Phase A metric A.6
  source).

`src/weather/__tests__/weatherFlip.test.ts` (extend, Phase C):

- Non-confirmed flip candidates use `1 − conditionalHeldProb` as fair value when fresh, static
  model value when knob off or estimate stale.

Backtest script (`scripts/backtest-cond-oracle.ts`):

- Deterministic on a synthetic fixture (known trajectories + outcomes) so the calibration/Brier
  pipeline itself is tested, not just eyeballed.

---

## Risks

- **Ensemble hourly underdispersion** → overconfident conditionalP. Mitigation: spread inflation
  knob calibrated in Phase A; climo clamp; cost buffer in the exit rule.
- **Open-Meteo dependency intraday.** Mitigation: climo fallback estimator; existing forecast
  cache/retry; coverage metric in Phase A gates.
- **Obs lag mispricing the curve.** Mitigation: observedAt-hour semantics + staleness gate (both
  unit-tested).
- **Double-exit / state-machine conflicts.** Mitigation: single new state inside the existing drift
  state machine; binary oracle priority; existing cooldown/exited markers reused.
- **30-min scan cadence lags the market.** Accepted for risk management (we stop being the
  bagholder; we don't need to be first). If Phase C nowcast entries prove out, consider a
  lightweight obs-only loop (5–10 min, cities with open positions only) as a follow-up — not in
  this plan's scope.
- **Selling winners into temporary dips.** This risk is now *live* via the #470 bid-velocity rule
  (peak-relative; whipsaws on appreciated positions trigger it by design). The entry-relative Tier
  thresholds carry little of this risk on cap-clamped entries. Mitigation: the oracle rule only
  sells *above* fair value; the hold guard arbitrates velocity exits when fresh obs exist; Phase A
  audit quantifies the whipsaw cost before the guard goes live; Phase B metric B.2 watches the
  realized average.
- **Guard wrongly protecting losers** (the inverse failure). Mitigation: vetoes require fresh +
  settlement-aligned obs; Phase A gate A.4 requires > 50% of would-vetoes to be correct before the
  guard is enabled; Phase B metric B.3 tracks it per trigger type with a ≥ 60% bar.

---

## Open Questions

1. Does the intraday city bias differ materially from the daily-max bias we already apply? (Phase A
   measurement; if yes, per-hour bias correction becomes a follow-up.)
2. HKO settlement uses the final daily extract — confirm rhrread intraday readings never exceed the
   daily-extract max retroactively (would break the "max only increases" floor assumption for HK).
3. For °F cities, WU station readings come in whole °F — does integer quantization at the boundary
   need a half-degree continuity correction in the final-max distribution?
4. Should the hold guard also veto the *invalidation* scanner's res-day exits, or only drift exits?
   (Start drift-only; revisit after Phase B.)
