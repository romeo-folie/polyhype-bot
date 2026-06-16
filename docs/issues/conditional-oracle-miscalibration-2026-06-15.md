# Conditional oracle is miscalibrated — `cond_p` 0.95–1.0 loses ~half the time

- **Date:** 2026-06-15
- **Status:** OPEN — needs a dedicated calibration study (flagged for a separate session)
- **Severity:** blocks using the conditional oracle to gate weather drift exits (the `WEATHER_COND_ORACLE_HOLD_GUARD`)

## TL;DR
The conditional oracle's held-side win probability (`conditionalHeldProb`, a.k.a. `cond_p`) — the live-temperature-conditioned estimate produced by `conditionalHeldProbability()` in `src/weather/conditionalOracle.ts` — does **not** track realized outcomes. In a 5-day shadow sample it said **0.95–1.0 and the bet lost ~half the time**. Because of this, the `WEATHER_COND_ORACLE_HOLD_GUARD` (which vetoes res-day exits when `cond_p − bid ≥ HOLD_GUARD_GAP`) cannot be enabled — its own shadow audit (`condOracleAudit.wouldVeto`) shows it would hold more losers than winners.

## How this was found
Investigating whether to enable the (dark) hold guard to stop weather drift exits dumping winners. Pulled the guard's own shadow audit from `shadow_observations` (kind=`weather_drift_decision`, `payload->condOracleAudit->>'wouldVeto'`) over 5 days and cross-referenced each flagged exit against the market's actual Gamma resolution.

### Result: 21 exits the guard would have BLOCKED → 9 WON, 11 LOST, 1 pending
Blocking would have held **more losers (11) than winners (9)**. Net-negative, not the intended "save the winners" behavior.

### Calibration is the root cause — `cond_p` has ~no predictive power here
Bucketed by `cond_p` (decided cases from the same sample):

| `cond_p` bucket | Won | Lost | Implied vs actual |
|---|---|---|---|
| ≥ 0.95 | 5 | 6 | says ~98%, realizes **~45%** |
| 0.80–0.95 | 2 | 1 | small n |
| 0.55–0.80 | 2 | 4 | — |

High-confidence misses (oracle said ~certain win, bet **lost**):
- Mexico City `cond_p=1.000` → LOST
- Hong Kong `cond_p=1.000` → LOST
- Paris `cond_p=0.988` → LOST
- Ankara `cond_p=0.978` → LOST
- Seattle `cond_p=0.972` → LOST

A `cond_p` of 1.0 that loses is a hard calibration failure, not noise.

## Hypotheses to investigate
The oracle conditions a forecast distribution on the observed running-max temperature. Candidate causes (slice the shadow data by each):
1. **Partial-day observation timing** — res-day exits often fire before the afternoon peak; if `observedAt` is early, the remaining-hours distribution may be too optimistic that the max stays out of (NO) / in (YES) the bracket.
2. **Climo-fallback clamping** — `conditionalClampedByClimo=true` rows may be using a stale/wrong climo table (see `[[project_weather_conditional_oracle]]`; climo was regenerated in PR #489 but coords/station issues recurred).
3. **Estimator gap / staleness** — `conditionalEstimatorGap` and `conditionalIsStale`; check whether high-gap or stale rows dominate the misses.
4. **Station divergence** — Polymarket's resolution station diverges from our obs sources (documented: Istanbul 4°C divergence in `[[project_june_weather_loss_decomposition]]`). The oracle can be "right" about the temp we observe but wrong about the station PM settles on.
5. **Rounding-edge bins** — 1°C/2°F brackets are coin-flips at the boundary; the oracle may be overconfident exactly where the outcome is genuinely uncertain.

## How to study it (for the next session)
- **Data:** `shadow_observations` kind=`weather_cond_oracle` (has `heldProb`, `estimator`, `members`, `isStale`, `clampedByClimo`, `estimatorGap`, `observedMax`, `observedAtLocalHour`, `confidence`, `staticModelHeldProb`) and kind=`weather_drift_decision` (`conditionalHeldProb` + the full decision context). Ground truth: each market's Gamma resolution (`outcomePrices`) and/or the `outcomes` table / `weather_ground_truth`.
- **Method:** build a proper reliability diagram — bucket `cond_p` in deciles, compute realized win rate per bucket, over a 2–4 week window (n was only ~20 here). Then slice by `clampedByClimo`, `isStale`, `confidence` (`settlement_aligned` vs not), `observedAtLocalHour`, `estimatorGap`, and `daysOut` to isolate which conditions the oracle is calibrated under (if any).
- **Goal:** find the subset where `cond_p` IS reliable (e.g. settlement_aligned + late-day + non-clamped), or conclude it needs a recalibration / shrink toward climo, before any exit gating relies on it.

## 2026-06-16 follow-up findings

Operational note: the weather scanner runs from host cron. Its scanner logs are not in the app repo; on the host they were found at `/home/romeo/logs/pga/weather.log` and `/home/romeo/logs/pga/weather.log.1`.

The follow-up calibration check used the currently settled DB rows. At the time of the check, settled weather ground truth was only complete through `2026-06-14`, so any later rows were excluded from realized win/loss counts.

### Shadow calibration still fails

Two cuts both showed that high `cond_p` is not action-grade:

| View | Filter | Result |
|---|---:|---:|
| Scan-point rows | `cond_p >= 0.95` | realized ~53%, not ~98% |
| Latest row per market | `cond_p >= 0.95` | 10 wins / 7 losses (~59%) |
| Drift-exit hold shadow | `condOracleAudit.wouldVeto=true` | 9 wins / 14 losses |

This means the dark hold guard would still have held more losers than winners in the sample. The issue is not limited to duplicate scan rows; it persists when each market is counted once.

### Climo fallback is the biggest identifiable culprit

In the latest-row-per-market sample, Brier scores were:

| Model/input | Brier |
|---|---:|
| Ensemble conditional probability | 0.214 |
| Static model | 0.334 |
| Climo fallback | 0.425 |

The worst high-confidence misses were concentrated in climo-fallback rows, including Seattle, London, Mexico City, Amsterdam, and Paris. A simple cap of `cond_p` at `0.65` improved latest-row-per-market Brier from `0.305` to `0.242` in the checked sample, which is a strong signal that the current live action value should be shrunk or capped unless the row is in a proven calibrated subset.

Interpretation: the climo fallback appears to be built from a source that understates real intraday extremes for the settlement-style station feed. The oracle can therefore become confidently wrong after seeing a partial-day observation that looks safely below/above a bracket in our climo distribution, while the actual WU/settlement station still has enough intraday movement to settle the other way.

### Timestamp bug found

The WU live observation path calls the WU historical endpoint but stamped `observedAt` as fetch time in `src/weather/liveObservation.ts`. That means the conditional oracle could treat a daily extreme as if it was observed at the scanner time rather than at the observation time that actually set the extreme.

This especially matters after the target local day has rolled over: the scanner may fetch a final historical extreme on the next UTC/local day, but the conditioning logic sees a late `observedAt` and can overstate how much of the day is already known. In the checked sample, the "observed after target local day" rows were small but all bad: 3 latest markets, all losses, with 2 high-confidence misses.

This timestamp bug is not the whole calibration problem. The larger issue remains climo fallback quality. But fixing it removes a concrete source of misleading conditioning and makes the shadow data easier to trust.

### Recommended state before enabling action

- Keep these live action flags disabled until calibration is re-proven: `WEATHER_COND_ORACLE_HOLD_GUARD_ENABLED=false`, `WEATHER_COND_ORACLE_RESTING_CANCEL_ENABLED=false`, and `WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED=false`.
- Fix WU live observations to preserve the timestamp of the observation that set the daily extreme.
- Rebuild or replace climo from settlement-aligned station history, preferably WU/official station history rather than ERA5/open-meteo historical data.
- Add an action-layer probability cap or shrink for climo-fallback rows. The first tested blunt cap, `cond_p <= 0.65`, improved Brier in the latest-row sample.
- If experimenting before a full rebuild, restrict use to ensemble-only, non-clamped rows with settlement-aligned observations and continue shadowing before trading on it.

## Consequence for exit logic (handled separately)
Because the probabilistic oracle is unreliable, the market-exit accuracy work (2026-06-15, separate change) does **not** use `cond_p`. It relies on the deterministic binary observed-temperature signal where available, not the probabilistic estimate. See that change for details.

Related: [[project_weather_conditional_oracle]], [[project_june_weather_loss_decomposition]], [[project_weather_drift_modal_exit_1streak]].
