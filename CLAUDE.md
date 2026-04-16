# CLAUDE.md

## Project
Autonomous trading agent for Polymarket prediction markets. Monitors OSINT sources (RSS, Telegram), spot prices (Binance WebSocket), and whale wallets to discover and execute trades. Primary venue is Simmer API with direct CLOB fallback. Also trades crypto futures on Hyperliquid.

## Tech Stack
TypeScript, Node.js, ioredis, Zod, Vitest, Docker Compose. Deployed on Raspberry Pi.

## Source Layout
```
src/
  arb/           # Arbitrage scanner (pure arb + crypto arb + Up/Down BTC markets)
  copytrade/     # Whale copytrade mirroring
  cron/          # Scheduled jobs: OSINT ingestion, spot scans, rebalancing, redemption
  execution/     # Trade sizing (Half-Kelly), venue routing (Simmer → CLOB → Hyperliquid)
  ingestion/     # RSS feeds, Telegram TDLib monitor, scoring
  mapping/       # LLM consensus probability estimation, divergence calculation, Gamma API
  monitor/       # Position monitoring, futures monitor, take-profit/stop-loss, reconciliation
  shared/        # Redis singleton, config (Zod), bankroll, logger, governor, ledger
  spot/          # Binance WebSocket price feeds, threshold detection
```

## Workers (long-running processes)
Each has its own SIGTERM handler that releases Redis locks before exiting:
- `src/copytrade/worker.ts` — whale copytrade
- `src/monitor/futuresMonitor.ts` — Hyperliquid futures
- `src/arb/worker.ts` — arb scanner
- `src/spot/feeds/manager.ts` — Binance WS spot feeds
- `src/ingestion/telegramMonitor.ts` — Telegram channel monitor

## Key Files
- `src/shared/config.ts` — Zod schema with all env var defaults (source of truth for config)
- `src/shared/redis.ts` — Singleton Redis client, lock acquire/release, dedup. Handlers call `closeRedis()` without `process.exit(0)` so workers can release locks first.
- `src/execution/executor.ts` — Full trade pipeline: idempotency → venue routing → stake floor check → position dedup → execution
- `src/mapping/divergenceCalculator.ts` — Half-Kelly stake sizing + 20% book depth liquidity gate
- `.env.example` — Documented defaults (committed); `.env` — runtime values with secrets (gitignored)

## Commands
```bash
npx tsc --noEmit          # type-check
npx vitest run            # run all tests
npx eslint src/           # lint
docker compose up -d --build  # deploy all containers
redis-cli KEYS '*lock*'       # verify no stale locks after restart
```

## Important Patterns
- **Config defaults live in `src/shared/config.ts`** (Zod `.default()` values). `.env.example` documents them. Always update both together.
- **Stake floor bump**: Stakes ≥60% of `MIN_BET_USD` are bumped up to the floor instead of skipping the trade entirely (`executor.ts`).
- **Graceful shutdown**: `redis.ts` does NOT call `process.exit()` — each worker releases its own lock, calls `closeRedis()`, then exits.
- **LLM consensus**: Round-robin across configured providers (OpenAI/Gemini/Anthropic/DeepSeek). `CONSENSUS_SAMPLES` controls total calls per estimate.
- **Never commit `.env`** — contains funded wallet keys, API keys, and session strings.

## Conventions
- Commit messages: imperative mood, prefixed with `feat:`, `fix:`, `chore:`, etc.
- **Always create a PR. Never push directly to main unless the user explicitly asks.**
  Branch naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`. Open PR, wait for merge.
- Prefer editing existing files over creating new ones.
- `MIN_BET_USD=5` is the preferred minimum bet amount.
