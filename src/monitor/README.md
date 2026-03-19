# monitor — Phase 4: Position Monitor & Take-Profit

Runs every 5 minutes. Checks all open positions in the Redis ledger against current Polymarket prices and exits positions that meet take-profit criteria.

## Pipeline

```
getOpenPositions (Redis)
  └──► fetchCurrentPrice (Gamma API) per position
         └──► evaluateTakeProfit
                └── shouldExit ──► executeTakeProfit (Simmer SDK)
                                       └──► closePosition (Redis)
                                       └──► notifyTakeProfitExecuted (Telegram)
                └── hold ──► (no action, retry next cycle)
```

## Exit Conditions

Either condition triggers an exit:

| Condition | Logic |
|-----------|-------|
| **Take-profit threshold** | `(currentPrice - entryPrice) / entryPrice >= TAKE_PROFIT_THRESHOLD` (default 25%) |
| **Divergence closed** | Market price has reached our consensus estimate: YES position: `currentYesPrice >= consensusProbability`; NO position: `currentYesPrice <= consensusProbability` |

Take-profit threshold is checked first. If both conditions are met simultaneously, `take_profit_threshold` is the reported reason.

## Modules

### `priceFetcher.ts`
Fetches current YES/NO prices from the Gamma API for each open position.

- For **YES positions**: `currentOutcomePrice = currentYesPrice`
- For **NO positions**: `currentOutcomePrice = 1 - currentYesPrice`

Returns `null` for closed/inactive markets or on network failure — those positions are skipped for the current cycle and retried next time.

### `takeProfitEvaluator.ts`
Pure function — no I/O, fully testable.

```ts
evaluateTakeProfit(position, currentPrice, threshold): ExitDecision
// { shouldExit, reason?, returnDecimal, returnPct }
```

### `takeProfitExecutor.ts`
Executes the exit trade via Simmer SDK and cleans up:

- **Sell direction is inverted**: entering YES → sell NO; entering NO → sell YES
- On success: removes position from Redis ledger + sends Telegram notification
- On failure: returns `success: false` — position stays in ledger, retried next cycle

### `index.ts`
Cron entrypoint. Orchestrates the full monitor loop.

```bash
npx tsx src/monitor/index.ts
# or via package.json:
npm run cron:monitor
```

## Failure handling

| Failure | Behaviour |
|---------|-----------|
| Gamma API unreachable | Position skipped this cycle, retried next |
| Simmer sell fails | Position stays in ledger, retried next cycle |
| Redis unavailable | Hard crash — monitor cannot function without state |
