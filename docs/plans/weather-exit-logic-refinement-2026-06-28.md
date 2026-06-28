# Weather Exit Logic Refinement

Date: 2026-06-28

## Context

The June 27-28 weather positions exposed a mismatch between the drift exit strategy and the
mechanics of small CLOB positions.

Weather drift correctly identified several bad positions, but the exit attempts came after the
positions had become too small in notional value to sell:

| Market | City | Held side | Exit trigger | Bid at attempt | Shares | Notional | Result |
|---|---|---:|---|---:|---:|---:|---|
| `2688325` | Shenzhen | NO | `market_against` Tier 2 + bid velocity | `0.084` | `5.576207` | `$0.4684` | rejected, marked pending |
| `2688219` | Shanghai | NO | `market_against` Tier 2 + bid velocity | `0.051` | `7.042252` | `$0.3592` | rejected, marked pending |
| `2687187` | Miami | NO | `market_against` Tier 2 | `0.130` | `5.882351` | `$0.7647` | rejected, marked pending |
| `2688121` | Paris | NO | `modal_against` streak 2 | `0.590` | `4.838707` | `$2.855` | sold, dust residual pending |
| `2688205` | Hong Kong high | NO | held-prob fresh decline | `0.991` | `5.000000` | `$4.955` | sold |

The core problem is not that every attempted exit was wrong. Shenzhen, Shanghai, and Miami were
already in severe market-against states. The problem is that the fixed near-dead bid gate
(`WEATHER_DRIFT_MARKET_EXIT_MAX_BID=0.15`) can be below the executable bid for small weather
positions.

For a `$1` CLOB minimum notional:

```text
minExecutableBid = 1 / sharesHeld
```

Examples:

| Market | Shares | Minimum executable bid |
|---|---:|---:|
| Shenzhen | `5.576207` | `0.179` |
| Shanghai | `7.042252` | `0.142` |
| Miami | `5.882351` | `0.170` |
| Paris | `4.838707` | `0.207` |

Waiting for `bid <= 0.15` is therefore often waiting until after the position can no longer be sold.

## Goals

1. Reduce the chance of holding a losing weather position until it becomes mechanically unsellable.
2. Preserve the existing protection against unnecessary whipsaw exits.
3. Keep strategy compatible with small account size; do not require larger weather stakes.
4. Keep live positions visible to monitoring even when an exit cannot be submitted because of CLOB
   minimum notional.
5. Make each exit decision explainable in logs and testable from deterministic inputs.

## Non-Goals

- Do not increase default weather stake size as the primary fix.
- Do not dump every `market_against` position as soon as Tier 2 fires.
- Do not loosen modal exits into one-scan boundary-wobble exits.
- Do not mark a full live weather position as `pendingSettlement` solely because an attempted sell is
  below CLOB minimum notional.

## Proposed Changes

### 1. Add a dynamic executable exit threshold

For each open position, compute:

```text
minExecutableBid = CLOB_MIN_ORDER_USD / sharesHeld
lastChanceBid = minExecutableBid * WEATHER_DRIFT_LAST_CHANCE_NOTIONAL_BUFFER
effectiveDeadBid = max(WEATHER_DRIFT_MARKET_EXIT_MAX_BID, lastChanceBid)
```

Suggested initial buffer:

```env
WEATHER_DRIFT_LAST_CHANCE_NOTIONAL_BUFFER=1.20
```

Market-price exits should use `effectiveDeadBid`, not the fixed `0.15`, when the position is small.

Recommended behavior:

| Condition | Exit threshold |
|---|---|
| `market_against` Tier 2, no bid velocity | `bid <= max(0.15, minExecutableBid * 1.10)` |
| `market_against` Tier 2 + bid velocity | `bid <= max(0.15, minExecutableBid * 1.20)` |
| `market_against` Tier 1 | `bid <= max(0.15, minExecutableBid * 1.10)` |

This keeps the dead-bid concept, but moves the threshold up just enough to preserve executability.

Expected effect on observed cases:

| Market | Prior hold/exit behavior | New expected behavior |
|---|---|---|
| Shenzhen | Held at `0.282`; attempted at `0.084`, below min notional | Exit once bid reached roughly `0.21` or lower after Tier 2 + velocity |
| Shanghai | Held at `0.200`; attempted at `0.051`, below min notional | Exit around `0.17` or lower after Tier 2 + velocity |
| Miami | Held at `0.220`; attempted at `0.130`, below min notional | Exit around `0.19-0.20` after Tier 2 / velocity |

### 2. Treat bid velocity as a stronger emergency signal

Bid velocity was a useful signal in the incident:

- Shenzhen: bid dropped `0.282 -> 0.084` (`70.2%`)
- Shanghai: bid dropped `0.381 -> 0.200` (`47.5%`), then `0.200 -> 0.051` (`74.5%`)
- Miami: bid dropped `0.500 -> 0.220` (`56.0%`)

Current behavior gates bid-velocity exits behind the same fixed dead-bid floor. That preserves
whipsaw protection, but it also lets a fast collapse pass through the executable window.

Recommended behavior:

```text
bidVelocityCanExit =
  bidVelocityTrigger
  && isResolutionDay
  && !holdGuardVetoed
  && currentHeldBid <= effectiveDeadBid
```

For larger collapses, consider an even earlier emergency band:

```text
extremeBidVelocityCanExit =
  bidVelocityDrop >= 0.60
  && marketAgainstTier != null
  && isResolutionDay
  && currentHeldBid <= max(0.25, effectiveDeadBid)
```

The `0.25` cap should be shadow-tested before enabling live. The safer first implementation is the
dynamic `effectiveDeadBid` only.

### 3. Keep modal exits conservative

Paris was a reasonable modal exit:

- Held NO on `31C`.
- Forecast rounded into `31C`.
- First modal-against scan had `modalStreak=1` and was deferred.
- Second modal-against scan had `modalStreak=2` and exited.
- Bid was executable (`0.59`) and the exit filled.

Keep:

```env
WEATHER_DRIFT_EXACT_EXIT_MODAL_MIN_RUNS=2
```

Do not merge modal exits with the market-price emergency threshold. Modal exits are about forecast
classification, not market panic. The observed issue after Paris was residual handling, not the modal
decision.

### 4. Add staged de-risking for market-against positions

If false-positive full exits are still a concern, add partial de-risking before full exit:

| State | Suggested action |
|---|---|
| Tier 2, bid `<= 0.30`, no velocity | notify, block size-up |
| Tier 2, bid `<= 0.25`, velocity or repeated Tier 2 | sell `25-50%` if notional remains executable |
| Tier 2, bid `<= effectiveDeadBid` | sell remaining shares |

Partial exits must respect CLOB minimum notional. If a partial sell would be below `$1`, either skip
the partial or sell enough shares to satisfy minimum notional.

This is optional. The minimum viable change is the dynamic executable threshold.

### 5. Replace terminal pending with exit-blocked state for live weather

When a drift exit cannot be submitted because the order would be below CLOB minimum notional, do not
mark a full live weather position as `pendingSettlement=true`.

Instead, record a non-terminal state such as:

```text
exitBlockedReason = min_notional
exitBlockedAt = <timestamp>
exitBlockedBid = <currentHeldBid>
exitBlockedNotional = <sharesHeld * currentHeldBid>
```

Expected behavior:

- Monitor continues evaluating the position.
- Weather drift continues evaluating the position.
- Reconciler can still update shares.
- Redeemer does not treat the position as settlement-ready.
- `pendingSettlement=true` is reserved for actual dust residuals, verified zero/near-zero on-chain
  balances, resolved markets, or successful partial exits where the remaining balance is truly dust.

### 6. Reconciliation should not leave healed full positions pending

If reconciliation observes that a position previously marked pending has full venue/on-chain shares
again, it should not leave the position hidden from scanners.

Suggested rule:

```text
if pendingSettlement
  and source is weather
  and venueShares >= minExecutableSharesForMeaningfulPosition
  and market is not resolved
then clear pendingSettlement or move to exitBlockedReason=min_notional
```

This specifically addresses the Paris pattern where a dust residual state was later healed back to
full shares but remained pending.

## Decision Logic Sketch

```ts
const minExecutableBid = CLOB_MIN_ORDER_USD / sharesHeld;
const baseDeadBid = cfg.WEATHER_DRIFT_MARKET_EXIT_MAX_BID;
const velocityBuffer = cfg.WEATHER_DRIFT_LAST_CHANCE_VELOCITY_BUFFER ?? 1.20;
const normalBuffer = cfg.WEATHER_DRIFT_LAST_CHANCE_BUFFER ?? 1.10;

const normalEffectiveDeadBid = Math.max(baseDeadBid, minExecutableBid * normalBuffer);
const velocityEffectiveDeadBid = Math.max(baseDeadBid, minExecutableBid * velocityBuffer);

const marketAgainstCanExit =
  state === 'market_against'
  && currentHeldBid != null
  && currentHeldBid <= normalEffectiveDeadBid
  && (marketAgainstTier === 1
    || (marketAgainstTier === 2 && isResolutionDay && cfg.WEATHER_DRIFT_TIER2_EXIT_ON_RES_DAY));

const bidVelocityCanExit =
  bidVelocityTrigger
  && isResolutionDay
  && !holdGuardVetoed
  && currentHeldBid != null
  && currentHeldBid <= velocityEffectiveDeadBid;
```

The exit log should include:

- `sharesHeld`
- `minExecutableBid`
- `effectiveDeadBid`
- `baseDeadBid`
- `notionalAtBid`
- `bidVelocityDrop`
- `marketAgainstTier`
- `exitGate`

## Expected Tests

### Unit tests: dynamic threshold calculation

Add tests near `src/weather/__tests__/weatherDriftStrategy.test.ts`.

Cases:

1. `sharesHeld=5`, base dead bid `0.15`, buffer `1.20`
   - `minExecutableBid=0.20`
   - `effectiveDeadBid=0.24`
2. `sharesHeld=20`, base dead bid `0.15`, buffer `1.20`
   - `minExecutableBid=0.05`
   - `effectiveDeadBid=0.15`
3. `sharesHeld=7.042252`, velocity buffer `1.20`
   - `minExecutableBid ~= 0.142`
   - `effectiveDeadBid ~= 0.170`

Expected result:

- Small positions get a higher exit threshold.
- Larger positions preserve the existing `0.15` dead-bid behavior.

### Unit tests: market-against exit before min-notional failure

Fixture modeled on Shenzhen:

- `entryPrice=0.538`
- `sharesHeld=5.576207`
- `currentHeldBid=0.18`
- `currentHeldProb=0.868`
- `marketDrop >= 0.25`
- `modelMarketGap >= 0.55`
- `marketAgainstTier=2`
- resolution day true
- bid velocity true

Expected result:

- `shouldExit=true`
- action `exit`
- no "bid above dead-bid floor" deferral
- sell notional `>= $1`

### Unit tests: market-against still holds moderate whipsaw

Fixture:

- `sharesHeld=6`
- `minExecutableBid=0.1667`
- `velocityEffectiveDeadBid=0.20`
- `currentHeldBid=0.31`
- Tier 2 true
- bid velocity false

Expected result:

- action is notify/block only
- no exit
- log reason remains bid above effective dead-bid floor

### Unit tests: bid velocity crosses dynamic threshold

Fixture modeled on Shanghai:

- prior bid `0.381`
- current bid `0.200`
- `bidVelocityDrop=0.475`
- `sharesHeld=7.042252`
- `velocityEffectiveDeadBid ~= 0.170`

Expected result for `currentHeldBid=0.200`:

- no exit
- deferral log should include `effectiveDeadBid ~= 0.170`

Expected result for `currentHeldBid=0.165`:

- exit
- notional `> $1`

### Unit tests: modal exit behavior unchanged

Fixture modeled on Paris:

- bounded bracket `31C`
- held side NO
- corrected forecast rounds to `31`
- `modalStreak=1`
- bid `0.58`

Expected result:

- no exit
- log `modal exit deferred -- awaiting streak`

Second scan:

- same forecast
- `modalStreak=2`

Expected result:

- exit
- dynamic market-price dead-bid threshold does not block modal exit

### Unit tests: held-prob decline behavior unchanged

Fixture modeled on Hong Kong high:

- prior held prob `0.874`
- current held prob `0.743`
- held floor `0.75`
- min delta `0.02`
- bid `0.991`

Expected result:

- held-prob decline exit fires
- exit succeeds if executor mock fills
- no dependency on market-against dynamic dead-bid threshold

### Unit tests: below-min drift exit does not set terminal pending for live weather

Fixture:

- weather position
- market unresolved
- shares are full balance, not dust
- attempted drift sell notional `< $1`

Expected result:

- no `markPositionPendingSettlement`
- position remains visible to monitor/weather drift
- `exitBlockedReason='min_notional'` or equivalent state is recorded
- warning log includes notional and min order

### Unit tests: true dust residual may still become pending

Fixture:

- weather position
- market unresolved or near resolution
- on-chain/venue shares `0.008707`
- ledger shares also dust or verified partial-fill residual
- notional `< $1`

Expected result:

- may mark `pendingSettlement=true`
- log reason identifies verified dust residual, not full-position min-notional failure

### Unit tests: reconciliation clears unsafe pending after full-share heal

Fixture modeled on Paris:

- position has `pendingSettlement=true`
- reconciliation sees venue shares restored to `4.8387`
- market unresolved
- source starts with `weather:`

Expected result:

- pending is cleared, or position moves to non-terminal `exitBlockedReason`
- monitor/weather scanner include it on the next pass

### Regression tests: non-weather behavior unchanged

Cases:

- Non-weather CLOB sell below min notional keeps current pending-settlement behavior.
- Non-weather partial exit residual keeps current pending-settlement behavior.
- Residual sweep still marks genuine non-weather dust.

Expected result:

- Existing non-weather pending settlement tests continue to pass.

## Expected Operational Results

After implementation, replaying the June 27-28 scenarios should produce:

| Market | Expected new behavior |
|---|---|
| Shenzhen `2688325` | Exit attempted while bid is still around the executable last-chance band, not at `0.084`; no min-notional rejection if liquidity exists. |
| Shanghai `2688219` | First velocity event at `0.200` may still hold depending on buffer, but second-stage threshold should trigger before `0.051`; no full-position pending. |
| Miami `2687187` | Exit attempted around `0.19-0.20` instead of `0.13`, preserving `$1` notional. |
| Paris `2688121` | Modal exit still occurs only after streak 2; residual handling no longer hides a healed full-share position. |
| Hong Kong high `2688205` | Held-prob decline profitable exit remains unchanged. |
| Helsinki `2688379` | Stable position remains held. |

Success metrics:

- Fewer weather positions marked pending before resolution.
- Fewer drift exits rejected for CLOB minimum notional.
- No increase in one-scan modal false exits.
- Market-against exits happen earlier only when the position is near the executable last-chance band.
- Logs explain whether an exit fired because of modal, held-prob decline, market tier, bid velocity,
  or executable last-chance logic.

## Rollout Plan

1. Implement dynamic thresholds in shadow logs only.
   - Add `minExecutableBid`, `effectiveDeadBid`, and `wouldExitUnderExecutableGate` to drift logs.
   - Compare against live behavior for several days.
2. Enable dynamic threshold for bid-velocity exits only.
   - This is the highest-value path based on Shenzhen and Shanghai.
3. Enable dynamic threshold for all `market_against` exits.
4. Replace full-position min-notional pending with non-terminal exit-blocked state.
5. Add reconciliation healing for weather pending positions with restored full shares.

The safest first live change is step 2 plus step 4. Step 2 reduces new bags; step 4 prevents failed
exits from hiding live positions.
