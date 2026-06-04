# CLAUDE.md

## Project
Autonomous trading agent for Polymarket prediction markets. Monitors OSINT sources (RSS, Telegram), spot prices (Binance WebSocket), and whale wallets to discover and execute trades. Executes on Polymarket CLOB directly. Also trades crypto futures on Hyperliquid.

## Tech Stack
TypeScript, Node.js, ioredis, Zod, Vitest, Docker Compose. Deployed on Raspberry Pi.

## Source Layout
```
src/
  arb/           # Arbitrage scanner (pure arb + crypto arb + Up/Down BTC markets)
  copytrade/     # Whale copytrade mirroring
  cron/          # Scheduled jobs: OSINT ingestion, spot scans, rebalancing, redemption
  execution/     # Trade sizing (Half-Kelly), venue routing (CLOB → Hyperliquid)
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
npx tsc --noEmit                 # type-check
npx vitest run                   # run all tests
npx eslint src/                  # lint
scripts/deploy.sh pga-futures    # deploy only the changed service(s)
scripts/deploy.sh --all          # explicit full-stack deploy when required
redis-cli KEYS '*lock*'          # verify no stale locks after restart
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
  After creating a PR, start a Monitor task to watch for comments and status. When the PR status shows `merged=true`, stop the monitor task with `TaskStop`.
- **Every new feature or behavioural change must include Vitest tests** that verify the new behaviour. Updating tests to match changed signatures is not sufficient — tests must assert the actual new behaviour (e.g. that a bracket signal is not emitted on a skipped primary, that a direction-aware key is used, etc.). Never submit a PR without new or updated tests covering the change.
- **Review loop before any push** (new PRs, new commits to an existing PR, direct pushes to `main`): review the diff, fix every CONFIRMED and PLAUSIBLE finding, re-run the review. Repeat until the review returns `[]`. Only then push/open the PR.
  - **"The code reviewer" = the feature-dev plugin's `code-reviewer` agent** (launch via the Agent tool, `subagent_type: feature-dev:code-reviewer`). Use it for the iterative review rounds — it's a single agent per round and cheap to repeat.
  - The standalone **`/code-review` skill** (e.g. `--effort high`) fans out many subagents and is **expensive** — reserve it for one final pass on a substantial change, or a genuinely large/risky diff. Never use it for repeated fix-verify rounds.
  - If feature-dev isn't installed or fails to load, repair/install it (`claude plugin marketplace add anthropics/claude-plugins-official`, then `claude plugin install feature-dev@claude-plugins-official`) rather than falling back to repeated `/code-review` runs.
- **After a PR merges into `main`, redeploy the affected container(s).** Claude Code runs on the Hetzner prod server — merging does not restart running workers. Pull `main`, then run `scripts/deploy.sh <service...>` for the service(s) whose source changed:
  - `pga-arb` → `src/arb/*`
  - `pga-monitor` → `src/monitor/*` **except** `src/monitor/futuresMonitor.ts`
  - `pga-futures` → `src/monitor/futuresMonitor.ts` (this is a separate container from `pga-monitor`)
  - `pga-sports` → `src/sports/*`
  - `pga-copytrade` → `src/copytrade/*`
  - `pga-cron` → `src/cron/*`
  - `pga-spot` → `src/spot/*`
  - `pga-arb`, `pga-monitor`, `pga-futures`, `pga-copytrade`, `pga-cron` → `src/shared/*` or `src/execution/*` (shared infra — rebuild all importing services)
  
  Use `scripts/deploy.sh --all` only for explicit full-stack work such as shared infrastructure changes. Confirm the container restarted and verify logs.
- **Always branch from `main`** unless explicitly told to branch from a specific feature branch.
- Prefer editing existing files over creating new ones.
- `MIN_BET_USD=5` is the preferred minimum bet amount.
