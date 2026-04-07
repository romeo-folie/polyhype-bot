# Data Sources & Telegram Channels per Vertical

**Generated**: 2026-04-07
**Context**: Follow-up to [resolution-oracles.md](./resolution-oracles.md). For each machine-readable vertical surfaced in the catalog (sports, commodities, equity index), this doc lists the concrete APIs to poll/subscribe to and the 1–2 Telegram channels most likely to give us a news-edge on top of the raw oracle feed.

Scope note: this is a **plan**, not yet shipped. None of these sources are wired into workers or the Telegram monitor config yet. Revisit after session compaction to decide whether to ship channel additions as a small Telegram-config commit or wait until the respective scanners are built.

---

## 1. Polymarket CLOB order flow (priority #1)

**Why this leads**: it's on-venue (we already trade here), it's free, and it unblocks problems we currently can't solve from any other source — including the Tier 1b copytrade EV blocker we hit earlier this session.

### Primary data source

- **Polymarket CLOB WebSocket** — `wss://ws-subscriptions-clob.polymarket.com/ws/market`
  - `market` channel: live book deltas (bid/ask level changes) per token ID
  - Subscribe to all watchlist token IDs (cached in `watchlist:market_cache`)
  - Free, public, no auth for the `market` channel
- **CLOB REST `/trades`** — historical tape per market, used for backfill / whale-stats reconstruction

### What it unlocks (in priority order)

1. **Live whale shortlist from raw tape** — every CLOB trade prints maker/taker addresses. Aggregate by address over rolling 7d → real EV / payout / win-rate stats with no dependency on the broken leaderboard API. **This finally unblocks Tier 1b properly.**
2. **Adverse-selection guard before entry** — if a market we're about to bet YES on just absorbed a $50k YES sweep from an unknown wallet, that's either confirmation (piggyback) or someone who knows something we don't. Today we walk in blind.
3. **Real liquidity vs snapshot liquidity** — the 20% book depth gate in `divergenceCalculator.ts` reads a single REST snapshot. Streaming deltas reveal effective depth over time and detect spoofing (large quotes that get pulled before fill). PM has real spoofers.
4. **Maker fill quality (Tier 1a follow-up)** — hybrid execution posts limit orders inside the spread and polls every 1s. With live book deltas we'd know queue position, detect leapfrogs, and reprice defensively instead of waiting out the timeout.
5. **Live "money flowing where" leaderboard** — aggregate buy-side notional across all watchlist markets in 5/15/60min windows. Today we only see this retroactively when the watchlist cron refreshes (hours stale).
6. **News-arrival detection without the news** — a sudden one-sided burst on a quiet politics market is often the first sign something broke 30–120s before it hits RSS/Telegram. Closest thing to insider alpha a public API gives.

### What it does NOT help with

- Futures trading on Hyperliquid (different venue)
- Oracle / resolution arb (upstream of PM)
- LLM calibration issues (e.g. extreme-price distrust gate)

### Architecture sketch

- New worker `src/clob/flowMonitor.ts` — same shape as `binanceFeed.ts`, single WS connection, subscribes to all watchlist token IDs, publishes to `clob:book_delta` and `clob:trade` Redis Pub/Sub channels.
- New Docker service `pga-clob-flow` in `docker-compose.yml`.
- Capped Redis ring buffers per market: `clob:tape:{marketId}` (last 1000 prints), `clob:book_state:{tokenId}` (current best bid/ask + size).
- New voter `clob_flow_imbalance` in `src/arb/confluenceScorer.ts` — gates OSINT-sourced PM trades on rolling buy/sell aggressor imbalance.
- New module `src/copytrade/tapeBasedShortlist.ts` — rebuilds whale EV stats from CLOB tape, replaces leaderboard-API path. Unblocks Tier 1b.
- New env vars: `CLOB_FLOW_ENABLED`, `CLOB_FLOW_WHALE_MIN_NOTIONAL`, `CLOB_FLOW_IMBALANCE_WINDOW_S`, `CLOB_FLOW_GATE_THRESHOLD`.

### Telegram channels

None needed — the tape itself is the signal. CLOB flow is a pure on-chain data ingestion play.

### Open questions before building

- Subscription cap: does the WS server limit how many token IDs one connection can subscribe to? Spot-check with 100 / 500 / all watchlist markets.
- Reconnection / sequence-gap handling: do book deltas have a sequence number for gap detection? If not, periodic snapshot reconciliation needed.
- Storage cost: capped ring buffers in Redis are cheap, but tape-based whale stats may want a longer history. Consider SQLite spillover for the 7d aggregation if Redis memory becomes an issue.

---

## 2. Sports score arb — NBA / NHL (Tier 5 priority #1)

### Primary data sources

- **ESPN undocumented JSON endpoints** (free, no auth, ~3–8s per-play latency):
  - NBA scoreboard: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard`
  - NBA per-game summary: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={gameId}`
  - NHL scoreboard: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard`
  - NHL per-game summary: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event={gameId}`
  - Returns play-by-play, box scores, player stats, period/quarter scores. Updates within seconds of actual play.
  - Undocumented → zero SLA. Build defensively (retry + fallback to official).

### Secondary (sanity / fallback)

- **Official NHL API** (free, public, documented): `https://api-web.nhle.com/v1/score/{YYYY-MM-DD}` and `https://api-web.nhle.com/v1/gamecenter/{gameId}/play-by-play`
- **Official NBA Stats API** (free but finicky): `https://stats.nba.com/stats/scoreboardv3` — requires `User-Agent: Mozilla/5.0` and `Referer: https://www.nba.com/` headers or it 403s.

### Telegram channels

- **@ShamsCharania** — ESPN's NBA insider. Breaks lineup changes, DNPs, and injury updates 1–3 hours before tip. This is where most NBA per-game profit comes from, not in-play scoring.
- **@NHLrumours** — NHL scratches / goalie confirmations. Same pre-game edge pattern.

### Edge thesis

- ESPN scoring events publish in ~3–8s; PM in-play markets on game props ("Team X wins Q1?", "Player Y over 22.5 pts?", "Game goes to OT?") lag 30s–2min because they depend on retail traders actually watching the game. That lag is the arb window.
- **Pre-game injury news is bigger than in-play**: when Shams tweets "[Star] is OUT tonight", player prop markets take 10–60s to adjust. First-mover wins.

### Open questions before committing engineering

- Does PM keep the order book open through the final minutes of a game, or does it close early? Spot-check before building.
- Which PM sports markets are actually liquid? The 1015 count in the catalog is a ceiling — true liquid count is likely lower.

---

## 3. CME settlement arb — gold / silver / crude (Tier 5 priority #2)

### Primary data sources

- **Yahoo Finance commodity futures tickers** (free, ~1s cadence, already wired in `src/spot/poller.ts`):
  - Gold front-month: `GC=F`
  - Silver front-month: `SI=F`
  - WTI crude front-month: `CL=F`
  - Brent crude: `BZ=F` (bonus, not in PM catalog but useful for confirmation)
  - Endpoint shape: `https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?interval=1m&range=1d`
  - Reuse existing poller — no new infrastructure needed.

### Secondary (post-trade reconciliation only)

- **CME settlement pages** — the actual PM resolution source:
  - Gold: `https://www.cmegroup.com/markets/metals/precious/gold.settlements.html`
  - Silver: `https://www.cmegroup.com/markets/metals/precious/silver.settlements.html`
  - Crude: `https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.settlements.html`
  - HTML scrape, updated once per day post-settlement. Use for reconciliation/audit, not real-time edge.

### Known settlement windows (ET)

- Silver: 1:25pm ET daily
- Gold: 1:30pm ET daily
- Crude: 2:30pm ET daily

### Scheduled catalysts (cadence macro-arb)

- **EIA Weekly Petroleum Status Report** — Wed 10:30am ET. Crude inventory surprises move WTI 1–3% in 30s.
- **OPEC+ meetings** — irregular, announced weeks in advance, can be 5%+ single-candle moves.
- **US CPI** — 8:30am ET on release day, moves gold 1–2%.
- **FOMC decisions** — 2:00pm ET + 2:30pm ET presser, moves gold 2–4%.

### Telegram channels

- **@WatcherGuru** — breaking macro / markets / crypto headlines. Covers Fed, CPI, OPEC, commodities. Low signal-to-noise but fast.
- **@FirstSquawk** — professional trader newswire; cleaner signal than WatcherGuru, lower volume. Covers central banks, OPEC, EIA, geopolitical energy events.

### Edge thesis

- Trade into the final 5 minutes before the settlement window — as the VWAP becomes nearly deterministic, PM markets keyed to the settlement number haven't yet repriced.
- Roughly 250 trading days × 3 commodities = ~750 settlement events/year. Much lower volume than crypto-arb (24/7) but predictable timing and potentially higher per-trade edge.

---

## 4. Equity index settlement arb — S&P 500 / Nasdaq 100 (honorable mention)

### Primary data sources

- **Yahoo Finance equity index futures** (free, ~1s cadence, lead cash by ~200ms):
  - S&P 500 futures: `ES=F` — **use instead of `^GSPC`** (futures lead cash on news)
  - Nasdaq 100 futures: `NQ=F` — **use instead of `^NDX`**
  - Cash index (for final resolution sanity): `^GSPC`, `^NDX`
- **Finnhub free tier** (`https://finnhub.io/api/v1/quote?symbol=...`) — failover if Yahoo rate-limits; free tier allows 60 req/min.

### Telegram channels

- **@WatcherGuru** — already listed under commodities; reuse.
- **@unusualwhales** — options flow / unusual activity; frequently front-runs index moves on known macro releases.

### Edge thesis

- Smaller market count (53) than sports or commodities, but cleaner oracle — single number (close print) vs VWAP settlement window math.
- Combine with CME worker into a shared `src/settlement/` scanner — both are "scheduled-fixing arb" with identical architecture, just different fixing times and tickers.

---

## Cross-cutting recommendation: minimum Telegram set

Adding all channels above = 4 new subscriptions. The minimum viable set for 80% coverage is:

1. **@WatcherGuru** — covers commodities + equity index macro
2. **@ShamsCharania** — covers NBA (the single largest unexploited oracle slot)
3. **@FirstSquawk** — cleaner macro newswire than WatcherGuru for high-conviction gating

Skipping: @NHLrumours (NHL is smaller than NBA), @unusualwhales (overlap with WatcherGuru for index moves).

Note: the telegram category classifier (`src/ingestion/categoryClassifier.ts`) already supports keyword-based routing — new channels would need category keywords appended (sports, commodities, macro-equity) but no new architecture.

---

## Shipping plan (post-compaction decision)

Two options:

1. **Ship channels now** as a small Telegram-config + classifier keyword commit. Benefit: immediately start accumulating a signal corpus we can backtest against before the scanners exist. Cost: noise in the news pipeline without downstream consumers.
2. **Wait** until the sports/commodities scanners are built, add channels alongside. Benefit: no premature noise. Cost: no historical corpus when we start backtesting.

Recommendation was option 1, but deferred to user after compaction.

## What is NOT in this plan

- Politics / geopolitical / macro-text / tech-announcement verticals — these have no machine oracle (see resolution-oracles.md Tier B). Already served by the OSINT pipeline.
- Crypto basis-risk sanity check (Binance vs Chainlink) — tracked separately as a follow-up inside the existing `cryptoArbScanner.ts`.
- Tier 6 market-making — deferred.
