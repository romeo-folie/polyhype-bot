# Polymarket Geopolitical Trading Agent

Autonomous agent that monitors geopolitical OSINT feeds, maps high-urgency events to Polymarket prediction contracts, and executes trades via the Simmer SDK.

## Architecture

```
world-monitor-scraper (cron, 5 min)
  └── RSS/OSINT ingestion
  └── LLM urgency scoring (gpt-4o-mini / gemini-flash)
  └── Deduplication (Redis)
  └── Market mapping (Polymarket Gamma API)
  └── Half-Kelly sizing
  └── Trade execution (Simmer SDK → polymarket-ai-divergence)
  └── Telegram notification

polymarket-position-monitor (cron, 5 min)
  └── Fetch open positions (Simmer SDK)
  └── Check bid/ask (Polymarket)
  └── Take-profit sell if up ≥ 25% or divergence closes
  └── Telegram notification
```

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in REDIS_URL, SIMMER_SKILL_URL, SIMMER_API_KEY, OPENAI_API_KEY (or GEMINI_API_KEY),
# TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, POLYGON_WALLET_PRIVATE_KEY

# 3. Verify build (TypeScript typecheck, no emit)
npm run build

# 4. Probe the Simmer SDK connection
# Requires a populated .env file (copy from .env.example):
#   cp .env.example .env
#   # fill in SIMMER_SKILL_URL and SIMMER_API_KEY
npm run probe:simmer
```

## Scripts

| Script | Description |
|---|---|
| `npm run build` | TypeScript type-check (no emit) |
| `npm run probe:simmer` | Verify Simmer SDK connectivity |
| `npm run cron:ingest` | Run the world-monitor-scraper (Phase 1+) |
| `npm run cron:monitor` | Run the position monitor (Phase 4+) |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |
| `npm test` | Jest tests |

## Module Documentation

| Module | README | Description |
|--------|--------|-------------|
| `src/shared/` | [README](src/shared/README.md) | Config, Redis client, Simmer SDK wrapper, logger |
| `src/ingestion/` | [README](src/ingestion/README.md) | RSS + Cheerio scraping, Redis dedup, LLM urgency scoring |
| `src/mapping/` | [README](src/mapping/README.md) | Gamma API client, entity extraction, consensus probability, Half-Kelly sizing |
| `src/execution/` | [README](src/execution/README.md) | Simmer trade execution, Redis position ledger, Telegram notifications |
| `src/monitor/` | [README](src/monitor/README.md) | Position monitor, take-profit evaluator + executor |

## Phases

See [docs/PHASES.md](docs/PHASES.md) for the full phase breakdown.
See [docs/PRD.md](docs/PRD.md) for product requirements.

## Environment Variables

See `.env.example` for full documentation of all required and optional variables.

## Development Notes

- **One PR per phase.** Tasks within a phase are tracked as GitHub sub-issues under the phase epic.
- **Romeo merges all PRs.** Never merge your own work.
- Phase 0: scaffolding + Simmer SDK validation.
- Phase 1: ingestion & urgency scoring.
- Phase 2: market mapping & execution logic.
- Phase 3: execution orchestration & Telegram notifications.
- Phase 4: position monitor & take-profit.
# Test
