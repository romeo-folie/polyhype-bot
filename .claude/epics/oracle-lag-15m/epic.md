---
name: oracle-lag-15m
status: backlog
created: 2026-04-11T15:17:03Z
updated: 2026-04-11T15:17:03Z
progress: 0%
prd: /home/romeo/.claude/plans/btc-updown-15m-oracle-lag.md
github:
---

# Epic: oracle-lag-15m

BTC Up/Down 15m oracle-lag sniper. Exploits Polymarket's ~55s reprice lag after Chainlink BTC/USD oracle updates by firing taker orders on the short-lifetime side matching the oracle move. Not prediction — pure latency arb against the *average* Polymarket trader (not colo bots).

**Full design doc**: `/home/romeo/.claude/plans/btc-updown-15m-oracle-lag.md` — treat this as the PRD. Do not re-derive strategy/rationale here; this epic is purely the implementation slice.

## Overview

- **Signal source**: Chainlink BTC/USD feed on Polymarket's RTDS WebSocket (`wss://ws-live-data.polymarket.com`, topic `crypto_prices_chainlink`, symbol `btc/usd`, no auth). Confirmed live 2026-04-11 to be the exact feed Polymarket uses as `resolutionSource` on 15m BTC Up/Down markets — no basis risk.
- **Market universe**: Polymarket BTC Up/Down 15m markets, discovered via Gamma `/events?tag=crypto` query, filtered by slug prefix `btc-updown-15m-` and `"15M"` tag. `endDate` is the resolution time.
- **Entry rules**: Chainlink move ≥0.07% over last 5s, ≥5min to resolution, market price on signal side ≤$0.62, fixed $5 stake.
- **Exit rules**: hold to resolution. No mid-trade exits.
- **Latency budget**: ~1s Chainlink→RTDS delivery + ~50ms CLOB order RTT (measured) = ~1.1s total loop, vs 55s reprice window. 50× safety margin.

## Architecture Decisions

- **New feed, not extending BinanceFeed** — different source, different semantics (no klines, just last-tick + move-over-window). A parallel `ChainlinkFeed` in `src/spot/feeds/` avoids polluting the existing Binance pipeline.
- **New scanner, not mode-flagging cryptoArbScanner** — the deprecated confluence-based UpDown path (`UPDOWN_ENABLED=false`) still exists in `cryptoArbScanner.ts` and will be removed later. Keeping oracle-lag as its own file makes rollback and dead-code removal trivial.
- **In-process ringbuffer, no Redis** — scanner and feed live in the same `pga-arb` container, so a local tick ringbuffer is enough. No need for cross-process Redis streams and the associated serialization/latency cost.
- **Reuse `updownThrottle.ts`** — the throttle, per-market lockout, and PnL-gated cooldown infra already exists from the previous Up/Down iteration. Shipping dark means no new throttle logic to write.
- **Reuse existing `executor.ts`** — oracle-lag signals route through the same executor, CLOB-only, with a pre-sized stake that bypasses Half-Kelly. Stake floor bump still applies.

## Technical Approach

### New files
- `src/spot/feeds/chainlinkFeed.ts` — WS subscriber with per-symbol ringbuffer + `getMoveSince(symbol, sinceMs)`, auto-reconnect, SIGTERM-safe.
- `src/arb/oracleLagScanner.ts` — tick loop, market discovery refresh (30s cadence), entry rule evaluator, shadow log, live log, entry firing path.

### Files modified
- `src/mapping/gamma.ts` — add `listUpDownMarkets({asset, lifetime, maxTimeToResolutionMin})` helper. Reuses the `/events?tag=crypto` query plumbing from `listRecentCryptoEvents`.
- `src/shared/config.ts` — Zod schema additions for 7 `ORACLE_LAG_*` env vars, all defaulting to shadow-safe values.
- `.env.example` — document the new env vars.
- `src/arb/worker.ts` — instantiate and start the oracle-lag scanner alongside the existing crypto arb scanner.

### Files untouched (by design)
- `src/arb/cryptoArbScanner.ts` — the deprecated UpDown path stays disabled (`UPDOWN_ENABLED=false`) until oracle-lag is proven. Do not delete yet.
- `src/arb/confluenceScorer.ts` — not relevant to this path; oracle-lag doesn't use TA.
- All futures / sports / copytrade code — unrelated.

## Implementation Strategy

**Execution waves** (see `.claude/ccpm/references/execute.md` for the parallel-stream pattern):

| Wave | Tasks | Wait for |
|---|---|---|
| 1 | 001, 002, 003 | nothing — all parallel, independent file scopes |
| 2 | 004, 006, 007 | wave 1 complete (004 needs 001+002+003; 006 needs 001; 007 needs 002) |
| 3 | 005, 008 | wave 2 (005 needs 004; 008 needs 004) |
| 4 | 009 | wave 3 (deploy + shadow start) |
| 5 | 010 | 24–48h of wall-clock shadow data from task 009 |

Wave 1 is the key parallelism win — three subagents building the feed, the discovery helper, and the config schema simultaneously in distinct files. Wave 2 starts the scanner as soon as its deps exist, with tests for subsystem 001 and 002 running in parallel since they're independent.

**No worktrees needed** — all file scopes are distinct within a single checkout, no conflicts possible. Worktrees would add ceremony with no payoff.

## Task Breakdown Preview

- [ ] 001.md — Chainlink RTDS feed subscriber (`src/spot/feeds/chainlinkFeed.ts`) — parallel
- [ ] 002.md — 15m market discovery helper (`src/mapping/gamma.ts`) — parallel
- [ ] 003.md — Oracle-lag config schema (`src/shared/config.ts` + `.env.example`) — parallel
- [ ] 004.md — Oracle-lag scanner (`src/arb/oracleLagScanner.ts`) — sequential (needs 001+002+003)
- [ ] 005.md — Worker wiring (`src/arb/worker.ts`) — sequential (needs 004)
- [ ] 006.md — Chainlink feed unit tests — parallel (needs 001)
- [ ] 007.md — Gamma discovery unit tests — parallel (needs 002)
- [ ] 008.md — Scanner entry-rule unit tests — parallel (needs 004)
- [ ] 009.md — Deploy + 24–48h shadow monitoring — sequential (needs 005+006+007+008)
- [ ] 010.md — Shadow review + flip/no-flip decision — sequential (needs 009 + wall-clock)

Total tasks: 10
Parallel-eligible: 6 (001, 002, 003, 006, 007, 008)
Sequential: 4 (004, 005, 009, 010)
Estimated effort: ~6h coding (compressed to ~2-3h with wave parallelism) + 24–48h shadow wall-clock.

## Dependencies

- `ws` npm package — already installed.
- `updownThrottle.ts` — already shipped, reused.
- `executor.ts` CLOB path — already working.
- Polymarket RTDS WebSocket — probed and confirmed working 2026-04-11.
- Gamma API `/events?tag=crypto` endpoint — confirmed working 2026-04-11.

## Success Criteria (Technical)

- Shadow log `[oracle-lag] shadow candidate` fires at least several times per hour during active US market hours.
- First ~20 wouldTrade=true events, spot-checked against actual 15m market resolutions, show win rate ≥55% (backtest claims 61.4%; ≥55% is our floor for flipping live).
- Measured oracle move distribution at fire time clusters ≥0.07% (not degenerate).
- Measured entry-price distribution clusters in $0.50–$0.62 range (breakeven WR stays ≤55%).
- `ORACLE_LAG_ENABLED=true` flip produces zero exceptions / errors in pga-arb logs for at least 4h of live trading.

## Out of Scope

- Multi-asset (ETH/SOL/XRP/DOGE/BNB/HYPE) oracle-lag — possible follow-up after BTC proves out.
- 5m market path — backtest says the reprice window eats too much of lifetime; fees break the math.
- Mid-trade exit logic — explicit design decision: hold to resolution.
- Anything touching futures, sports, or copytrade.
- Removing the deprecated confluence-based UpDown path — defer until oracle-lag is proven live.

## Estimated Effort

- **Active coding**: ~2-3h wall-clock with wave parallelism (6h sequential).
- **Shadow phase**: 24-48h wall-clock, minimal active attention.
- **Review + flip decision**: ~30min active.

## Rollback

`ORACLE_LAG_ENABLED=false` in `.env`, redeploy. Feature is isolated to its own scanner; no shared code paths with other trading flows. Scanner code can stay in-tree inactive.
