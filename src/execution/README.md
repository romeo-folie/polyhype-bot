# execution — Phase 3: Trade Execution Orchestration & Notifications

Receives `TradeSignal[]` from Phase 2, executes trades via the Simmer SDK, records open positions in Redis, and sends Telegram notifications.

## Pipeline

```
TradeSignal[]
  └──► executeSignal (idempotency check → Simmer SDK)
         └── success ──► recordPosition (Redis ledger)
                    └──► notifyTradeExecuted (Telegram)
         └── failure ──► notifyTradeError (Telegram)
```

## Modules

### `executor.ts`
Wraps execution with safety layers before calling Simmer/CLOB:

1. **Stake floor check** — skips signals with `stakeUsd < MIN_BET_USD`
2. **Idempotency guard** — SHA-256 key of `marketId:direction:stakeUsd` stored in Redis (TTL: 1 h). Prevents double-firing if the cron runs twice or crashes mid-execution.
3. **Execution mode** — `EXECUTION_MODE=hybrid|maker|taker`
   - **hybrid** (default): try CLOB post-only maker order, then fall back to taker
   - **maker**: post-only maker only; no taker fallback
   - **taker**: current Simmer/CLOB market order path

Returns `ExecutionResult` — never throws. All errors captured in `result.error`.

Signals are processed **sequentially** (not in parallel) to avoid hammering the venue.

### `positionLedger.ts`
Redis-backed position store. Each position is a flat hash at key `position:<marketId>:<direction>` (no TTL; explicit close/removal only).

A sorted set (`positions:index`, score = `openedAt` ms) allows chronological listing without scanning all keys.

```ts
recordPosition(redis, position)      // persist new position
getOpenPositions(redis)              // list all active positions
hasOpenPosition(redis, id, dir)      // existence check
closePosition(redis, id, dir)        // remove after take-profit
```

### `telegram.ts`
Telegram Bot API notifications. Silently no-ops if `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are unset — never breaks the pipeline.

All user-facing strings are HTML-escaped before sending (`parse_mode: 'HTML'`).

Three notification types:
- `notifyTradeExecuted(signal, txHash)` — 🟢 trade opened
- `notifyTradeError(signal, error)` — 🔴 trade failed
- `notifyTakeProfitExecuted(opts)` — 💰 position closed (called from Phase 4)

### `index.ts`
Full pipeline cron entrypoint: ingest → map → execute → record → notify.

```bash
npx tsx src/execution/index.ts
# or via package.json:
npm run cron:ingest   # runs execution pipeline (includes ingestion + mapping)
```

Reads `BANKROLL_USD` from config (default: `$100`).
