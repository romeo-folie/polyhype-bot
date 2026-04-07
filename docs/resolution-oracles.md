# Polymarket Resolution Oracles — Catalog & Arb Roadmap

**Generated**: 2026-04-07
**Source**: Live survey of 8000 active Polymarket markets via Gamma `/markets?active=true&closed=false` paginated, extracting `resolutionSource` field by category-keyword-derived buckets.

## Why this document exists

Every Polymarket market is settled by **UMA's Optimistic Oracle**, but UMA only adjudicates the answer — the *substantive* truth comes from whatever real-world source the market's `resolutionSource` field points to (a league standings page, a CME settlement page, a Chainlink price stream, etc.).

The arb edge in our `cryptoArbScanner.ts` worker comes from reading the same source faster than the marginal trader. To know which other verticals are worth building similar workers for, we need a complete inventory of which categories have machine-readable oracles vs which resolve on human consensus. This doc is that inventory.

## Methodology

1. Paginated `/markets?active=true&closed=false&limit=500` from offset 0 to 8000
2. For each market, classified by question-text regex into categories
3. For each category, counted markets with non-empty `resolutionSource` and aggregated unique URL domains
4. Cross-checked Chainlink stream addresses against the documented Polymarket UMA oracle binding

## Catalog

### Tier A — Machine-readable oracles (arb-able)

| Category | Markets | Oracle domain(s) | Cadence | Public API |
|---|---|---|---|---|
| **Sports — NHL** | 614 | `nhl.com/standings`, `nhl.com/awards`, `nhl.com/` | Per-game / per-period | NHL Stats API (free, JSON) |
| **Sports — NBA** | 401 | `nba.com/stats`, `nba.com/awards`, `nba.com/standings` | Per-game / per-quarter | NBA Stats API (free, JSON) |
| **Sports — NCAA** | 26 | `ncaa.com/` | Per-game | ESPN scoreboards |
| **Sports — Soccer (intl leagues)** | ~50 | `frmf.ma`, `efl.com`, `a-league.com.au`, `dimayor.com.co`, `anfp.cl`, `laliga.com`, `bundesliga.com`, `ligamx.net`, `ligue2.fr`, `tff.org` | Per-match | League-specific or ESPN |
| **Sports — Tennis** | 1 | `ausopen.com` | Per-set | ATP/WTA APIs |
| **Sports — Cricket** | 2 | `espncricinfo.com` | Per-over | Cricinfo API |
| **Sports — Hockey (intl)** | 2 | `khl.ru`, `theahl.com` | Per-game | League sites |
| **Esports — LoL** | 5 | `liquipedia.net` (League of Legends) | Per-match | Riot Games API |
| **Commodities — Gold** | 33 | `cmegroup.com/markets/metals/precious/gold.settlements.html` | Daily settlement (1:30pm ET) | CME public settlements |
| **Commodities — Silver** | 33 | `cmegroup.com/markets/metals/precious/silver.settlements.html` | Daily settlement (1:25pm ET) | CME public settlements |
| **Commodities — Crude oil** | 27 | `cmegroup.com/markets/energy/crude-oil/light-sweet-crude.settlements.html` | Daily settlement (2:30pm ET) | CME public settlements |
| **Equity index — S&P 500** | 30 | `finance.yahoo.com/quote/%5EGSPC` | 1-second during US hours | Yahoo Finance free |
| **Equity index — Nasdaq 100** | 23 | `finance.yahoo.com/quote/%5ENDX` | 1-second during US hours | Yahoo Finance free |
| **Crypto — BTC/ETH/SOL/XRP** | 54 | `data.chain.link/streams/{btc,eth,sol,xrp}-usd` | Per-block (~12s ETH) | Chainlink Data Streams |

**Total: ~1300 active markets** with a public, machine-readable oracle.

### Tier B — Human-consensus / no machine oracle (not arb-able, only news-arb-able)

| Category | Resolution mechanism |
|---|---|
| US politics | UMA + AP/state SoS calls + news consensus |
| Geopolitical | UMA + news consensus (Reuters/AP/AFP) |
| Macro / Fed | UMA + BLS/Fed/BEA press release reading |
| Tech / AI announcements | UMA + company press releases / blog posts |
| Court / legal | UMA + news consensus |
| Culture / mentions | UMA + transcript / video / social-media reading |
| Weather | (vertical discontinued by PM in 2024 — see roadmap Tier 3) |

These categories cannot be served by a sensor-arb worker. They are already served by our OSINT + LLM pipeline, which is itself a form of "news arb" — being faster than other humans at parsing the same press releases.

## Important nuance: crypto oracle is Chainlink, not Binance

Our `cryptoArbScanner.ts` trades against Binance WebSocket ticks because they're faster than Chainlink (Chainlink updates per-block, Binance updates per-tick). This is correct for **early arb entry** — Binance moves first.

But the **resolution** happens on Chainlink. If Binance and Chainlink disagree at the resolution moment (rare but possible during exchange-specific incidents), our position is settled on Chainlink, not Binance. For markets resolving in <60s this introduces a small basis risk that should be tracked. Mitigation: read Chainlink as a sanity-check before submitting orders that resolve in <5min.

## Recommended next arb verticals

Based on the catalog above, the two slots most analogous to "the article-2 weather worker, but on Polymarket" are:

### 1. Sports score arb (NBA / NHL first) — **highest priority**

- **Why**: 1015 active markets with machine-readable oracles, far more than any other category.
- **Edge source**: ESPN / league APIs publish per-play scoring updates in seconds. Polymarket order books on game props ("Will Team X win Q1?", "Will player Y score over 22.5 points?", "Will the game go to overtime?") often take 30s–2min to react to a scoring event because they depend on retail traders watching the game in real-time.
- **Architecture**: Same shape as `cryptoArbScanner.ts` — subscribe to per-play feed, match against live PM markets keyed to game/team/player ID, compute fair value (often deterministic for in-game settled props once the relevant event occurs), execute on edge > threshold.
- **Open question**: Does Polymarket allow trading in the final minutes before resolution? Some markets close the order book early. Spot-check before building.
- **Risk**: PM "in-play" sports markets are only listed for a subset of leagues, mostly NBA/NHL/NFL. Verify the daily-cadence inventory before committing engineering.

### 2. CME settlement arb (gold / silver / crude oil) — **second priority**

- **Why**: 93 active markets, daily settlement with publicly known fixing times. Strong analog to crypto-arb but on a slower clock.
- **Edge source**: CME settlement is computed from the volume-weighted average of trades during a fixed 1–2 minute window. As that window starts, the settlement value crystallizes faster than PM order books update. Trading in the final 5 minutes before settlement, as the VWAP becomes nearly deterministic, gives an edge similar to weather sensor arb but on a daily cadence.
- **Architecture**: Subscribe to CME (or proxy via Yahoo Finance commodity tickers — `GC=F`, `SI=F`, `CL=F`), monitor PM markets keyed to those CME settlement URLs, fire close to settlement window.
- **Cadence reality check**: ~250 trading days × 3 commodities = ~750 settlement events per year, vs crypto-arb's continuous 24/7 stream. Lower opportunity count but potentially higher per-trade edge because timing is more predictable.

### 3. Honorable mention — equity index settlement arb

- 53 markets resolved on Yahoo Finance ^GSPC / ^NDX. Free public quotes, 1-sec cadence during US hours.
- Smaller market count than sports or commodities, but cleaner oracle (single number vs settlement window math).
- Worth combining with the CME worker as "scheduled-fixing arb" with a shared codebase.

## What this means for the existing roadmap

- **Tier 4 (weather sensor arb)** stays **dropped** (Tier 3 NO-GO).
- **Tier 5** = this document.
- **Future work** should prioritize sports score arb as the highest-leverage next vertical, with CME/index settlement arb as a smaller secondary effort. Both fit the same architectural pattern as `cryptoArbScanner.ts` and would slot into `src/sports/` and `src/settlement/` worker directories respectively.
- **Crypto-arb basis risk** (Binance vs Chainlink at resolution) should be filed as a follow-up sanity check inside the existing scanner.

## Methodology limitations

- Survey only covers `active=true&closed=false` markets. Markets in pending-resolution or recently-closed states are excluded — the actual catalog of oracle types may be slightly larger.
- Category-keyword regex classification can misattribute markets (e.g. "Carolina Hurricanes" matched both `sports` and `weather` initially). Classifier was tuned to prefer the more specific category.
- `resolutionSource` is a free-text field set by the market creator. Some creators leave it blank even when a clear oracle exists. Verticals reporting "0" should be treated as "no machine oracle dominant", not "literally none".
- This is a snapshot. Polymarket adds and discontinues verticals (see weather). Re-run the survey before committing engineering to a new vertical.
