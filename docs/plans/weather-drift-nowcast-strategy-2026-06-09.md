# Weather Drift + Nowcast Strategy

Date: 2026-06-09

## Context

The current weather system is good at finding forecast-vs-market entry edge, and it now has several
guards for stale theses:

- `weatherInvalidation.ts` revalues open positions against fresh forecasts, blocks size-ups, can
  hedge invalidated positions, and can exit on resolution day when configured.
- `weatherScanner.ts` revalidates resting maker orders and cancels stale out-of-range primaries.
- `nearResEntry.ts` blocks new entries near resolution because overnight forecasts become stale.
- `weatherOracleScanner.ts` buys known winners after `weather_ground_truth` is written.
- `hkoClient.ts` fetches Hong Kong Observatory absolute daily max, which matches the Hong Kong
  settlement source.

Those are still mostly defensive overlays. A weather bracket position is not just a static bet made
from a single forecast. The edge changes materially as the forecast, city-local day, observed high,
and market price evolve. Exact-degree interior brackets are especially sensitive: a corrected
forecast moving from 31.2C to 29.6C can change a 28C NO from almost certain to merely favorable, and
a later move to 28.3C can put the modal forecast inside the bracket even if continuous held
probability remains above 50%.

We need a focused lifecycle strategy that treats forecast drift and intraday observed max as primary
signals, not only as invalidation triggers.

## Goals

1. Track every open and resting weather exposure from entry through resolution.
2. React earlier to thesis changes in exact-degree interior brackets.
3. Use official or settlement-aligned intraday observations when available, especially HKO for Hong
   Kong.
4. Reuse existing invalidation, lock-in, resting revalidation, and oracle scanners where possible.
5. Produce clear shadow metrics before enabling live exits or flips.
6. Improve realized weather PnL by reducing stale-position drawdowns and capturing late oracle/nowcast
   repricing edge.

## Non-Goals

- Do not replace the base weather entry scanner.
- Do not blindly market-sell every forecast drift.
- Do not treat Open-Meteo archive `observed_high` as settlement truth when a `resolution_high` source
  exists.
- Do not add an LLM step to weather lifecycle decisions.
- Do not collapse all weather behavior into one giant scanner; keep entry, drift management,
  lock-in, and post-resolution oracle behavior separable.

## Current Building Blocks To Reuse

### Forecast Revaluation

`runWeatherInvalidationScan` already does most of the hard work:

- Loads open weather positions from Postgres.
- Parses `weather:<city>:<targetDate>:<bracketLabel>` and reconciled weather questions.
- Fetches active Gamma events.
- Fetches or reads cached forecasts.
- Calls `computeBiasedProb` using city bias settings.
- Computes:
  - `entryHeldProb`
  - `currentModelProb`
  - `currentHeldProb`
  - `drop`
  - `correctedForecastHigh`
  - `roundedForecast`
  - modal inversion state
- Writes `weather_forecast_invalidation` shadow rows.

This should be extracted into a shared `evaluateWeatherPositionThesis` helper instead of duplicated.
The invalidation scanner should become one consumer of that helper; the drift strategy should become
another.

### Modal Inversion

The invalidation scanner already knows whether the corrected forecast rounds into or out of a
bounded bracket. That predicate is exactly the right primitive for exact-degree markets, but the
existing invalidation trigger is intentionally conservative:

- It requires consecutive modal inversion runs.
- It ignores modal inversion while held-side probability is above
  `WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB`.
- It requires prior modal support.

The drift strategy should reuse the same modal state, but classify it into less severe states before
full invalidation.

### Resting Order Revalidation

`revalidateRestingWeatherOrders` cancels unfilled primary maker orders when their fresh fair value no
longer supports the posted price. The drift strategy should not create a second cancel path for the
same orders. Instead, it should feed the same revaluation output into the existing revalidation pass
and extend the cancel reasons where needed.

### Lock-In And Invalidation Hedges

`weatherLockIn.ts` and `weatherInvalidation.ts` can already buy the opposite side under strict price
and cost ceilings. The drift strategy should reuse the same opposite-token buying helper after it is
extracted, with different reason tags:

- `weather_lock_in`: protect a likely winner cheaply.
- `weather_forecast_invalidation_hedge`: hedge a degraded thesis.
- `weather_drift_hedge`: hedge a warning/thesis-changed state before full invalidation.

### Post-Resolution Oracle Scanner

`weatherOracleScanner.ts` handles yesterday's known winners from `weather_ground_truth`. The drift
strategy should not duplicate that job. It should add an intraday "known impossible/known winner"
layer for current-day markets only when the settlement source supports it.

## Proposed Strategy

Introduce a new weather lifecycle component:

```text
src/weather/weatherDriftStrategy.ts
```

The strategy runs every weather scan cycle after fresh forecast/event data is available and before
new entries are submitted. It evaluates:

1. Open positions.
2. Resting primary weather maker orders.
3. Optional current-day active brackets for late nowcast entries.

It emits a normalized `WeatherDriftDecision` for each exposure:

```ts
type WeatherDriftState =
  | 'stable'
  | 'watch'
  | 'thesis_weakened'
  | 'modal_against'
  | 'oracle_impossible'
  | 'oracle_confirmed'
  | 'exit_candidate'
  | 'hedge_candidate'
  | 'flip_candidate';

interface WeatherDriftDecision {
  positionId?: string;
  marketId: string;
  direction: 'YES' | 'NO';
  city: string;
  targetDate: string;
  bracketLabel: string;
  state: WeatherDriftState;
  action: 'none' | 'cancel_resting' | 'block_size_up' | 'notify' | 'hedge' | 'exit' | 'flip';
  reason: string;
  entryHeldProb?: number;
  currentHeldProb?: number;
  currentModelProb?: number;
  drop?: number;
  entryCorrectedForecastHigh?: number;
  currentCorrectedForecastHigh?: number;
  roundedForecast?: number;
  observedMax?: number;
  observedSource?: string;
  currentPrice?: number;
  bid?: number;
  ask?: number;
}
```

The action is initially shadow-only. Live behavior is enabled in stages.

## Decision Model

### 1. Forecast Drift Classification

For each open position, use the shared thesis evaluator to compute current held probability and modal
state.

Recommended default states:

| State | Condition | Default live action |
|---|---|---|
| `stable` | Held probability remains close to entry and modal supports thesis | none |
| `watch` | Held probability drop >= 0.10 or forecast moved toward bracket boundary | shadow only |
| `thesis_weakened` | Held probability drop >= 0.20 but held probability still > hard invalidation floor | block size-up, notify optional |
| `modal_against` | Corrected forecast rounds against held bounded-bracket thesis for 1 run | block size-up, evaluate exit/hedge |
| `exit_candidate` | Modal against for 2 runs or drop >= 0.20 and market bid clears exit floor/depth | exit if enabled |
| `hedge_candidate` | Thesis weakened and opposite ask is cheap under cost ceiling | hedge if enabled |
| `flip_candidate` | Our side is now negative EV and opposite side is positive EV after spread | shadow first |

This is intentionally more granular than invalidation. A position can be `thesis_weakened` without
being fully invalidated. That lets us stop adding risk and start looking for cheap de-risking before
the model crosses the existing hard thresholds.

### 2. Exact Interior Bracket Rules

Interior brackets should be treated differently from tails.

For a bounded Celsius bracket such as `28C`:

- `NO` thesis support means the corrected/modal forecast rounds outside 28.
- `NO` warning means the corrected forecast is within a configurable distance of the 27.5-28.5
  rounding window.
- `NO` modal-against means corrected forecast rounds to 28.
- `YES` thesis support means corrected forecast rounds to 28.
- `YES` modal-against means corrected forecast rounds outside 28.

Proposed knobs:

```env
WEATHER_DRIFT_EXACT_ENABLED=false
WEATHER_DRIFT_EXACT_BOUNDARY_BUFFER_C=0.35
WEATHER_DRIFT_EXACT_MODAL_MIN_RUNS=1
WEATHER_DRIFT_EXACT_EXIT_MODAL_MIN_RUNS=2
WEATHER_DRIFT_EXACT_MIN_EXIT_BID=0.10
WEATHER_DRIFT_EXACT_MIN_EXIT_DEPTH_RATIO=0.90
```

The key change is that exact brackets should enter `modal_against` after one scan, even if they do
not immediately exit. The existing invalidation scanner can keep its conservative full-invalidation
rules.

### 3. Tail Bracket Rules

Tail brackets are less sensitive to one-degree modal rounding because one side is open-ended. They
should mostly use held-probability degradation, observed max, and market price.

Examples:

- High-tail `34C or higher`, held `NO`: if observed max has already reached 34, thesis is
  `oracle_impossible`.
- Low-tail `24C or below`, held `YES`: if observed max has already exceeded 24, thesis is
  `oracle_impossible`.
- High-tail `34C or higher`, held `YES`: if observed max has already reached 34, thesis is
  `oracle_confirmed`.

### 4. Intraday Observed Max / Nowcast Layer

Forecast drift is still a model. On resolution day, actual observed max should dominate whenever it
is settlement-aligned.

Add a source abstraction:

```ts
interface WeatherLiveObservation {
  city: string;
  targetDate: string;
  observedMax: number;
  source: 'hko-live' | 'wu-live' | 'metar-live' | 'none';
  observedAt: string;
  confidence: 'settlement_aligned' | 'proxy' | 'none';
}
```

This layer applies to **all cities**, using each city's existing settlement oracle
(`CityCoordinates.resolutionSource`):

- `resolutionSource === 'hko'` → HKO live observation (e.g. Hong Kong)
- `resolutionSource === 'wu'` → Weather Underground intraday station data
- `resolutionSource === 'metar'` → hourly METAR observations at the city's airport station

HKO was the city that first surfaced this gap, but the implementation must not be
HKO-specific. Every city in `CITY_COORDINATES` — including cities currently in
`WEATHER_EXCLUDED_CITIES` — should be covered by whatever oracle applies to it.
Excluded cities still have open positions that need exit/cancel decisions; exclusion
only prevents new entries.

Source requirements (apply to all three):

- Must be the same endpoint the reconciler already uses for `resolution_high`, or a live
  counterpart of it with clearly documented semantics.
- Must be station-specific, not an area average or model output.
- Must provide same-day high-so-far or enough observations to compute it reliably.
- Must be timestamped so staleness can be detected.
- Must be unit-tested against captured payloads before enabling for live decisions.

If no official live endpoint is available for a given oracle, do not fake it. Use
forecast-only drift for that city until the daily extract settlement arrives. A city
with no live source gets `confidence: 'none'` and the drift scanner treats it the same
as a pre-resolution day (forecast only).

- Do not use Open-Meteo archive for intraday decisions.
- If a live source is unavailable, keep using forecast-only drift for the current day
  and let the existing per-source reconciler client settle after the daily extract
  updates.

For each bracket:

- `observedMax` already inside an exact bracket does not prove final winner until day end; a later
  higher max can move the winner to a higher bracket.
- `observedMax` above an exact bracket's high makes exact-bracket `YES` impossible and `NO`
  confirmed.
- `observedMax` at or above a high tail's low confirms high-tail `YES`.
- `observedMax` above a low tail's high makes low-tail `YES` impossible.

This gives high-confidence same-day exits for dead `YES` exact/low-tail positions and confirmed
high-tail positions. It does not automatically confirm exact-bracket `YES` until the day is over.

### 5. Market-Aware Actions

The strategy should not decide from model state alone. It should inspect the held-side bid and
opposite-side ask using `getBookTouchLevels`.

Actions:

- `block_size_up`: set or reuse `weather:forecast_invalidated:<marketId>:<direction>` with a
  reason payload, even for warning states if configured.
- `cancel_resting`: delegate to resting revalidation when a pending maker order's posted price is
  above fresh fair value or nowcast makes it stale.
- `notify`: send a concise Telegram alert when thesis changes but bid/ask gates do not allow an
  action.
- `hedge`: buy opposite token when the cost ceiling preserves acceptable payoff.
- `exit`: sell held token when best bid and depth clear configured floors.
- `flip`: after shadow validation, close held side and optionally buy opposite side when the
  opposite side has positive edge after spread.

`flip` should ship last. It is the highest-risk action because it can churn on noisy forecasts.

## Integration Plan

### Phase 1: Extract Shared Thesis Evaluation

Create:

```text
src/weather/weatherThesis.ts
```

Move or wrap the reusable pieces from `weatherInvalidation.ts`:

- open weather position parsing
- forecast retrieval with cached fallback
- city-bias probability computation
- modal support/inversion computation
- entry/current held probability computation

Keep existing behavior identical for `weatherInvalidation.ts`.

Output should include both continuous probability and modal/rounded diagnostics.

### Phase 2: Shadow Drift Scanner

Add `weatherDriftStrategy.ts` with shadow-only execution:

- Query open weather positions from Postgres.
- Load pending weather maker primaries from Redis.
- Evaluate each exposure with `weatherThesis.ts`.
- Optionally attach live observation if a source exists.
- Classify into `WeatherDriftState`.
- Write `shadow_observations` kind `weather_drift_decision`.
- Log `[weather-drift] decision`.

Run it from `runWeatherScan()` immediately after `runWeatherInvalidationScan()` and before the new
entry execution loop. This ordering ensures:

- Existing invalidation markers are refreshed.
- Drift warnings can block size-ups/new risk before execution.
- Resting order revalidation still has fresh opportunity data.

### Phase 3: Size-Up And Resting-Order Risk Control

Enable low-risk live actions:

- For `thesis_weakened`, `modal_against`, and `oracle_impossible`, block size-ups.
- For resting primary makers, cancel if:
  - fresh held fair value is below posted price, or
  - nowcast makes the order's side impossible, or
  - exact-bracket modal is against for two consecutive scans.

Reuse existing Redis key shape where possible:

```text
weather:forecast_invalidated:<marketId>:<direction>
```

Value should include:

```json
{
  "source": "weather_drift",
  "state": "modal_against",
  "reason": "exact_modal_into_bracket",
  "currentHeldProb": 0.725,
  "drop": 0.261,
  "correctedForecastHigh": 28.3,
  "roundedForecast": 28,
  "observedAt": "2026-06-09T08:02:00.000Z"
}
```

### Phase 4: Resolution-Day Exit Candidate

Add live exits for tightly scoped cases:

- Current day only.
- Exact bounded brackets and tail brackets only.
- Held-side best bid >= minimum exit floor.
- Depth at or above floor >= configured ratio of shares held.
- No open cooldown marker.
- Action reason is `oracle_impossible`, `modal_against_persistent`, or `held_prob_drop_severe`.

Reuse `tryInvalidationExit` logic from `weatherInvalidation.ts` by extracting it into a shared
weather exit helper. Do not maintain two separate sell implementations.

Proposed knobs:

```env
WEATHER_DRIFT_EXIT_ENABLED=false
WEATHER_DRIFT_EXIT_MIN_BID=0.10
WEATHER_DRIFT_EXIT_MAX_SLIPPAGE=0.15
WEATHER_DRIFT_EXIT_MIN_DEPTH_RATIO=0.90
WEATHER_DRIFT_EXIT_COOLDOWN_S=1800
```

### Phase 5: Intraday Live Observation (All Cities)

Add live observation clients for all settlement oracles. Each city's `CityCoordinates.resolutionSource`
determines which client to call (`'wu'` → WU intraday, `'metar'` → METAR hourly stream,
`'hko'` → HKO live observations). HKO was the city that first motivated this phase, but the
implementation must cover all cities from the start.

**Scope**:

- Implement one client adapter per oracle type (`wu-live`, `metar-live`, `hko-live`).
- Cities in `WEATHER_EXCLUDED_CITIES` are **not** excluded here — they still have open positions
  that need exit/cancel decisions. Exclusion only blocks new entries.
- A city whose oracle has no viable live endpoint gets `confidence: 'none'` and is treated like a
  pre-resolution day (forecast-only drift, no oracle state transitions).

**Per-oracle implementation notes**:

- **WU (wu-live)**: Weather Underground personal weather station or observation network. Must use
  the same station that the reconciler uses for `resolution_high`. Check whether the WU API exposes
  an intraday max or only most-recent observation; if only current, compute running max from the
  hourly stream.
- **METAR (metar-live)**: Hourly AVIMET/METAR decode from the city's airport station (same ICAO
  code the reconciler uses). Accumulate intraday max from hourly observations.
- **HKO (hko-live)**: Official HKO observation for the Hong Kong Observatory station. Must be
  station-specific, not an area average.

All three must satisfy the source requirements described in the
[Intraday Observed Max / Nowcast Layer](#intraday-observed-max--nowcast-layer) section above.

Once implemented:

- Confirm impossible exact/low-tail YES positions as soon as observed max exceeds their bracket.
- Confirm high-tail YES positions as soon as observed max reaches the tail.
- Block/cancel opposite stale orders immediately.
- Shadow-log potential buys of confirmed winners, but only enable live buying after separate review.

### Phase 6: Flip Strategy

Only after shadow review, consider flipping:

- Exit current side if bid/depth clear.
- Buy opposite side only if:
  - opposite fair value exceeds ask by minimum edge,
  - forecast/modal state supports the opposite side for consecutive scans,
  - spread and fees leave positive expected value,
  - per-city and per-scan exposure caps allow it.

Proposed default: do not enable automatic flips until the shadow cohort shows clear positive EV.

## Config Summary

New knobs:

```env
WEATHER_DRIFT_ENABLED=false
WEATHER_DRIFT_SHADOW_ENABLED=true
WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED=false

WEATHER_DRIFT_WATCH_DROP=0.10
WEATHER_DRIFT_THESIS_WEAKENED_DROP=0.20
WEATHER_DRIFT_SEVERE_DROP=0.30
WEATHER_DRIFT_MIN_CURRENT_HELD_PROB_FOR_SEVERE=0.70

WEATHER_DRIFT_EXACT_ENABLED=true
WEATHER_DRIFT_EXACT_BOUNDARY_BUFFER_C=0.35
WEATHER_DRIFT_EXACT_MODAL_MIN_RUNS=1
WEATHER_DRIFT_EXACT_EXIT_MODAL_MIN_RUNS=2

WEATHER_DRIFT_EXIT_ENABLED=false
WEATHER_DRIFT_EXIT_MIN_BID=0.10
WEATHER_DRIFT_EXIT_MAX_SLIPPAGE=0.15
WEATHER_DRIFT_EXIT_MIN_DEPTH_RATIO=0.90
WEATHER_DRIFT_EXIT_COOLDOWN_S=1800

WEATHER_DRIFT_HEDGE_ENABLED=false
WEATHER_DRIFT_MAX_HEDGE_PRICE=0.20
WEATHER_DRIFT_MAX_TOTAL_COST=1.05
WEATHER_DRIFT_MIN_FILL_RATIO=0.90

WEATHER_DRIFT_LIVE_OBS_ENABLED=false
WEATHER_DRIFT_WU_LIVE_ENABLED=false
WEATHER_DRIFT_METAR_LIVE_ENABLED=false
WEATHER_DRIFT_HKO_LIVE_ENABLED=false
WEATHER_DRIFT_LIVE_OBS_MAX_AGE_MIN=30
```

Use conservative defaults:

- Shadow on.
- Live size-up blocking off until reviewed.
- Exit/hedge/flip off.
- Exact drift classification on for shadow because this is the main missing signal.

## Expected Outcomes

### Near-Term

- Cleaner visibility into why a weather position is still held.
- Earlier detection of exact-bracket modal risk.
- Fewer size-ups into stale weather theses.
- Fewer stale resting maker fills after the forecast moves against us.

### Medium-Term

- Lower drawdowns on exact-degree weather positions.
- More consistent stake-to-confidence behavior through the full position lifecycle, not just entry.
- Better separation of forecast risk from settlement-oracle risk.
- Better postmortems because every open position has a time series of thesis states.

### Long-Term

- A true intraday weather market strategy:
  - Enter on forecast edge.
  - Manage on forecast drift and observed max.
  - Lock in or exit when the thesis changes.
  - Buy known winners only when settlement-aligned data makes the outcome clear.

Expected tradeoff: this will likely reduce some winners that recover after temporary forecast drift.
The goal is not to maximize hit rate; it is to improve risk-adjusted PnL and reduce large stale-thesis
losses.

## Metrics To Track

Write enough data into `shadow_observations` to compute:

- Entry held probability vs current held probability over time.
- Number of positions by drift state.
- Time from first `watch` to fill/exit/resolution.
- PnL of positions that entered `modal_against` but were held.
- PnL of positions that would have exited at first `exit_candidate`.
- PnL of positions that would have hedged.
- PnL of stale resting maker fills that revalidation would have cancelled.
- False-positive rate: drift exits that would have recovered to win.
- False-negative rate: held positions that went from stable/watch to losing resolution.

Minimum dashboard slices:

```sql
-- Drift states by day
SELECT date_trunc('day', observed_at), payload->>'state', count(*)
FROM shadow_observations
WHERE kind = 'weather_drift_decision'
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- Candidate exits and eventual outcomes
SELECT *
FROM shadow_observations
WHERE kind = 'weather_drift_decision'
  AND payload->>'action' IN ('exit', 'hedge', 'flip')
ORDER BY observed_at DESC;
```

## Tests

Add `src/weather/__tests__/weatherDriftStrategy.test.ts`:

- Classifies stable position when held probability and modal support remain intact.
- Classifies watch on small held-prob drop.
- Classifies thesis weakened on larger held-prob drop above hard invalidation floor.
- Classifies modal against for exact NO when corrected forecast rounds into bracket.
- Does not classify tail brackets from modal rounding alone.
- Marks exact YES impossible when live observed max exceeds bracket high.
- Marks high-tail YES confirmed when live observed max reaches tail threshold.
- Blocks size-up only when configured.
- Does not exit when bid depth is insufficient.
- Does not hedge when cost ceiling fails.

Update existing tests:

- `weatherInvalidation.test.ts`: confirm shared thesis extraction preserves current invalidation
  behavior.
- `weatherScanner.test.ts`: confirm drift markers are checked before size-up/new execution where
  configured.
- `weatherLockIn.test.ts`: confirm lock-in and drift hedge share double-hedge markers.
- Per-oracle live client tests: add captured payload fixtures for each oracle type (WU, METAR, HKO)
  once the live nowcast clients are implemented. Do not share fixtures across oracle types.

## Rollout

1. Merge helper extraction with no behavior change.
2. Enable `WEATHER_DRIFT_SHADOW_ENABLED=true`.
3. Review at least 1-2 weeks of shadow outcomes, with special focus on exact Celsius brackets.
4. Enable `WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED=true`.
5. Enable resting-order cancel integration for drift states.
6. Enable exits only for `oracle_impossible` and severe persistent modal cases.
7. Consider hedges after exit behavior is measured.
8. Consider flips last, and only with a separate EV review.

## Risks

- Forecasts can flap around exact-degree boundaries. Mitigation: separate warning state from live
  exit state, require persistence for exits, and use market/depth gates.
- Live observation data (WU/METAR/HKO) may not match final daily extract semantics for a given
  oracle. Mitigation: only tag `settlement_aligned` sources as action-capable; treat proxies and
  uncertain observation types as shadow-only until verified against resolved market outcomes.
- Exiting on low bids can lock in losses that later recover. Mitigation: bid/depth floors, shadow
  review, and reason-specific enablement.
- More scanners can create duplicate hedges/exits. Mitigation: shared Redis markers and shared
  helpers for opposite-token buys and exits.
- Flip logic can overtrade. Mitigation: ship last, require positive edge after spread, and keep
  per-city/per-scan caps.

## Open Questions

- **WU intraday max**: Does the Weather Underground API expose a same-day running max, or only the
  most-recent observation? If the latter, the client must accumulate it from hourly observations,
  and we need to verify what happens at midnight (day rollover) so intraday max doesn't bleed across
  days.
- **METAR intraday max**: Is accumulating from hourly METAR observations sufficient, or is there a
  daily summary product? What is the observation lag for international stations?
- **HKO intraday endpoint**: Is there an official HKO API or HTML data product that gives same-day
  high-so-far for the Hong Kong Observatory station with enough reliability for live trading?
- **Settlement semantics by oracle**: For each oracle type, what does "daily high" mean at the
  resolution hour — does it cover midnight-to-midnight local time, or a different window? Does the
  HKO value Polymarket uses come from the final daily extract or an intraday observation, and are
  they ever different? Same question for WU and METAR. Answers determine whether live observations
  from each source can be tagged `settlement_aligned` vs `proxy`.
- Should exact Celsius brackets use `Math.round` semantics everywhere, or should settlement brackets
  compare the one-decimal value directly against integer labels? The current market convention
  appears to resolve integer brackets from the daily absolute max, but this should be verified
  against recent resolved market outcomes for each oracle type.
- Should the first live exit cohort be limited to positions already losing on market price, or should
  profitable but thesis-broken positions also exit?
- Should drift block fresh entries in the same event, or only size-ups/resting orders for the same
  market side?
