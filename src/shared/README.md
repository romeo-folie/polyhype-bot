# shared

Cross-cutting utilities used by all pipeline modules. No business logic lives here.

## Modules

### `config.ts`
Centralised environment config using [Zod](https://zod.dev/) schema validation.

Loaded once at startup via `loadConfig()`. Throws immediately if required variables are missing or invalid — no silent misconfiguration.

**Required env vars:** `REDIS_URL`, `SIMMER_SKILL_URL`, `SIMMER_API_KEY`, plus at least one of `OPENAI_API_KEY` / `GEMINI_API_KEY`.

**Optional tuning knobs (with defaults):**
| Variable | Default | Purpose |
|----------|---------|---------|
| `URGENCY_THRESHOLD` | `8` | Minimum urgency score (1–10) to pass to mapping |
| `DIVERGENCE_THRESHOLD` | `0.1` | Minimum edge (10%) to trigger a trade |
| `MAX_BET_FRACTION` | `0.1` | Max 10% of bankroll per trade |
| `TAKE_PROFIT_THRESHOLD` | `0.25` | Exit at 25% return |
| `BANKROLL_USD` | `100` | Total portfolio value in USD |
| `TELEGRAM_BOT_TOKEN` | — | Optional; notifications disabled if unset |
| `TELEGRAM_CHAT_ID` | — | Optional; notifications disabled if unset |

### `redis.ts`
Lazy singleton Redis client using [ioredis](https://github.com/redis/ioredis).

- `getRedis()` — returns the shared client (connects on first call)
- `closeRedis()` — graceful disconnect; call in `finally` / SIGTERM handlers

All pipeline modules share one connection. Do not instantiate `ioredis` directly elsewhere.

### `simmer.ts`
Typed wrapper around the `polymarket-ai-divergence` Simmer SDK skill.

- `submitTrade(input)` — POST to the Simmer skill URL; validates response with Zod
- `probeSimmerSkill()` — connectivity check using a dummy probe payload
- `SimmerError` — custom error class carrying `statusCode` and raw `body` for caller inspection

Timeout: 30 s hard abort via `AbortSignal.timeout`.

### `logger.ts`
Structured JSON logger. All log output is newline-delimited JSON to stdout/stderr.

Fields: `ts` (ISO), `level` (info/warn/error), `msg`, plus any additional context passed as the second argument.
