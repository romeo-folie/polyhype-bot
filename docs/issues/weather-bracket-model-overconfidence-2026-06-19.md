# Weather bracket model overconfidence and NO bias

- **Date:** 2026-06-19
- **Status:** OPEN — source-level model calibration needed before scaling weather entries
- **Severity:** high for weather trading; June realized weather outcomes show systematic YES underprediction and inflated NO edge

## TL;DR

The weather model is systematically underestimating YES probability for narrow temperature brackets. That makes NO look attractive across many markets, especially exact `1°C` brackets and `2°F` ranges, but realized June outcomes show those YES events happen much more often than the model says.

This is not primarily an execution bug or a literal zero-width probability bug. The existing probability function already models exact Celsius labels as rounded bins using half-degree boundaries. The failure is calibration: the predictive distribution is too confident and too low on bracket YES mass, especially for Open-Meteo/international markets.

## Evidence

### Realized June weather outcomes

Dataset: rows from `outcomes` where `source='weather'` and `opened_at >= '2026-06-01' OR closed_at >= '2026-06-01'`.

| Metric | Value |
|---|---:|
| Realized weather outcomes | 154 |
| Wins | 58 |
| Losses | 96 |
| Win rate | 37.7% |
| Realized PnL | `-$65.87` |

Most realized damage came from NO:

| Side | Result | Trades | PnL |
|---|---|---:|---:|
| NO | lost | 93 | `-$317.81` |
| NO | won | 57 | `+$250.11` |
| YES | lost | 3 | `-$12.10` |
| YES | won | 1 | `+$13.93` |

### Narrow-bracket NO losses

Resolved June weather outcomes by market shape:

| Shape | Side | Trades | Losses | PnL |
|---|---|---:|---:|---:|
| exact degree | NO | 123 | 75 | `-$38.82` |
| between range | NO | 18 | 11 | `-$10.48` |
| or higher | NO | 8 | 6 | `-$18.31` |

For exact-degree NO losses, 52 resolved with the actual high exactly equal to the degree we bet against. Examples:

| Market | Model YES | Edge shown | Actual |
|---|---:|---:|---:|
| Toronto `24°C` NO | 12.3% | 38.7% | `24°C` |
| Istanbul `23°C` NO | 0.5% | 33.0% | `23°C` |
| Taipei `37°C` NO | 14.3% | 17.7% | `37°C` |
| Madrid `29°C` NO | 17.9% | 28.6% | `29°C` |
| Shenzhen `27°C` NO | 3.2% | 10.8% | `27°C` |

### Edge is inverted

Weather edge bucket performance in realized June outcomes:

| Weather edge bucket | Trades | Win rate | PnL |
|---|---:|---:|---:|
| `<10%` | 45 | 71.1% | `+$148.17` |
| `10-15%` | 23 | 21.7% | `-$34.52` |
| `15-20%` | 32 | 31.3% | `-$52.70` |
| `20-30%` | 40 | 25.0% | `-$73.40` |
| `30%+` | 14 | 7.1% | `-$53.42` |

In a calibrated system, larger predicted edge should not monotonically perform worse. This indicates the edge formula is exploiting a model blind spot.

### Shadow calibration confirms YES underprediction

Dataset: latest June `shadow_observations` `kind='weather_bracket'` per `market_id`, joined to `weather_ground_truth` for resolved target dates before 2026-06-19.

| Shape | Rows | Avg model YES | Actual YES frequency | Mean error |
|---|---:|---:|---:|---:|
| exact Celsius | 1199 | 14.4% | 24.5% | -10.2pp |
| Fahrenheit range | 503 | 14.1% | 26.4% | -12.3pp |
| or higher | 54 | 35.3% | 42.6% | -7.3pp |
| or below | 19 | 18.7% | 31.6% | -12.9pp |

For exact Celsius and Fahrenheit range brackets, bucket calibration was poor:

| Model YES bucket | Rows | Avg model YES | Actual YES frequency |
|---|---:|---:|---:|
| `<5%` | 351 | 2.0% | 14.0% |
| `5-10%` | 229 | 7.5% | 19.2% |
| `10-20%` | 596 | 15.1% | 24.5% |
| `20-30%` | 490 | 24.0% | 34.5% |
| `30-50%` | 36 | 31.2% | 52.8% |

This is the core failure: the model says some brackets are near-impossible, but they resolve YES at double-digit rates.

### Forecast scale is underdispersed

Event-level June shadow rows joined to ground truth show the Open-Meteo path is too tight:

| Forecast source | Bias mode | Rows | Mean error actual-forecast | MAE | RMSE | Avg sigma | MAE/sigma |
|---|---|---:|---:|---:|---:|---:|---:|
| open-meteo | full | 328 | +0.64 | 1.44 | 1.94 | 1.38 | 1.04 |
| open-meteo | none | 146 | +0.43 | 1.39 | 1.87 | 1.38 | 1.01 |
| open-meteo | weak | 16 | +0.33 | 1.58 | 2.24 | 1.57 | 1.00 |
| hrrr-combined | full | 170 | -0.14 | 2.52 | 3.54 | 3.19 | 0.79 |

For a calibrated normal distribution, expected `MAE/sigma` is about `0.798`. Open-Meteo around `1.0` means the model's sigma is materially too small. HRRR-combined is closer on scale.

## Current implementation notes

The bracket probability function already uses half-degree rounded bins:

- `src/weather/noaaClient.ts::estimateBracketProbability`
- Interior bracket probability is `CDF(high + 0.5) - CDF(low - 0.5)`.
- Exact Celsius `27°C` is treated as `[26.5, 27.5)`, not as a point event.

The bias layer currently does:

- optional city mean shift: `correctedForecastHigh = rawForecastHigh - cityBias.meanBias`
- sigma overlay: `effectiveStdDev = max(rawEffectiveStdDev, cityBias.empiricalStddev * multiplier)` in full mode
- weak band: widens sigma by `WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER`

Relevant files:

- `src/weather/noaaClient.ts`
- `src/weather/weatherScanner.ts`
- `src/weather/cityBias.ts`

The entry scanner also has an interior NO guard:

- If `Math.round(correctedForecastHigh)` lands inside a bounded bracket, skip NO.

That guard is useful but insufficient. It only checks the central point forecast; it does not account for ensemble/member modal mass, adjacent rounded values, calibrated YES frequency, or source-specific underdispersion.

## Likely root causes

1. **Raw forecast distribution is underdispersed.**
   The Open-Meteo/international path uses sigma values that are too tight relative to realized station errors. This makes central or adjacent narrow bins look less likely than they really are.

2. **Model calibration is location/shape/source dependent.**
   A global `WEATHER_STDDEV_MULTIPLIER` can reduce overconfidence, but it will also degrade better-calibrated paths such as HRRR-combined US markets. Calibration needs source/shape/horizon awareness.

3. **YES gate creates a hidden NO bias.**
   `findMispricedBrackets()` evaluates YES gates before side selection. If YES is blocked, the code can fall back to NO when `edgeNo > 0`. In a model that underestimates YES, this turns "we are unwilling to buy YES" into "we should buy NO," which is not logically valid.

4. **Rounded/modal forecast support is not part of the probability model.**
   The current guard checks only whether the point forecast rounds into the bracket. We need a probability-level signal for "how much forecast ensemble mass rounds into this exact bracket."

5. **Per-city mean bias is necessary but not sufficient.**
   Mean correction addresses station-specific warm/cold drift. It does not fully solve bracket-bin calibration, because the observed issue is that YES frequencies are too high across raw model probability buckets.

## Research context

This matches the standard weather forecasting problem: numerical weather prediction ensembles are often biased and underdispersed, so raw ensemble spread requires statistical post-processing before producing reliable probabilities.

Relevant approaches:

- **Model Output Statistics (MOS):** regression-based forecast correction for weather variables.
- **Ensemble Model Output Statistics (EMOS) / Nonhomogeneous Gaussian Regression (NGR):** calibrates both predictive mean and variance, often with forms like `mu = alpha + beta * ensembleMean` and `sigma = gamma + delta * ensembleSpread`.
- **Bayesian Model Averaging (BMA):** combines ensemble members/models into a calibrated predictive distribution.

References:

- Baran, Horanyi, Nemoda — comparison of BMA and EMOS for temperature and wind-speed ensemble calibration: https://arxiv.org/abs/1312.3763
- Diaz, Nicolis, Marin, Baran — ensemble temperature forecasts are often underdispersive and benefit from EMOS/BMA post-processing: https://arxiv.org/abs/1809.04042
- Jewson, Brix, Ziehmann — parametric calibration framework for medium-range ensemble temperature forecasts: https://arxiv.org/abs/physics/0308057
- Moller and Gross — EMOS plus autoregressive error adjustment for temperature forecasts: https://arxiv.org/abs/1508.01397

## Suggested fixes

### 1. Add calibrated bracket probability on top of the Gaussian model

Do not discard `estimateBracketProbability()`. Instead, treat it as `p_raw` and add a calibrated wrapper:

```text
p_raw = gaussianRoundedBinProbability(...)
p_cal = calibrateWeatherBracketProbability(p_raw, features)
```

Features to start with:

- bracket shape: exact Celsius, Fahrenheit range, high tail, low tail
- forecast source: Open-Meteo, HRRR-combined, combined, NOAA
- days out / resolution-day flag
- city or city cluster
- bias mode
- effective sigma
- distance from corrected forecast to bracket center
- whether corrected forecast rounds into or adjacent to the bracket
- market implied YES probability
- ensemble/member rounded-bin frequency when available

Start with a simple reliability-map correction before a larger EMOS implementation:

- Fit isotonic regression or logistic calibration by `(shape, source, horizon_bucket)`.
- Require minimum sample size; otherwise shrink toward a conservative global shape-level map.
- Persist calibration parameters in a small DB table or JSON artifact regenerated by a calibration script.
- Shadow-log both `modelProbRaw` and `modelProbCalibrated`.

Expected first-order correction from June:

- Low raw exact/range probabilities need a large upward adjustment. For example, `<5%` raw resolved YES 14% of the time.
- This will reduce fake NO edge and should increase YES opportunities where market price is below calibrated bucket probability.

### 2. Replace the current scale logic with EMOS/NGR-style sigma calibration

Current full-bias sigma:

```text
sigma = max(rawForecastSigma, cityEmpiricalStddev) * globalMultiplier
```

Better source-level form:

```text
mu = alpha_city_source_horizon + beta_source_horizon * forecastMean
sigma^2 = gamma_shape_source_horizon + delta_source_horizon * ensembleSpread^2
```

Pragmatic first version:

- Keep current city mean correction.
- Add source-specific sigma multiplier:
  - Open-Meteo international high: start around `1.2-1.3`
  - HRRR-combined: leave near `1.0`
- Tune by Brier/log loss on shadow rows, not by realized trade PnL.

Longer-term:

- Fit `alpha`, `beta`, `gamma`, `delta` using rolling 28-60 day shadow rows.
- Optimize negative log likelihood or CRPS for the resolved station temperature.
- Use the fitted distribution to compute rounded bracket probabilities.

### 3. Add ensemble rounded-bin probability

If ensemble member daily highs/lows are available, compute:

```text
memberBinProb = count(round(memberValue) in bracket) / memberCount
```

Then blend with calibrated Gaussian probability:

```text
p_final = w * p_calibratedGaussian + (1 - w) * memberBinProb
```

or use `memberBinProb` as a feature in the calibration wrapper.

This directly addresses the failure mode where the continuous normal model underweights the actual resolution bin.

### 4. Stop YES-gated fallback into NO

If YES has positive edge but is blocked by policy, skip the bracket instead of falling back to NO.

Rationale:

- "We do not allow this YES" does not imply "NO is good."
- With systematic YES underprediction, fallback NO amplifies the exact failure mode.

Implementation direction:

- In `findMispricedBrackets()`, if `yesGateBlocked && edgeYes > 0 && edgeYes >= edgeNo`, continue instead of selecting NO.
- Keep a shadow row showing `yesGateReason` and `wouldHaveFallenBackToNo` for analysis.

### 5. Promote rounded/modal support from guard to model feature

Keep the current point-rounded guard, but add adjacent and modal support:

- `round(correctedForecastHigh) in bracket` => NO blocked.
- `round(correctedForecastHigh) adjacent to exact/range bracket` => require calibrated YES probability and shadow/model agreement; otherwise block NO.
- If ensemble rounded mode is the bracket => block NO.
- If ensemble rounded mode is adjacent => require larger NO edge and smaller size.

This is a model-safety constraint while calibration catches up.

### 6. Separate YES evaluation from NO evaluation

Once `p_calibrated` exists, re-enable YES in shadow-first mode:

- Allow YES only when `p_calibrated - yesAsk >= minEdge`.
- Use stricter minimum market price and liquidity guards.
- Track YES calibration separately from NO.

The current evidence suggests the model is better at identifying YES mass than the side policy allows, but raw probabilities need calibration before sizing real YES.

## Expected outcomes

If the fixes work, we should see:

1. **Calibration improves before PnL improves.**
   Reliability tables should move toward `avg predicted YES ~= actual YES frequency`.

2. **NO trade count drops materially.**
   Many previous "high edge" NO trades should disappear because calibrated YES probability rises.

3. **High edge stops being inverted.**
   Weather edge buckets should no longer show `30%+` edge performing worst. The minimum acceptable outcome is flat/no relation; the desired outcome is monotonic improvement.

4. **Exact/range bracket losses decline.**
   Exact-degree NO positions should be rare and only fire when calibrated YES mass is genuinely low and the rounded/modal forecast is not nearby.

5. **YES candidates become visible.**
   Shadow rows should show some cases where calibrated YES edge is positive. These should be tracked before live sizing.

6. **Open-Meteo path becomes less overconfident.**
   Source-level forecast calibration should bring Open-Meteo `MAE/sigma` closer to `~0.80` and reduce low-probability YES misses.

## Test plan

### Unit tests

Add tests around probability and side selection:

1. `estimateBracketProbability()` remains unchanged for rounded-bin math.
   - Exact `27°C` still equals probability over `[26.5, 27.5)`.
   - Fahrenheit `70-71°F` still equals `[69.5, 71.5)`.

2. Calibration wrapper increases low raw probabilities for exact/range brackets when trained map says so.
   - Example: `p_raw=0.02`, `shape=exact_c`, `source=open-meteo` returns a higher `p_cal`.
   - `p_cal` remains bounded `[0, 1]` and monotonic in `p_raw`.

3. Source-specific sigma calibration.
   - Open-Meteo receives multiplier/inflation.
   - HRRR-combined remains unchanged unless configured.
   - Effective sigma is surfaced in shadow payload.

4. YES-gated fallback behavior.
   - If `edgeYes > 0`, `edgeYes >= edgeNo`, and YES gate blocks, no NO opportunity is emitted.
   - Native NO still emits when YES has no edge and NO has positive edge.

5. Rounded/modal NO veto.
   - Forecast rounds into bracket => NO skipped.
   - Ensemble rounded mode in bracket => NO skipped.
   - Adjacent rounded mode applies configured stricter gate.

### Data/backtest tests

Add a read-only calibration script, e.g. `scripts/weather-calibration-audit.ts`, that can run against Postgres and print:

- reliability by raw model probability bucket
- reliability by calibrated probability bucket
- Brier score and log loss for raw vs calibrated
- performance by shape/source/horizon
- edge bucket realized outcome, raw and calibrated
- NO-only and YES-only shadow cohorts

Acceptance targets before live rollout:

- Exact/range bucket mean calibration error under `5pp` where sample size is adequate.
- Brier score lower for calibrated probabilities than raw probabilities.
- Low raw probability cohorts no longer stay absurdly underpredicted after calibration.
- `edge > 10%` cohort should not have worse realized performance than `edge < 10%` in shadow/backtest.

### Regression tests from June failures

Use fixtures for known bad cases:

- Toronto `24°C` exact NO, actual `24°C`.
- Istanbul `23°C` exact NO, actual `23°C`.
- Taipei `37°C` exact NO, actual `37°C`.
- Madrid `29°C` exact NO, actual `29°C`.
- Shenzhen `27°C` exact NO, actual `27°C`.

Expected behavior after source-model fix:

- Calibrated YES probability is materially higher than raw.
- NO edge is reduced or eliminated.
- If rounded/modal support points at the bracket, NO is blocked.

### Shadow rollout

1. Ship calibration in shadow only:
   - log `modelProbRaw`, `modelProbCalibrated`, `edgeRaw`, `edgeCalibrated`, `tradeSideRaw`, `tradeSideCalibrated`.

2. Run for at least 7-14 resolved weather days.

3. Compare:
   - raw would-trade vs calibrated would-trade
   - realized outcomes of trades calibrated model would have skipped
   - realized outcomes of new YES candidates

4. Only re-enable live weather entries for cohorts that pass calibration gates.

## Immediate risk controls while source fix is built

These are not substitutes for calibration, but they reduce losses:

1. Disable exact/range NO when corrected forecast rounds into or adjacent to the bracket.
2. Disable NO if ensemble rounded mode is the bracket.
3. Treat `edge > 10%` as suspicious for weather until calibrated edge replaces raw edge.
4. Do not allow YES-gated fallback into NO.
5. Keep weather sizing tiny or shadow-only until calibrated reliability improves.

## Open questions

1. Do we have ensemble member daily high/low values persisted, or only ensemble stddev? If not, add persistence; rounded-member-bin probability is a high-value feature.
2. Should calibration optimize event-temperature likelihood first, or bracket Brier/log loss directly? Recommendation: do both, but gate trading on bracket calibration.
3. Should calibration be per city or clustered? Recommendation: source/shape/horizon global first, city overlay only when sample size is strong.
4. Should market implied probability be included in calibration? Recommendation: include as an optional feature in the bracket-level calibrator, but keep a pure weather-only probability for diagnostics.

## Related

- `docs/issues/conditional-oracle-miscalibration-2026-06-15.md`
- `docs/plans/weather-probabilistic-oracle-2026-06-10.md`
- `docs/plans/weather-tail-resolution-signal-shadow-2026-06-17.md`
- `src/weather/noaaClient.ts`
- `src/weather/weatherScanner.ts`
- `src/weather/cityBias.ts`
