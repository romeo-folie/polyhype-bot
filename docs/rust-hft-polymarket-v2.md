# Rust HFT Bot for Polymarket Short-Dated Crypto Up/Down Markets

**Audience**: the LLM agent that will implement this project from scratch.
**Status**: design doc. You are the implementer. This file is self-contained — everything you need to begin implementation is either inline or linked to an authoritative external source.

---

## 0. Context

You are building a new, greenfield Rust project. There is **no existing codebase to read or inherit from**. All technical assertions in this doc are provided as facts you can rely on at the start, but you should still verify anything that looks load-bearing during Phase 0 (§12) before wiring the hot path around it. External APIs drift; treat Phase 0 as a cheap insurance policy.

This is a **specialist** system: it trades exactly one family of instrument — Polymarket short-dated (5-minute and 15-minute lifetime) "Up/Down" binary markets on BTC/USD and ETH/USD. It does not try to be a general-purpose Polymarket trader, and it does not try to trade anything else. Every architectural decision should be read through that lens: the hot path is the only path that matters.

The edge is **speed and correctness on a narrow, well-defined instrument**. You are competing against other latency-sensitive actors on Polymarket's CLOB. You will not outrun true colocated HFTs; you will outrun the median participant and capture mispricings that live for hundreds of milliseconds to a few seconds.

---

## 1. Mission and instrument

### 1.1 What these markets are

Polymarket lists binary "Up/Down" markets on major cryptos with short lifetimes. Each market asks: **"Will <asset>/USD be higher than <strike> at <resolution timestamp>?"** YES tokens pay \$1 if the Chainlink oracle price at resolution is strictly above the strike; NO tokens pay \$1 otherwise. The strike is set at market open to the then-current Chainlink price (or very close to it), so at open the market is essentially at-the-money.

Two lifetimes are in scope:

- **5-minute markets** (`5m`): opened every 5 minutes, resolved 5 minutes later.
- **15-minute markets** (`15m`): opened every 15 minutes, resolved 15 minutes later.

Two underlyings are in scope:

- **BTC/USD**
- **ETH/USD**

Other underlyings (SOL, XRP, DOGE, BNB, HYPE) exist on Polymarket in the same Up/Down family; the discovery layer should be parameterized so adding them later is a config-file change, not a code change. Do not wire them in for v2 launch.

### 1.2 Why this instrument

1. **Closed-form fair value.** A binary call on a liquid, high-frequency underlying is pricable with Black-Scholes over a very short horizon. σ is the only meaningfully-uncertain input, and it can be calibrated from the last ~1h of 1-second log returns on the underlying.

2. **Zero resolution basis risk.** Polymarket resolves these markets using its own rebroadcast of a specific Chainlink price feed. The same feed is available as a public WebSocket stream (see §3). That means the exact value that settles the market is observable to you in real time — so oracle-lag trades have no settlement-source slippage.

3. **Short lifetimes mean frequent, independent plays.** A 5-minute market gives you four shots per hour per underlying. Eight markets per hour, each with a fresh mispricing window, is enough volume to learn quickly from live PnL.

4. **Book is routinely mispriced vs fair value near expiry.** As τ → 0, the binary gamma explodes; small moves in the underlying produce large P(UP) deltas, and the book on Polymarket's CLOB does not always reprice inside the O(100ms) latency budget that beats the median counterparty. That gap is your edge.

### 1.3 Success criteria

- **Correctness first.** No silent money-losing bugs. Every order is either placed with a verified signature, funding, and intent, or it is not placed.
- **Observability second.** Every signal, every would-trade, every placed order, every fill, every rejection is recorded with timestamps precise enough to reconstruct latency after the fact.
- **PnL third.** A profitable shadow run followed by a profitable live run is the goal, but the first two are prerequisites. A feature that cannot be shadow-logged cannot be shipped.

---

## 2. Deployment target: Hetzner US

Run on a Hetzner Cloud box in **Ashburn, VA** (`us-east` region). Polymarket's CLOB and its WebSocket endpoints are fronted by AWS `us-east`; keeping the trader in the same metro region gets you single-digit-millisecond RTT to the public endpoints. (If the project later grows a colocation line-item, the architecture should not preclude a move; but design for Hetzner today.)

**Recommended instance**: `CCX23` (AMD dedicated vCPU, 4 vCPU, 16 GB RAM, ~\$30/mo). Dedicated vCPU matters because tail latency on shared-vCPU boxes spikes unpredictably under noisy neighbors, and tail latency is what you are selling.

**OS**: Debian 12 or Ubuntu 24.04 LTS. Enable:

- `net.core.busy_poll=50`, `net.core.busy_read=50` (reduces syscall path latency for TCP reads)
- `net.ipv4.tcp_nodelay=1` globally (plus explicit `TCP_NODELAY` on every socket — don't rely on sysctl alone)
- `net.ipv4.tcp_low_latency=1`
- `net.ipv4.tcp_fastopen=3`
- Disable CPU frequency scaling: `cpupower frequency-set -g performance`
- Pin the trading binary to specific cores with `taskset` or systemd `CPUAffinity=`; leave core 0 for the kernel and housekeeping.
- Run with `ulimit -n 65536`.

**Network**: use a single public IPv4. Do not put the trader behind NAT or a reverse proxy. Outbound TLS to Polymarket endpoints must go through the shortest possible path.

**Systemd**: one unit per long-running process (§10). `Restart=on-failure`, `RestartSec=2s`, `LimitNOFILE=65536`.

**Time sync**: `chrony` with `pool time.cloudflare.com iburst`. Check `chronyc tracking` in health checks — offset > 50ms should alarm.

**Disk**: use the default NVMe. Postgres (§9) lives here. Back up the data directory off-box nightly; the bot's durable state is the only thing you can't regenerate.

Hetzner gives you a solid baseline. What it doesn't give you is a kernel bypass network stack, a tuned NIC, or adjacency to the CLOB's matching engine. That's fine — the design bets that the gap between "median Polymarket participant" and "Hetzner Ashburn" is still wide enough to be profitable on this instrument.

---

## 3. Data sources (with URLs)

You will consume five external data sources. Each row below is the minimum you need to wire it up. Verify each URL in Phase 0 before building against it.

### 3.1 Polymarket CLOB REST

| Name | URL |
|---|---|
| Base host | `https://clob.polymarket.com` |
| Public docs index | `https://docs.polymarket.com` |
| LLM-optimized docs | `https://docs.polymarket.com/llms.txt` |
| REST API reference root | `https://docs.polymarket.com/api-reference` |
| Post order | `https://docs.polymarket.com/api-reference/trade/post-order` |
| Cancel order | `https://docs.polymarket.com/api-reference/trade/cancel-order` |
| Get order | `https://docs.polymarket.com/api-reference/trade/get-order` |
| Get open orders | `https://docs.polymarket.com/api-reference/trade/get-open-orders` |
| Get orderbook | `https://docs.polymarket.com/api-reference/market-data/get-orderbook` |
| Get midpoint | `https://docs.polymarket.com/api-reference/market-data/get-midpoint` |
| Get price | `https://docs.polymarket.com/api-reference/market-data/get-price` |
| Get trades | `https://docs.polymarket.com/api-reference/market-data/get-trades` |

Polymarket publishes both a Python and a TypeScript reference client. The Python client is the most authoritative source for EIP-712 order signing semantics (domain, typed struct, hashing):

- **Python CLOB client** (authoritative for signing): `https://github.com/Polymarket/py-clob-client`
- **TypeScript CLOB client** (secondary reference): `https://github.com/Polymarket/clob-client`

You will NOT use either client. You are writing the signing path in Rust using `alloy`. Read these clients as reference implementations only, and when in doubt prefer the Python one because its types are less abstracted.

### 3.2 Polymarket Gamma (markets/events metadata)

Gamma is Polymarket's markets/events metadata layer. It exposes the market definitions and the CLOB token IDs you need to subscribe to the CLOB WebSocket.

| Name | URL |
|---|---|
| Base host | `https://gamma-api.polymarket.com` |
| Events endpoint doc | `https://docs.polymarket.com/api-reference/events/get-events` |
| Markets endpoint doc | `https://docs.polymarket.com/api-reference/markets/get-markets` |

Important: **do not rely on `/events?query=...` or `/events?tag=crypto` to discover about-to-resolve Up/Down markets.** The query-string search on Gamma is effectively broken for this purpose — it returns stale results and misses markets that were just minted. Use slug prediction (§4) instead.

### 3.3 Polymarket CLOB WebSocket (market book + trades)

| Name | URL |
|---|---|
| WS market channel | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| Docs | `https://docs.polymarket.com/api-reference/wss/market-channel` |

**Subscription frame** (send once after the handshake completes):

```json
{"assets_ids": ["<clobTokenId1>", "<clobTokenId2>", ...], "type": "market"}
```

**Message types you will receive** (treat any JSON object without these fields as a no-op):

- `book` — full orderbook snapshot for a token. Fields include `asset_id`, `bids`, `asks`, each level as `{price, size}`.
- `price_change` — incremental price-level update. Fields: `asset_id`, `price` (string), `side`, `size`, `hash`.
- `last_trade_price` / `trade` — print tape. Fields include `asset_id`, `price`, `size`, `side`, `timestamp`.
- `tick_size_change` — the tick size on a market changed. Re-fetch the market metadata.

Reconnect with exponential backoff. Expect the connection to drop occasionally. On reconnect, re-send the subscription frame with the full set of tracked token IDs — do not assume the server remembers you.

### 3.4 Polymarket Chainlink rebroadcast (resolution truth, hot path)

This is the single most important data source. Polymarket publishes a WebSocket that rebroadcasts the exact Chainlink oracle prices used to resolve the Up/Down markets. Subscribing here means your view of the oracle is **identical to the settlement input** — zero basis risk.

| Name | URL |
|---|---|
| WS live-data | `wss://ws-live-data.polymarket.com` |

**Subscription frame**:

```json
{"action": "subscribe", "subscriptions": [{"topic": "crypto_prices_chainlink", "type": "update"}]}
```

**Message shape**:

```json
{
  "topic": "crypto_prices_chainlink",
  "type": "update",
  "payload": {
    "symbol": "btc/usd",
    "value": 123456.78,
    "timestamp": 1765432100000
  }
}
```

- `symbol` is lowercased, slash-separated (`btc/usd`, `eth/usd`, `sol/usd`, `xrp/usd`, `doge/usd`, `bnb/usd`, `hype/usd`).
- `value` is a JSON number (float).
- `timestamp` is the oracle publish time in milliseconds since epoch.

This stream is public and unauthenticated. It is the authoritative S in your Black-Scholes call. Direct Chainlink Data Streams is a theoretical alternative (and a cleaner upstream), but the Polymarket rebroadcast is the literal resolution source. Use it.

Sibling topic `crypto_prices` exists on the same WebSocket and carries non-Chainlink prices (Binance). You must filter on `topic == "crypto_prices_chainlink"` AND `type == "update"` to avoid mixing feeds.

### 3.5 Independent reference feeds (secondary / sanity)

You want at least one independent price feed that is not Polymarket's rebroadcast, so you can detect feed poisoning, outages, or oracle lag. Pick one or two of these and run them in parallel:

| Exchange | Docs | WS URL |
|---|---|---|
| Binance Spot | `https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams` | `wss://stream.binance.com:9443/ws` |
| Coinbase Exchange | `https://docs.cdp.coinbase.com/exchange/websocket-feed/overview` | `wss://ws-feed.exchange.coinbase.com` |
| Kraken v2 | `https://docs.kraken.com/api/docs/websocket-v2/ticker` | `wss://ws.kraken.com/v2` |

**Chainlink Data Streams** (direct upstream, as a documented option even if you don't use it at launch):

| Name | URL |
|---|---|
| Data Streams docs | `https://docs.chain.link/data-streams` |
| Mainnet WS | `wss://ws.dataengine.chain.link` |
| BTC/USD feed ID | `0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439` |
| ETH/USD feed ID | `0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782` |

For v2 launch: use Binance as the independent reference. Add Coinbase as a second one later if basis-risk detection proves useful.

---

## 4. Market discovery: slug prediction

Since the Gamma search endpoints are unreliable for these markets, you will **predict the slugs** of about-to-open Up/Down markets and fetch them directly by slug.

### 4.1 Slug format

Polymarket's Up/Down market slugs follow the pattern:

```
{asset_prefix}-updown-{lifetime}-{boundary_ts}
```

where:
- `asset_prefix` is the asset's short form (see map below).
- `lifetime` is `5m` or `15m`.
- `boundary_ts` is the resolution timestamp in Unix seconds, aligned to the lifetime cadence.

### 4.2 Asset prefix map

This map is authoritative for v2 launch. Hard-code it but keep it in a config file so you can extend it later without a rebuild.

```
bitcoin      -> btc
ethereum     -> eth
solana       -> sol
xrp          -> xrp
dogecoin     -> doge
bnb          -> bnb
hyperliquid  -> hype
```

For v2 launch you only use `btc` and `eth`.

### 4.3 Lifetime → cadence

```
5m  -> 300  seconds
15m -> 900  seconds
```

### 4.4 Discovery algorithm

Every ~1 second, for each (asset, lifetime) pair you are interested in:

1. Compute `current_window_start = floor(now_sec / cadence) * cadence`.
2. For `i` in `0 .. WINDOWS_AHEAD` (default 4): compute `boundary = current_window_start + i * cadence`.
3. Form the slug: `{prefix}-updown-{lifetime}-{boundary}`.
4. `GET https://gamma-api.polymarket.com/events?slug={slug}&closed=false` (or the equivalent single-event endpoint; the events endpoint accepts slug as a filter and returns the event if it exists).
5. If the event is returned, extract:
   - The market inside it (Up/Down events wrap a single binary market).
   - The `clobTokenIds` field — a JSON string that decodes to a 2-element array `[YES_token_id, NO_token_id]`. **It is a string inside the JSON, not a native array.** You must `JSON.parse` it (or the Rust equivalent).
   - The `outcomePrices` field — also a JSON string, decodes to `["<up_price>", "<down_price>"]`. Element 0 is UP, element 1 is DOWN.
   - The strike (parse it from the market's `question` text, or the market's metadata field if one is present — verify the shape in Phase 0).
   - The resolution timestamp (equals `boundary_ts` by construction).
6. Add the YES and NO `clobTokenIds` to the set of assets you're subscribed to on the CLOB WebSocket (§3.3).
7. Cache the `(slug, event)` mapping with a TTL slightly longer than the lifetime so you don't re-fetch the same slug repeatedly.

When a market's resolution timestamp passes, unsubscribe its token IDs from the CLOB WebSocket and drop it from your in-memory state.

### 4.5 Tag semantics

Gamma events carry tags; for Up/Down markets the lifetime tag is uppercase — `"5M"` and `"15M"`. If you ever fall back to tag-based filtering (e.g., for non-latency-critical backfill jobs), match on the uppercase form. For the hot path, stick with slug prediction.

---

## 5. Pricing: Black-Scholes binary with live σ

### 5.1 Closed form

For a binary call (YES = "price is above strike K at expiry"):

```
P(UP) = Φ( (ln(S/K) + (μ - σ²/2) * τ) / (σ * √τ) )
P(DOWN) = 1 - P(UP)
```

where:
- `S` is the current underlying price (from the Chainlink rebroadcast, §3.4).
- `K` is the strike from the market metadata.
- `τ` is time to expiry in years: `(resolution_ts_ms - now_ms) / (1000 * 60 * 60 * 24 * 365)`.
- `σ` is the annualized volatility estimate (§5.2).
- `μ` is the annualized drift. **Set `μ = 0`** — over a 5–15 minute horizon, drift is noise compared to σ and trying to estimate it will make the model worse, not better.
- `Φ` is the standard normal CDF. Use `statrs::distribution::Normal` in Rust.

### 5.2 σ calibration

Maintain a rolling window of the last **3600 seconds** of underlying prices from the Chainlink rebroadcast, sampled at ~1Hz. (Downsample the raw feed if it comes in faster than 1Hz; the aggregation window is your cadence.)

- Compute log returns: `r_i = ln(S_i / S_{i-1})`.
- Compute stdev of the last **N = 3600** log returns: `σ_1s`.
- Annualize: `σ = σ_1s * √(seconds_per_year)` where `seconds_per_year = 365 * 24 * 60 * 60 = 31_536_000`.

Recompute σ every new underlying tick (it's cheap — incremental moment updates). Maintain a per-underlying σ (BTC and ETH have very different vol).

**Vol bounds**: clamp σ into `[0.20, 5.00]` (annualized). Anything outside that range is a feed glitch. If clamping fires, log a warning and pause signal generation on that underlying for 60 seconds.

### 5.3 τ handling near expiry

When τ is very small (last ~30 seconds), `P(UP)` is extraordinarily sensitive to `S` — a 1-basis-point move in the underlying can flip P(UP) from 80% to 20%. This is where the edge lives, but also where the risk lives. Specifically:

- **Stop quoting new entries when `τ < 30s`.** Mark this as a hard config, `min_ttl_s_entry = 30`. Anything inside that window is too dangerous for maker entries: the book's gamma is higher than your signing + placement latency budget allows.
- **Stop quoting any exit maker offers when `τ < 10s`.** Inside 10 seconds, flatten with taker FAK exits only, or let the position run to settlement if it's the right side.
- **Flatten all open inventory at `τ = 5s`.** No exceptions. (§8)

### 5.4 Bid/ask mid reference

When computing "is the book mispriced vs fair value," always use the **top-of-book bid/ask mid** for the side you are evaluating, not the last-trade price. Last-trade is a stale print; mid is the current cost to cross the book. If the book is one-sided (no bid or no ask on YES), treat that side as "unpriced" and do not generate a signal on it for this tick.

---

## 6. Signal generation

Two independent signal families. Both are shadow-logged before live.

### 6.1 Fair-value signal (FV)

For each tracked market on each underlying tick:

1. Compute `p_model = P(UP)` per §5.1.
2. Read the YES book: top bid = `b_yes`, top ask = `a_yes`. Mid = `m_yes = (b_yes + a_yes) / 2`.
3. Compute edge: `edge = p_model - m_yes`.
4. If `|edge| >= FV_MIN_EDGE` and `τ >= min_ttl_s_entry`: emit a signal.
   - `edge > 0`: buy YES (or equivalently, sell NO).
   - `edge < 0`: buy NO (or equivalently, sell YES).
5. Size: half-Kelly on the edge, clamped to `MAX_STAKE_USD` and `MAX_INVENTORY_CONTRACTS_PER_MARKET`. (§7)
6. Venue: **maker-first** (§8.1). Post a limit at `m_yes + maker_edge_bps` inside the spread. FV signals have wider time budgets than oracle-lag and should prefer rebates.

`FV_MIN_EDGE` should start at **0.02** (2 percentage points). Retune after shadow.

### 6.2 Oracle-lag signal (OL)

For each new Chainlink tick (underlying price update):

1. Record `new_S` and its timestamp.
2. Compute `new_p_model = P(UP)` using `new_S`.
3. Compute `old_p_model` using the `S` from the previous tick.
4. Let `p_drift = new_p_model - old_p_model`.
5. Read the YES book mid `m_yes`. Let `m_drift = m_yes - previous_m_yes_at_previous_tick`.
6. If `|p_drift| >= OL_MIN_DRIFT` AND `sign(p_drift) != sign(m_drift)` (i.e., the book has NOT reflected the oracle move yet), emit a signal in the direction of `p_drift`.
7. Venue: **taker FAK** (§8.2). OL signals are speed plays — you are racing the book to catch up. Do not maker-post; you'll miss the window. Cross the spread with a FAK and accept the fee.
8. Size: fixed-per-signal (smaller than FV), clamped by `MAX_INVENTORY_CONTRACTS_PER_MARKET`.

`OL_MIN_DRIFT` should start at **0.015** (1.5 P(UP) points in a single oracle tick). Retune after shadow.

### 6.3 Signal dedup and cooldown

- Per `(market_id, signal_family)`, enforce a cooldown of `signal_cooldown_ms` (start: 1500 ms for OL, 3000 ms for FV) to prevent firing on the same condition multiple times.
- Per market, cap open inventory in contracts; reject a signal that would breach the cap.
- Per underlying, cap the total exposure across all markets on that underlying. (One bad hour on BTC should not wipe the account.)

### 6.4 Shadow mode

Every signal, whether or not it is acted on, is written to Postgres with a `would_trade: bool` flag. In shadow mode, no orders are posted — `would_trade` is always `true` for passes and the signal row is inserted, then the planned order stays unsent. In live mode, signals flow to the execution layer and the placement result is joined back to the signal row.

Shadow for **1–2 weeks minimum** before flipping live on either signal family. Flip FV first (tighter edge budget, slower, easier to reason about) and leave OL in shadow for another week.

---

## 7. Sizing and risk envelope

Risk limits are config (§9.3). These are the default values you should encode as the initial config:

```
max_stake_usd_per_trade        = 20
max_inventory_usd_per_market   = 80
max_inventory_usd_per_asset    = 300
max_total_inventory_usd        = 600
max_daily_realized_loss_usd    = 150
max_daily_gross_notional_usd   = 10_000
half_kelly_cap_fraction        = 0.5
```

- **Stake** is capped first by the Kelly formula and then by `max_stake_usd_per_trade`.
- Before placing, verify that the trade would not breach any of the inventory caps. If it would, clamp or reject (reject on OL; clamp on FV — OL is time-critical and a partial fill is worse than no fill).
- Track realized PnL per day (UTC). Once `max_daily_realized_loss_usd` is hit, the bot enters **flatten-and-halt**: cancel all open orders, flatten open positions at market, stop generating new signals for the rest of the UTC day.
- Track daily gross notional traded. Once `max_daily_gross_notional_usd` is hit, the bot halts new entries but allows exits.

Funding is assumed to be USDC.e on Polygon. Bankroll sizing is configurable; the defaults above are intentionally small so the first live week is a real test, not a gamble.

---

## 8. Execution

### 8.1 Maker-first path (FV signals)

1. Construct a GTC post-only limit order at `mid + maker_edge_bps * 1e-4` (inside the spread, on the aggressive side).
2. Sign (§8.3), post via `POST /order`.
3. Poll `/orders/{id}` every `maker_poll_ms` (default 250 ms) up to `maker_max_wait_ms` (default 8000 ms).
4. If filled → record fill, update inventory, done.
5. If not filled by the timeout → cancel (`DELETE /order`), and either reissue at a new mid (if signal is still valid) or drop the signal.
6. If the signal condition reverses during the poll (edge disappears), cancel immediately.

### 8.2 Taker FAK path (OL signals and forced exits)

1. Construct a Fill-or-Kill order that crosses the book by at least `fak_cross_bps` (default 30 bps past the opposing touch).
2. Sign, post.
3. Record the result synchronously from the POST response (FAK returns immediately with fill info; no polling loop).
4. If fill < requested size, accept the partial — do not retry in the same tick. The next tick will re-evaluate.

### 8.3 EIP-712 signing (alloy, Rust)

Polymarket orders are EIP-712 typed-data signatures. You will build this in Rust using `alloy` 1.8+. The Python CLOB client is the authoritative reference for the exact struct, domain, and hashing steps (§3.1 URL).

**Critical: there are TWO exchange contracts**, with **different verifying contract addresses**, and you must pick the right one per-market:

| Market type | Contract address |
|---|---|
| Standard (non-neg-risk) | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg-risk | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |

Using the wrong `verifyingContract` produces a valid-looking signature that the matching engine silently rejects or accepts as invalid. This is a silent class of bug — verify the chosen contract against the market's `negRisk` flag before every sign.

**Other fixed addresses**:

| Name | Address |
|---|---|
| Polygon chain ID | `137` |
| USDC.e on Polygon (funding) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| CTF (conditional tokens) | `0x4d97dcd97ec945f40cf65f87097ace5ea0476045` |
| Proxy wallet factory | `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052` |
| Relayer host (for proxy-wallet flows) | `relayer-v2.polymarket.com` |

**Signature types** — Polymarket supports three signer schemes, identified by a byte in the order struct:

- `0` = EOA (plain externally owned account)
- `1` = Polymarket proxy wallet (Magic / email login)
- `2` = Gnosis Safe

You will sign as type `0` (EOA) with an Ethereum private key loaded from env. Don't build the other two unless the funding setup forces it. Note: proxy-wallet (type 1) accounts do **not** use the standard ERC20 `approve` allowance flow for USDC — there's a separate relayer path. Type-0 EOA does use standard approvals, which is simpler. Stick with type 0.

**API credentials**: the CLOB requires a per-wallet API key/secret/passphrase set that is derived by calling `POST /auth/api-key` with a signed request. This endpoint is **rate-limited around 400 requests per day**. You must cache the derived credentials durably (Postgres, §9) and reuse them. A 23-hour TTL is a safe default. Losing the cache and spamming the endpoint will brick your signing path.

**Allowances (for EOA, type 0)**: before you can place your first order, the funding EOA must have approved:

1. USDC.e spending by the exchange contract.
2. The CTF (conditional tokens) for the exchange contract, `setApprovalForAll`.

Both are one-time on-chain transactions. Ship a CLI subcommand (`bot allowances check`, `bot allowances grant`) that reports current allowances and optionally sends the approve transactions. Run `check` at startup and refuse to start live trading if allowances are unset.

### 8.4 Order lifecycle and reconciliation

Every order goes through a state machine in Postgres (§9):

```
draft -> signed -> submitted -> { filled | partial | rejected | cancelled | expired }
```

- Every state transition is written before it is acted on, not after.
- The FAK path collapses `draft → signed → submitted → (filled|rejected)` into a single atomic insert on the response.
- The maker path writes `submitted` on the POST response, then `filled` / `cancelled` / `expired` as terminal states from the poll loop.
- On process restart: run a reconciliation pass against `GET /orders` (open orders by wallet) to see if any `submitted` orders are live on the venue and which have resolved since the last write. Emit a metric for every discrepancy.

### 8.5 Exit paths

- Take-profit / stop-loss are expressed in P(UP) space, not in USD. A TP/SL on "YES fill at 0.42 with strike 67000" is "exit when `p_model` computed from live S crosses 0.48 (TP) or 0.36 (SL)."
- Exits for OL-origin inventory use FAK.
- Exits for FV-origin inventory use maker-first with a tight timeout (2000 ms), falling back to FAK on timeout.
- **Hard flatten rule**: at `τ = 5s` on any market with open inventory, post FAK exits unconditionally. This is a kill-switch rule, not a signal.

---

## 9. State: Postgres

Use Postgres (not Redis) as the durable store. Postgres gives you transactions, real SQL for analytics, and a single source of truth. In-process state (DashMap, etc.) is a cache; Postgres is truth. On restart, Postgres is what the bot reads to reconstitute its view of open orders, positions, and σ history.

### 9.1 Schema (initial migration)

```sql
CREATE TABLE IF NOT EXISTS markets (
  market_id          TEXT PRIMARY KEY,        -- Polymarket condition_id
  slug               TEXT NOT NULL UNIQUE,
  asset              TEXT NOT NULL,           -- 'btc' | 'eth'
  lifetime           TEXT NOT NULL,           -- '5m' | '15m'
  strike             NUMERIC(20,8) NOT NULL,
  resolution_ts_ms   BIGINT NOT NULL,
  yes_token_id       TEXT NOT NULL,
  no_token_id        TEXT NOT NULL,
  neg_risk           BOOLEAN NOT NULL,
  tick_size          NUMERIC(10,6) NOT NULL,
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS markets_resolution_idx ON markets (resolution_ts_ms);
CREATE INDEX IF NOT EXISTS markets_asset_lifetime_idx ON markets (asset, lifetime);

CREATE TABLE IF NOT EXISTS ticks (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL,             -- 'chainlink' | 'binance' | 'coinbase'
  symbol          TEXT NOT NULL,             -- 'btc/usd' | 'eth/usd'
  price           NUMERIC(20,8) NOT NULL,
  source_ts_ms    BIGINT NOT NULL,           -- upstream timestamp
  received_ts_ms  BIGINT NOT NULL            -- local receive time
);

CREATE INDEX IF NOT EXISTS ticks_symbol_received_idx ON ticks (symbol, received_ts_ms DESC);

CREATE TABLE IF NOT EXISTS signals (
  id                 BIGSERIAL PRIMARY KEY,
  signal_family      TEXT NOT NULL,          -- 'fv' | 'ol'
  market_id          TEXT NOT NULL REFERENCES markets(market_id),
  side               TEXT NOT NULL,          -- 'yes' | 'no'
  p_model            NUMERIC(10,6) NOT NULL,
  m_yes              NUMERIC(10,6),
  m_no               NUMERIC(10,6),
  edge               NUMERIC(10,6) NOT NULL,
  tau_s              NUMERIC(10,3) NOT NULL,
  s_underlying       NUMERIC(20,8) NOT NULL,
  sigma_annual       NUMERIC(10,6) NOT NULL,
  would_trade        BOOLEAN NOT NULL,
  blocked_by         TEXT,                   -- NULL if would_trade, else reason
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signals_market_created_idx ON signals (market_id, created_at DESC);

CREATE TABLE IF NOT EXISTS orders (
  id                 BIGSERIAL PRIMARY KEY,
  signal_id          BIGINT REFERENCES signals(id),
  market_id          TEXT NOT NULL REFERENCES markets(market_id),
  token_id           TEXT NOT NULL,
  side               TEXT NOT NULL,          -- 'buy' | 'sell'
  order_type         TEXT NOT NULL,          -- 'gtc_post_only' | 'fak'
  price              NUMERIC(10,6) NOT NULL,
  size_contracts     NUMERIC(20,6) NOT NULL,
  status             TEXT NOT NULL,          -- 'draft' | 'signed' | 'submitted' | 'filled' | 'partial' | 'rejected' | 'cancelled' | 'expired'
  venue_order_id     TEXT,
  filled_size        NUMERIC(20,6) NOT NULL DEFAULT 0,
  avg_fill_price     NUMERIC(10,6),
  error              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_market_created_idx ON orders (market_id, created_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  market_id          TEXT PRIMARY KEY REFERENCES markets(market_id),
  token_id           TEXT NOT NULL,          -- the side we're holding
  size_contracts     NUMERIC(20,6) NOT NULL,
  avg_entry_price    NUMERIC(10,6) NOT NULL,
  realized_pnl_usd   NUMERIC(20,6) NOT NULL DEFAULT 0,
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fills (
  id                BIGSERIAL PRIMARY KEY,
  order_id          BIGINT NOT NULL REFERENCES orders(id),
  market_id         TEXT NOT NULL REFERENCES markets(market_id),
  size_contracts    NUMERIC(20,6) NOT NULL,
  price             NUMERIC(10,6) NOT NULL,
  fee_usd           NUMERIC(20,6) NOT NULL DEFAULT 0,
  venue_fill_id     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credentials_cache (
  wallet            TEXT PRIMARY KEY,
  api_key           TEXT NOT NULL,
  api_secret        TEXT NOT NULL,
  api_passphrase    TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS resolutions (
  market_id        TEXT PRIMARY KEY REFERENCES markets(market_id),
  resolved_price   NUMERIC(20,8) NOT NULL,
  winning_side     TEXT NOT NULL,            -- 'yes' | 'no'
  resolved_at      TIMESTAMPTZ NOT NULL,
  our_pnl_usd      NUMERIC(20,6)             -- NULL if no position
);
```

The `ticks` table is high-volume. Partition it by day and drop partitions older than 14 days as a cron task. (Use `pg_partman` or manual `DETACH` scripts.) σ is computed from the in-process ring buffer — the Postgres tick table is for post-hoc analysis, not the hot path.

### 9.2 Connection pool

`sqlx` with a pool size of 8. The hot path should not wait on Postgres — writes from the hot path go into an MPSC channel and a dedicated writer task drains it in batches. The hot path never `.await`s on `COMMIT`.

### 9.3 Config

Use `figment` or `config-rs` for config loading. Config file is TOML at `/etc/rust-hft/config.toml` with env-var overrides. All risk limits and signal thresholds are in config — no magic numbers in code.

```toml
[wallet]
private_key_env = "HFT_WALLET_PRIVATE_KEY"    # only read from env, never file

[database]
url_env = "HFT_DATABASE_URL"
pool_size = 8

[deployment]
mode = "shadow"                                # "shadow" | "live"

[assets]
enabled = ["btc", "eth"]
lifetimes = ["5m", "15m"]

[discovery]
windows_ahead = 4
poll_interval_ms = 1000

[pricing]
sigma_window_seconds = 3600
sigma_min_annual = 0.20
sigma_max_annual = 5.00
min_ttl_s_entry = 30
min_ttl_s_exit_maker = 10
hard_flatten_ttl_s = 5

[signals.fv]
min_edge = 0.02
cooldown_ms = 3000
signal_family = "fv"

[signals.ol]
min_drift = 0.015
cooldown_ms = 1500
signal_family = "ol"

[execution.maker]
edge_bps = 5
poll_interval_ms = 250
max_wait_ms = 8000

[execution.taker_fak]
cross_bps = 30

[risk]
max_stake_usd_per_trade = 20
max_inventory_usd_per_market = 80
max_inventory_usd_per_asset = 300
max_total_inventory_usd = 600
max_daily_realized_loss_usd = 150
max_daily_gross_notional_usd = 10000
half_kelly_cap_fraction = 0.5

[metrics]
prometheus_listen = "127.0.0.1:9090"

[tracing]
level = "info"                                 # "trace" | "debug" | "info" | "warn" | "error"
format = "json"
```

---

## 10. Processes and tasks (tokio)

Structure the binary as a single Rust process with several long-lived `tokio::spawn` tasks. One process = one connection state to reason about. Don't split into microservices for v2.

### 10.1 Tasks

1. **`chainlink_feed`** — holds the Polymarket live-data WebSocket (§3.4). On every tick: update in-memory underlying state, notify the `signal_engine` task.
2. **`reference_feed`** — holds one reference WS (Binance). On every tick: update a separate reference price cache used for outlier detection.
3. **`clob_book_feed`** — holds the Polymarket CLOB market WS (§3.3). On every update: update the in-memory book per asset_id, notify the `signal_engine`.
4. **`discovery`** — runs the slug-prediction loop (§4). On new market discovered: insert into Postgres, subscribe its token IDs on `clob_book_feed`, register it in the in-process market map.
5. **`signal_engine`** — consumes notifications from `chainlink_feed` and `clob_book_feed`, maintains per-market signal state, emits signals into `executor` (and into the `postgres_writer` for shadow).
6. **`executor`** — consumes signals, validates against risk (§7), signs (§8.3), POSTs to CLOB, tracks order state through the state machine, writes transitions to `postgres_writer`.
7. **`maker_poller`** — polls open maker orders, handles timeouts and cancels.
8. **`postgres_writer`** — the single task allowed to write to Postgres. Drains a bounded MPSC channel in 50ms-or-100-row micro-batches.
9. **`risk_manager`** — periodic (every 1s) task that recomputes risk state from positions and fills, exposes it via a shared `ArcSwap` that the `executor` reads on every signal.
10. **`position_reconciler`** — runs every 60s. Pulls `GET /orders` and compares to local `orders` table. Emits `reconciliation_drift` metrics on discrepancy.
11. **`resolution_worker`** — runs every 5s. For each market with `resolution_ts_ms < now` and no resolution row, fetch the resolved outcome, mark the position closed, compute realized PnL.
12. **`ttl_flattener`** — runs every 500ms. For each open position, check τ; at τ ≤ 5s, emit forced-flatten orders regardless of signal state.
13. **`metrics_server`** — serves Prometheus metrics on `127.0.0.1:9090` (§11).
14. **`health`** — serves `/healthz` on `127.0.0.1:9091`. Returns 200 iff all feeds are connected, last Chainlink tick age < 5s, reconciliation drift count == 0, Postgres writer queue depth < 1000.

### 10.2 Inter-task channels

- `chainlink_rx`: broadcast of latest tick per symbol. `tokio::sync::broadcast`.
- `book_rx`: broadcast of book updates keyed by token id. `broadcast` with large capacity (1024) — tolerate slow consumers by having them lag rather than block.
- `signal_tx → executor`: `mpsc` with bounded depth 256. If full, the signal engine drops the oldest and logs a warning — do not backpressure the feed tasks.
- `db_tx → postgres_writer`: `mpsc` with bounded depth 4096.

### 10.3 Graceful shutdown

On SIGTERM: stop accepting new signals, flush all in-flight orders to a known state (cancel open makers), drain `db_tx`, then exit. Target: < 3 seconds end to end.

---

## 11. Observability

### 11.1 Metrics (Prometheus, via `metrics` + `metrics-exporter-prometheus`)

- `chainlink_tick_age_seconds{symbol}` (gauge)
- `clob_ws_connected{feed}` (gauge)
- `clob_ws_reconnects_total{feed}` (counter)
- `signal_emitted_total{family,market,side,would_trade}` (counter)
- `signal_blocked_total{family,reason}` (counter)
- `orders_submitted_total{family,type}` (counter)
- `orders_filled_total{family,type}` (counter)
- `orders_rejected_total{family,type,reason}` (counter)
- `maker_fill_latency_ms` (histogram)
- `taker_fak_rtt_ms` (histogram)
- `sign_latency_ms` (histogram)
- `post_order_latency_ms` (histogram)
- `reconciliation_drift_total` (counter)
- `db_writer_queue_depth` (gauge)
- `pnl_realized_usd_total` (counter, can go negative — use a gauge if Prometheus rejects)
- `position_inventory_usd{asset}` (gauge)
- `risk_halt_active` (gauge, 0/1)

### 11.2 Tracing (`tracing` + `tracing-subscriber`)

JSON logs to stdout. Every log line carries `event`, `market_id`, `signal_id`, `order_id` where applicable. Log levels:

- `trace` — per-tick σ values, per-tick book snapshots. Off in prod.
- `debug` — per-signal details (shadow mode defaults to `debug` globally).
- `info` — lifecycle events: WS connect/disconnect, market discovered, order submitted, order filled.
- `warn` — recoverable errors: WS reconnect, maker timeout, reconciliation drift.
- `error` — unrecoverable: sign failure, DB write failure after retries, risk halt triggered.

### 11.3 External watchdog

Run a small second process **on a different host** (a \$5 VM is fine) that:

1. Pings `/healthz` on the trader every 30s.
2. If `/healthz` is red or unreachable for > 2 minutes, sends a Telegram/Discord/email alert.
3. On continued failure, has authority to call a "kill" endpoint (§11.4) on the trader that forces flatten-and-halt.

The watchdog exists because a trader that deadlocks inside its own health check is a silent disaster. An external observer catches what internal monitoring can't.

### 11.4 Kill endpoint

Expose `POST /admin/kill` on `127.0.0.1:9091`, authenticated by a shared secret header. Payload `{"reason": "..."}`. Effect: immediately transition to flatten-and-halt (cancel opens, FAK-flatten positions, refuse new signals until restart). This is callable by the watchdog, by a CLI subcommand (`bot kill`), or by an operator over SSH.

---

## 12. Phases and rollout

### Phase 0 — Verification (pre-code, ~2 days)

Before writing a line of Rust for the hot path, verify every external URL and data contract listed in §3 and §4 and §8.3. Use `curl`, `wscat`, and a one-off Rust binary as needed.

- [ ] Fetch `https://docs.polymarket.com/llms.txt` and skim it.
- [ ] `curl https://clob.polymarket.com/ok` (or whatever the liveness endpoint is per docs) and verify it's 200.
- [ ] Connect to `wss://ws-live-data.polymarket.com`, subscribe to `crypto_prices_chainlink`, confirm you receive messages for `btc/usd` and `eth/usd` with the payload shape in §3.4.
- [ ] Connect to `wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribe to one known CLOB token id (pick from a live market via Gamma), confirm you receive `book` and `price_change` messages.
- [ ] `curl https://gamma-api.polymarket.com/events?slug=btc-updown-5m-<some_recent_boundary>&closed=false` and confirm the response shape (especially that `clobTokenIds` and `outcomePrices` are JSON strings that need parsing).
- [ ] Read the py-clob-client source for the EIP-712 order struct. Write a Rust unit test that signs a fixed known payload and compare the output to what py-clob-client produces for the same inputs. They must match byte-for-byte. Do this for BOTH the standard and neg-risk exchange contracts.
- [ ] Verify the BTC/USD and ETH/USD feed IDs on Chainlink Data Streams if you intend to add that as a backup later. (Not launch-critical.)
- [ ] Pick a Hetzner box, install Debian, set the sysctls in §2, install Postgres, install rustup stable.
- [ ] Run a ping-and-RTT test from the Hetzner box to `clob.polymarket.com` and the WS hosts. Record the numbers — they are your latency budget baseline.

Exit criterion: every item ticked.

### Phase 1 — Read path, shadow only (~1 week)

- Implement `chainlink_feed`, `clob_book_feed`, `discovery`, and the in-memory market/book/σ state.
- Implement the pricing function (§5) and the signal engine (§6), shadow-only.
- Wire Postgres writes for `markets`, `ticks`, `signals`.
- Stand up metrics and tracing (§11).
- Run for a full week. Every day, check:
  - Signal rate per asset / lifetime / family. Is it plausible (dozens per hour, not zero or thousands)?
  - p_model vs mid distribution. Does it center around zero edge when the market is "correctly priced"?
  - σ values over time. Do they move plausibly? (e.g., σ_btc ≈ 0.6–1.2 annualized during normal regimes; spikes to 2.0+ on news.)

Exit criterion: signal rate looks sane, no schema surprises, no panics.

### Phase 2 — Write path, tiny live on FV only (~1 week)

- Implement the executor (§8), maker path, taker FAK path, EIP-712 signing.
- Implement the risk envelope (§7). All caps at half their §7 defaults.
- Implement reconciliation, resolution worker, ttl flattener.
- Flip FV signals to live. OL stays shadow.
- Max stake \$10 (half of §7 default). Max total inventory \$300.
- Run for at least 3 days before raising caps. Halt and debug on ANY `reconciliation_drift` or unexplained `orders_rejected`.

Exit criterion: at least 50 live FV trades closed to resolution, realized PnL tracks model expectation within 2σ, zero reconciliation drift.

### Phase 3 — Full FV + OL live (~1 week)

- Flip OL signals to live.
- Raise caps to §7 defaults.
- Tune `FV_MIN_EDGE` and `OL_MIN_DRIFT` based on Phase 2 data.

### Phase 4 — ETH expansion and σ refinement

- ETH has been running in shadow since Phase 1. Flip it live.
- Evaluate whether a single σ per underlying is good enough, or whether you need a regime-aware σ (e.g., a short-window σ that dominates during volatility spikes).

### Phase 5 — Consider

- Add Binance reference feed parity check; halt on basis > 50 bps for > 10s.
- Add Coinbase as a second reference.
- Explore other Up/Down underlyings from the map in §4.2 (SOL, XRP, DOGE) — one at a time, each gets its own shadow week.

---

## 13. Non-goals (v2)

- **No Hyperliquid.** No futures. No cross-venue hedging.
- **No OSINT / news signal.** Pure price + book.
- **No LLM calls anywhere in the hot path.** Offline analytics jobs may use LLMs for post-hoc labeling; the trader must not.
- **No multi-user or multi-account support.** One wallet, one process, one box.
- **No dashboards beyond Prometheus + Grafana.** A text `htop`-like CLI for inventory is fine; a React dashboard is not.
- **No market making.** You are taking and posting edge-seeking limits, not quoting both sides to earn the spread.
- **No non-crypto markets.** Up/Down on BTC and ETH only at launch.
- **No other lifetimes.** 5m and 15m only. (1h Up/Down markets exist; they have much slower dynamics and different edges — not in scope.)
- **No backtesting framework.** σ calibration and signal tuning happen on live shadow data. Building a sim is more work than 1 week of shadow and less informative.
- **No Redis.** Postgres is the only durable store. In-process state is the only cache.

---

## 14. Known CLOB / Gamma gotchas

Things that have cost real time in production Polymarket systems. Treat these as landmines.

1. **Neg-risk vs standard exchange have different `verifyingContract`.** If you pick the wrong one, the signature verifies locally against a different domain, gets POSTed, and is silently rejected with a confusing error. Always read `negRisk` from the market metadata before signing.
2. **`clobTokenIds` and `outcomePrices` on Gamma events are JSON strings, not arrays.** You have to parse them twice.
3. **Gamma returns `active: true` for markets whose `endDate` is in the past.** Always filter on `endDate > now` yourself.
4. **Gamma `/events?query=...` search is broken for about-to-resolve markets.** It returns stale results. Use slug prediction (§4).
5. **`/auth/api-key` is rate-limited around 400/day.** Cache credentials in Postgres for 23h. Losing the cache by accident and restarting the bot in a loop will brick you for a day.
6. **Proxy-wallet accounts (signature type 1) don't use standard ERC20 allowances.** If you're using a Magic-login proxy wallet, the USDC approval flow goes through a relayer, not a direct `approve()`. Avoid this; use an EOA (type 0).
7. **CLOB WebSocket does not remember your subscriptions across reconnects.** On every reconnect, re-send the full subscription frame.
8. **Last-trade price lags book mid.** Never use `last_trade_price` for pricing decisions. It's for post-hoc analytics only.
9. **Tick size can change on a market mid-life.** Listen for `tick_size_change` and re-fetch market metadata; don't cache tick size forever.
10. **Resolution is "strictly above" the strike.** Ties (S exactly equal to K at the oracle resolution tick) resolve NO. This affects how you compute P(UP) at τ → 0 — don't smooth the indicator.
11. **Chainlink rebroadcast is the resolution source, but the oracle tick that actually resolves the market is whichever tick the resolver picks up at the resolution timestamp.** You cannot assume your last-observed tick is the one that settles. Build the flatten rule around the ~5s window for this reason.

---

## 15. Reference manifest

Everything an implementer needs to bookmark, in one place.

### 15.1 Polymarket

- Docs: `https://docs.polymarket.com`
- LLM docs: `https://docs.polymarket.com/llms.txt`
- REST base: `https://clob.polymarket.com`
- Gamma base: `https://gamma-api.polymarket.com`
- CLOB market WS: `wss://ws-subscriptions-clob.polymarket.com/ws/market`
- Live-data WS: `wss://ws-live-data.polymarket.com`
- py-clob-client (authoritative EIP-712 reference): `https://github.com/Polymarket/py-clob-client`
- clob-client (secondary): `https://github.com/Polymarket/clob-client`

### 15.2 Addresses and IDs

- Polygon chain ID: `137`
- USDC.e: `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`
- CTF: `0x4d97dcd97ec945f40cf65f87097ace5ea0476045`
- Exchange (standard): `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`
- Exchange (neg-risk): `0xC5d563A36AE78145C45a50134d48A1215220f80a`
- Proxy wallet factory: `0xaB45c5A4B0c941a2F231C04C3f49182e1A254052`
- Relayer host: `relayer-v2.polymarket.com`

### 15.3 Independent price sources

- Binance Spot WS: `wss://stream.binance.com:9443/ws` (docs: `https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams`)
- Coinbase Exchange WS: `wss://ws-feed.exchange.coinbase.com` (docs: `https://docs.cdp.coinbase.com/exchange/websocket-feed/overview`)
- Kraken v2 WS: `wss://ws.kraken.com/v2` (docs: `https://docs.kraken.com/api/docs/websocket-v2/ticker`)

### 15.4 Chainlink Data Streams (backup/optional)

- Docs: `https://docs.chain.link/data-streams`
- Mainnet WS: `wss://ws.dataengine.chain.link`
- BTC/USD feed ID: `0x00037da06d56d083fe599397a4769a042d63aa73dc4ef57709d31e9971a5b439`
- ETH/USD feed ID: `0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782`

### 15.5 Rust crates (v2 launch stack)

- `tokio` (runtime, 1.x)
- `tokio-tungstenite` (WebSocket client)
- `reqwest` with `rustls` (HTTP client; no OpenSSL)
- `alloy` 1.8+ (Ethereum signing, keystore, ABI)
- `sqlx` with `postgres` + `runtime-tokio-rustls` (Postgres)
- `figment` (config)
- `serde` + `serde_json` (de/serialize)
- `statrs` (normal CDF for pricing)
- `dashmap` (lock-free in-memory state)
- `arc-swap` (risk state hot-read)
- `metrics` + `metrics-exporter-prometheus` (Prometheus)
- `tracing` + `tracing-subscriber` (structured logs)
- `anyhow` for error propagation at boundaries, `thiserror` for domain errors in the hot path.
- `chrono` for timestamp formatting at log boundaries; keep the hot path on `std::time::Instant` and `i64` millis.

---

## 16. Open questions (implementer should answer before or during Phase 0)

These are things the author of this doc deliberately did not pin down because the right answer depends on what you see during verification:

1. **Exact Gamma event endpoint for single-slug lookup.** The doc says `/events?slug=...`; verify whether that form exists or whether you need `/markets?slug=...` or a dedicated single-slug endpoint. Pick whichever returns the needed fields (`clobTokenIds`, `outcomePrices`, `negRisk`, `question`, `endDate`) in the fewest round-trips.
2. **Where the strike lives in the market metadata.** It may be parseable from `question` ("Will Bitcoin be above \$67,000 at …"), or it may be a first-class field. Verify in Phase 0 and prefer the first-class field if it exists.
3. **Exact EIP-712 struct field order and `salt`/`nonce` handling.** Cross-check with py-clob-client and match byte-for-byte.
4. **Post-only enforcement at the venue.** Some Polymarket order types are "post-only" meaningfully; some take-or-kill. Confirm in docs and in py-clob-client which flag maps to GTC post-only vs FAK, and which the matching engine actually respects.
5. **Whether 5m markets and 15m markets are always `negRisk: false` or always `true` or mixed.** The doc assumes mixed (so you have to branch); if they turn out to all be one or the other, the signing path simplifies.
6. **Minimum order size in contracts and the tick size grid.** Verify per-market. Don't hard-code.
7. **Expected message rate on each WS.** Phase 0 should capture a few minutes of each feed and note msgs/sec so you can size channel buffers sensibly.
8. **Whether `GET /orders` can filter by status efficiently.** If it can't, reconciliation needs to paginate — budget for that.

Answer these before, or while, implementing Phase 0. Don't guess; verify.
