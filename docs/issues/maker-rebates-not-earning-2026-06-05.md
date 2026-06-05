# Maker Rebate Farmer Audit: active but not earning

**Date observed:** 2026-06-05  
**Affected job:** `src/cron/rebateFarmer.ts` (`cron:rebate`)  
**Runtime status:** enabled in `.env` and running every 5 minutes  
**Primary issue:** orders are being placed and stale-cancelled, but not filled; no maker rebates accrue without filled maker liquidity.

---

## Current Polymarket rebate requirements

Current Polymarket docs describe maker rebates as a filled-maker-liquidity program, not a resting-liquidity scoring program.

Relevant requirements:

- Eligible orders must add liquidity to the book and then get filled by another trader.
- Rebates are proportional to the maker's share of executed fee-equivalent liquidity in each eligible market.
- Eligible markets are fee-enabled markets. Polymarket docs say `feesEnabled=true` marks markets with fee parameters.
- Rebate rates vary by category:
  - Crypto: 20%
  - Sports, Finance, Politics, Economics, Culture, Weather, Other / General, Mentions, Tech: 25%
  - Geopolitics: fee-free, no maker rebate
- Makers are not charged fees; taker fees fund the rebate pool.
- Minimum accrued payout is `$1`.
- Global Polymarket docs describe rebates as paid daily; Polymarket US docs describe maker rebate application at the point of trade. This repo is using the global `.com` CLOB path, so use the global daily payout model unless the exchange account/context says otherwise.

Sources checked:

- https://docs.polymarket.com/market-makers/maker-rebates
- https://docs.polymarket.com/polymarket-learn/trading/fees
- https://docs.polymarket.com/api-reference/rebates/get-current-rebated-fees-for-a-maker
- https://docs.polymarket.us/fees

---

## Observed runtime state

The farmer is active:

```env
REBATE_FARMING_ENABLED=true
REBATE_SKIP_FEE_MARKETS=false
```

Recent logs show repeated cycles like:

```text
[rebate] market selection complete ... preFiltered=3 ... selected=3
[rebate] placing resting order ... marketId=703257 ... direction=NO ... price=0.02 ... sizeUsd=5.00
[rebate] cycle complete ... filled=0 ... partialFills=0 ... staleCancelled=1 ... newOrdersPlaced=1
```

Redis state at audit time:

```text
HGETALL rebate:stats
orders_placed 2204
stale_cancels 2201
```

No `fills` or `partial_fills` counters were present.

Tracked live order at audit time:

```json
{
  "marketId": "703257",
  "question": "Will the US confirm that aliens exist before 2027?",
  "direction": "NO",
  "price": 0.02,
  "sizeUsd": 5
}
```

This means the job is functioning mechanically, but the observed strategy is mostly placing low-probability/far-from-execution bids that expire stale. That does not earn maker rebates.

---

## Findings

### 1. Post-only flag is wired incorrectly

`src/rebate/orderManager.ts` asks for post-only placement:

```typescript
await submitClobLimitBuy({
  ...
  orderType: 'GTC',
  postOnly: true,
});
```

But `src/shared/clob.ts` passes the arguments to `createAndPostOrder` as:

```typescript
client.createAndPostOrder(
  order,
  options,
  OrderType.GTC,
  false,
  input.postOnly ?? false,
)
```

The installed `@polymarket/clob-client-v2@1.0.2` signature is:

```typescript
createAndPostOrder(userOrder, options, orderType = "GTC", postOnly = false, deferExec = false)
```

So the wrapper sends:

- `postOnly=false`
- `deferExec=true`

Evidence: failed CLOB requests in `rebate.log` show request body fields with `postOnly:false` and `deferExec:true`.

Impact:

- The code's "post-only" safety assumption is false for this SDK version.
- If a calculated limit crosses due to stale book data or a race, it can become taker-like behavior instead of being rejected as post-only.
- The farmer may still often rest because prices are far below ask, but this is accidental, not enforced.

Fix:

```typescript
client.createAndPostOrder(
  order,
  options,
  OrderType.GTC,
  input.postOnly ?? false,
  false,
)
```

Apply the same fix to `submitClobLimitSell` if it has the same positional argument pattern.

Add tests that assert `submitClobLimitBuy({ postOnly: true })` calls the SDK with `postOnly=true` and `deferExec=false`.

---

### 2. Default config skips eligible fee markets

`src/shared/config.ts` defaults:

```typescript
REBATE_SKIP_FEE_MARKETS: boolFromEnv.optional().default(true),
```

The comment says:

```typescript
// Skip fee-enabled markets (rebate economics differ on fee markets).
```

This default is backwards for maker rebates. Current Polymarket docs say eligible maker rebate markets are fee-enabled markets.

Runtime `.env` overrides this correctly with `REBATE_SKIP_FEE_MARKETS=false`, but the repo default and `.env.example` are unsafe.

Impact:

- A fresh deployment with defaults would avoid the markets that can pay maker rebates.
- Documentation and code comments encode stale economics.

Fix:

- Replace the boolean with a positive gate, e.g. `REBATE_REQUIRE_FEE_MARKETS=true`.
- In selection, require `market.feesEnabled === true` unless an explicit exploratory mode is enabled.
- Update `.env.example`, README, and config comments.

---

### 3. Rebate economics comments are stale

Multiple comments/docs say Polymarket distributes 100% of taker fees to makers.

Examples:

- `src/cron/rebateFarmer.ts`
- `src/shared/config.ts`
- README rebate section

Current docs say maker rebate percentages vary by category and are currently 20% or 25% for listed fee-enabled categories. Geopolitics is fee-free.

Impact:

- Strategy assumptions like "structurally positive" and "+1.12% per trade" are not defensible from current docs.
- Backtests or sizing decisions based on 100% redistribution will overstate expected value.

Fix:

- Replace 100% language with category-specific rebate percentages.
- Add a conservative expected rebate estimate:

```text
fee_equivalent = shares * takerFeeRate * price * (1 - price)
expected_rebate = fee_equivalent * makerRebateShare
```

This is only an estimate; actual daily rebate is pool/share based per market.

---

### 4. Market selection optimizes for high lifetime volume, not current fill probability

`src/rebate/marketSelector.ts` scores:

```typescript
score = volume * (10000 / spreadBps)
```

It then chooses the majority side:

```typescript
const direction = yesPrice >= 0.50 ? 'YES' : 'NO';
```

The observed active market has high volume/liquidity but the bot is posting NO at `0.02` on a long-dated market. That is unlikely to be taken often.

Impact:

- The strategy creates book presence but not executed maker liquidity.
- Since rebates require fills, this produces churn without earnings.

Fix:

- Rank by recent taker flow, not just cached lifetime volume.
- Use CLOB trades or market activity to estimate recent fills per token/side.
- Prefer markets where the bot can quote near the touch with realistic fill probability.
- Add a minimum expected rebate-per-hour threshold before placing.
- Consider excluding long-dated low-price tails unless the bot has a real model for inventory risk.

---

### 5. The farmer posts only one side and only buys inventory

The rebate farmer only calls `submitClobLimitBuy`. It does not maintain two-sided quotes.

Maker rebates require filled maker liquidity, so one-sided orders can qualify if filled, but two-sided quoting improves:

- Fill opportunities
- Inventory management
- Liquidity rewards eligibility if this strategy is later combined with LP rewards

Impact:

- The bot accumulates directional exposure when filled.
- It has no built-in inventory-aware quote management.
- It misses half of the natural maker opportunities.

Fix:

- Add an inventory-aware two-sided mode:
  - bid the side you are willing to accumulate
  - offer existing inventory when held
  - size quotes based on max inventory per market/category
- Keep a strict post-only requirement.
- Add a cancellation/reprice loop based on book movement, not only fixed TTL.

---

### 6. Logging leaks sensitive CLOB request headers on SDK errors

`rebate.log` includes raw SDK request-error payloads on order timeout. The logged Axios config includes CLOB auth header fields.

Impact:

- The log file should be treated as sensitive.
- If logs are shipped or shared, credentials may be exposed.

Fix:

- Redact SDK error configs before logging.
- Avoid logging `POLY_ADDRESS`, `POLY_SIGNATURE`, `POLY_API_KEY`, `POLY_PASSPHRASE`, request body signatures, and order signatures.
- Rotate the existing log after deploying the redaction.
- Consider rotating API credentials if the log has left the machine or is backed up to shared storage.

---

## Required fixes

### P0

1. Fix `createAndPostOrder` argument order in `submitClobLimitBuy`.
2. Audit and fix `submitClobLimitSell` for the same positional argument issue.
3. Add unit tests for post-only/defer-exec argument mapping.
4. Redact raw CLOB SDK error output and rotate `rebate.log`.

### P1

1. Change config from `REBATE_SKIP_FEE_MARKETS` to `REBATE_REQUIRE_FEE_MARKETS`, defaulting to true.
2. Update README/config comments to current 20%/25% category rebate docs.
3. Add market-selection telemetry:
   - `feesEnabled`
   - `feeType`
   - selected category
   - quoted side
   - best bid/ask
   - expected fee-equivalent at quote price
4. Add runtime stats for:
   - fill rate per market
   - stale-cancel rate per market
   - average order lifetime
   - estimated rebate accrued

### P2

1. Replace lifetime-volume selection with recent executed-flow selection.
2. Add two-sided/inventory-aware quote management.
3. Add a rebate API checker using:

```text
GET https://clob.polymarket.com/rebates/current?date=YYYY-MM-DD&maker_address=0x...
```

4. Emit a daily summary comparing:
   - expected rebate
   - API-reported rebate
   - actual payout / activity entry

---

## Verification plan

1. Unit tests:
   - `submitClobLimitBuy` maps `postOnly=true` to SDK arg 4 and `deferExec=false` to arg 5.
   - `submitClobLimitSell` does the same.
   - market selector excludes `feesEnabled=false` markets when rebate farming is in normal mode.

2. Dry runtime check:
   - Run one cycle with order placement disabled or mocked.
   - Confirm selected candidates are fee-enabled.
   - Confirm expected rebate telemetry is logged.

3. Live runtime check:
   - Place a small post-only quote on a fee-enabled market.
   - Confirm CLOB request body has `postOnly:true` and `deferExec:false` without logging credentials.
   - Confirm fill counters increment when a maker fill occurs.
   - Query the rebates endpoint for the next daily cycle after accrual.

4. Success criteria:
   - No raw credential-bearing SDK logs.
   - Nonzero fill rate on selected markets.
   - Rebate API returns nonzero rows for the maker address once daily accrued rebate exceeds the payout threshold.

---

## Open questions

1. Which wallet address should be used for rebate API checks: signer, proxy wallet, or maker address from trade records? The CLOB trade object's `maker_address` should be treated as the source of truth.
2. Are these markets on global Polymarket or Polymarket US for this account? Payout semantics differ in docs.
3. Should this feature target maker rebates only, or should it be expanded to also optimize classic liquidity rewards? The formulas and eligibility criteria are different.

