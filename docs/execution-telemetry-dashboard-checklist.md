# Execution Telemetry Dashboards — Checklist

This file mirrors the PM telemetry spec (2026-04-02) for PGA maker/hybrid execution observability.

## Dashboard 1 — Execution Operations
- Total executions by mode (24h/7d)
- Maker attempts vs maker fills vs fallbacks
- Skip reasons distribution
- Execution errors distribution
- Maker wait time avg / p95 / max
- Cancel unconfirmed count
- Final execution path distribution
- Hedge trigger success/failure count

Filters: time window, mode, venue, marketId, direction
Alerts: spike in maker_cancel_unconfirmed, drop in maker fill rate, spike in errors, spike in tail-filter skips, zero fills with nonzero maker attempts.

## Dashboard 2 — Execution Quality
- Avg spread at decision by mode
- Avg fill price vs immediate taker benchmark
- Price improvement distribution (maker vs taker)
- Fallback delay cost over time
- Fill rate by spread bucket
- Fill rate by edge bucket
- Fill rate by tail/non-tail bucket

Buckets:
- spread: 0–10bps, 10–25bps, 25–50bps, 50bps+
- edge: 0–5%, 5–10%, 10–20%, 20%+
- price: 0–0.2, 0.2–0.4, 0.4–0.6, 0.6–0.8, 0.8–1.0

## Dashboard 3 — Earnings / Strategy Impact
- Realized P&L by mode
- P&L per signal by mode
- P&L per executed trade by mode
- Win rate by mode
- Avg ROI by mode
- 5m and 30m markout by mode
- Missed-trade opportunity cost
- Saved-loss estimate from skip filters

Core summary panel:
- Hybrid net uplift vs taker-only baseline (entry improvement, missed-fill cost, delay cost, skip-filter effect)

## Dashboard 4 — Regime Analysis (recommended)
- P&L by mode and spread bucket
- P&L by mode and edge bucket
- P&L by mode and price bucket
- P&L by mode and market type/category
- Maker fill rate by regime
- Fallback rate by regime
