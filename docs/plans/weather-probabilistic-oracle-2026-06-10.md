# Weather Probabilistic Oracle — Intraday Conditional Pricing

**Date:** 2026-06-10  
**Status:** Proposed — for implementation by a dedicated agent

---

## Problem

The current live-observation oracle (Phase 5) fires only at **mathematical certainty**: `observedMax > bracket_high + 0.5`. This means the scanner can observe a temperature sitting at or near the bracket boundary for hours without triggering any action.

The deeper issue is that our forecast model produces a **static morning probability** and never updates it intraday as observed temperatures accumulate. The market does the opposite: as soon as it sees a Shenzhen reading of 29°C at 14:00 local time, it implicitly runs a conditional probability model —

> *Given that the running maximum is already 29°C at 2pm, what is P(final daily maximum exceeds 29.5°C)?*

— and prices accordingly. This is why positions like Shenzhen June 2026 (`NO`, bracket `29°C`) collapsed from 0.40 to 0.10 across six consecutive scans while our model remained at 0.99 and our oracle returned `null`. The market had real-time thermometer access; we were waiting for a certainty gate that would never fire.

---

## The Fix: `conditionalFinalMaxProbability`

We already fetch WU and HKO intraday observations. The missing ingredient is a function:

```typescript
conditionalFinalMaxProbability(
  city: string,
  observedMax: number,      // running max so far today (°C)
  localHour: number,        // current local hour (0–23)
  month: number,            // 1–12 for climatological lookup
  threshold: number,        // the bracket boundary (bracket_high + 0.5 for NO settlement)
): number  // P(final daily max > threshold)
```

This function answers: given how much of the day's warming is typically done by this hour, how often does the maximum continue to rise past `threshold`?

### How it works

1. **Diurnal temperature curve**: For each city and calendar month, the climatological hourly temperature profile has a well-defined shape — temperatures typically peak in mid-to-late afternoon (14:00–17:00 local). The fraction of the day's total rise that has occurred by hour H is estimable from historical records.

2. **Conditional exceedance probability**: Given `observedMax` at `localHour`, the remaining potential rise follows an approximately log-normal distribution parameterised by:
   - Mean remaining rise: `(1 - fractionCompleted) × typicalDailyRange`
   - Std dev: calibrated from historical spread in same-month, same-hour regimes

3. **Output**: P(final max > threshold) = P(observedMax + remainingRise > threshold) — a standard tail-probability integral over the remaining-rise distribution.

### Example

- City: Hong Kong, June, bracket = 29°C (NO = "max < 29.5°C")
- At 14:00 local: `observedMax = 29°C`, `localHour = 14`
- Climatologically, HK June afternoons: 70% of the diurnal range is done by 14:00; max typically rises another 0.8°C (σ ≈ 0.5°C) from 14:00 to peak
- P(final max > 29.5) = P(29 + Remaining > 29.5) = P(Remaining > 0.5) ≈ 30%
- Therefore P(NO wins) = 30%, P(YES wins) = 70%
- Our model says NO is 99% likely; market correctly prices NO at 20%

With this function, the scanner can re-evaluate the position:
- Revised NO probability: 0.30
- Half-Kelly at 0.30 says exit (or strongly reduce)
- Action: sell held NO at market bid

---

## Data Sources

Both are publicly available and freely usable:

| Source | What | Format |
|--------|------|--------|
| **NOAA ISD Normals** (Global Surface Summary) | Per-station hourly climatological normals; monthly means and percentiles by hour | CSV / API |
| **ERA5 Climatology** (ECMWF Copernicus) | Gridded hourly 2m temperature normals, 1991–2020 | NetCDF / Zarr |
| **Open-Meteo Historical API** | Per-city hourly historical data back to 1940; same API we already use | JSON REST |

The simplest path is **Open-Meteo Historical**: we already have city coordinates and make API calls there. A one-time per-city, per-month precompute job can build a `diurnalCurve[city][month][hour]` lookup — the mean and std dev of the hourly fraction of the daily max observed at each hour of the day, built from 10–20 years of data.

The lookup table is small: ~30 cities × 12 months × 24 hours × 2 values = ~17,000 numbers, trivially stored as a JSON asset in `src/weather/data/`.

---

## Integration Points

| File | Change |
|------|--------|
| `src/weather/data/diurnalCurves.json` | New — precomputed per-city, per-month, per-hour curves |
| `src/weather/diurnalOracle.ts` | New — `conditionalFinalMaxProbability()` implementation |
| `src/weather/liveObservation.ts` | Call `conditionalFinalMaxProbability()` when `observedMax` is available; return `conditionalP` alongside `observedMax` |
| `src/weather/weatherDriftStrategy.ts` | When `conditionalP < DRIFT_ORACLE_SOFT_EXIT_THRESHOLD` (e.g., 0.40) AND `isResolutionDay` → exit |
| `src/shared/config.ts` | `WEATHER_DRIFT_ORACLE_SOFT_EXIT_ENABLED`, `WEATHER_DRIFT_ORACLE_SOFT_EXIT_THRESHOLD` |

---

## Why this subsumes Rec 3

Rec 3 (temperature at bracket boundary = soft oracle) was a heuristic: if `observedMax ∈ [bracket - 0.5, bracket + 0.5]` → exit. It would work but is city-blind and time-blind — the same observation at 10:00 vs 16:00 local has very different implications. The diurnal oracle gives the correct time- and city-aware probability, making the fixed-threshold heuristic unnecessary.

---

## Relationship to Existing Code

- The static morning model (Open-Meteo ensemble forecast) remains the entry signal. This does not replace it.
- The diurnal oracle is an **intraday exit signal only** — it runs in the drift scanner when `shouldFetchObs` is true and a live observation is available.
- It does not affect the entry sizing path, bracket selection, or the existing oracle certainty gate (which remains for the binary-certainty cases where it fires first).
