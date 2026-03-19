# Polymarket Geopolitical Trading Agent

Autonomous agent that monitors geopolitical OSINT feeds, maps high-urgency events to Polymarket prediction contracts, and executes trades with automatic position management.

## Architecture

```mermaid
flowchart TB
    subgraph INGESTION["⚡ Ingestion (cron:trade, every 5 min)"]
        GDELT["GDELT v2 API<br/><i>combined theme query</i>"]
        RSS["RSS Feeds<br/><i>BBC, NYT, Al Jazeera,<br/>Sky News, Reuters</i>"]
        DEDUP["Redis Dedup"]
        SCORER["LLM Urgency Scorer<br/><i>OpenAI / Gemini</i>"]

        GDELT --> DEDUP
        RSS --> DEDUP
        DEDUP --> SCORER
    end

    subgraph MAPPING["🗺️ Market Mapping"]
        ENTITY["Entity Extractor<br/><i>LLM → keywords</i>"]
        GAMMA["Polymarket Gamma API<br/><i>market search</i>"]
        CONSENSUS["Consensus Calculator<br/><i>LLM probability estimate</i>"]
        DIVERGENCE["Divergence Calculator<br/><i>edge detection + Half-Kelly sizing</i>"]

        ENTITY --> GAMMA
        GAMMA --> CONSENSUS
        CONSENSUS --> DIVERGENCE
    end

    subgraph REEVAL["🔄 Signal Re-evaluation"]
        REEVAL_CHECK["Check open positions<br/>against fresh OSINT"]
        REEVAL_LLM["Re-estimate consensus<br/><i>LLM</i>"]
        REEVAL_EXIT["Exit if edge < 3%<br/>or direction flipped"]

        REEVAL_CHECK --> REEVAL_LLM --> REEVAL_EXIT
    end

    subgraph EXECUTION["💰 Trade Execution"]
        ROUTER["Execution Router"]
        SIMMER["Simmer API<br/><i>primary venue</i>"]
        CLOB["Polymarket CLOB<br/><i>fallback — direct orderbook</i>"]
        LEDGER["Redis Position Ledger"]
        TELEGRAM["Telegram Notifications"]

        ROUTER -->|"market in Simmer"| SIMMER
        ROUTER -->|"market not in Simmer"| CLOB
        SIMMER --> LEDGER
        CLOB --> LEDGER
        LEDGER --> TELEGRAM
    end

    subgraph MONITOR["👁️ Position Monitor (cron:monitor, every 5 min)"]
        PRICES["Gamma Price Fetcher"]
        STOPLOSS["Stop-Loss<br/><i>exit if loss ≥ 30%</i>"]
        TAKEPROFIT["Take-Profit<br/><i>exit if gain ≥ 25%</i>"]
        DIVCLOSE["Divergence Closed<br/><i>market reached consensus</i>"]
        SELL["Sell Executor<br/><i>Simmer / CLOB</i>"]

        PRICES --> STOPLOSS
        STOPLOSS -->|"loss exceeded"| SELL
        PRICES --> TAKEPROFIT
        TAKEPROFIT -->|"profit target hit"| SELL
        PRICES --> DIVCLOSE
        DIVCLOSE -->|"edge gone"| SELL
    end

    SCORER -->|"high-urgency items"| MAPPING
    SCORER -->|"high-urgency items"| REEVAL
    DIVERGENCE -->|"TradeSignal[]"| EXECUTION
    REEVAL_EXIT -->|"exit signal"| SELL
    LEDGER -.->|"open positions"| MONITOR
    LEDGER -.->|"open positions"| REEVAL

    subgraph GUARDS["🛡️ Execution Guards"]
        G1["Stake floor check"]
        G2["Open position check<br/><i>no duplicate entry</i>"]
        G3["Idempotency key<br/><i>Redis, 1h TTL</i>"]
    end

    DIVERGENCE --> GUARDS --> ROUTER

    style INGESTION fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style MAPPING fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style REEVAL fill:#1a1a2e,stroke:#0f3460,color:#e0e0e0
    style EXECUTION fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style MONITOR fill:#1a1a2e,stroke:#16213e,color:#e0e0e0
    style GUARDS fill:#1a1a2e,stroke:#533483,color:#e0e0e0
```

### Data Flow Summary

| Cycle | Entrypoint | What happens |
|-------|-----------|--------------|
| **Trade** (`cron:trade`) | `src/execution/index.ts` | Ingest OSINT → score urgency → map to markets → re-evaluate open positions → execute new trades |
| **Monitor** (`cron:monitor`) | `src/monitor/index.ts` | Fetch prices for open positions → evaluate stop-loss / take-profit / divergence → exit if triggered |

### Exit Priority

| Priority | Trigger | Cost | Where |
|----------|---------|------|-------|
| 1 | **Stop-loss** — loss ≥ 30% | Free (price check) | Monitor cycle |
| 2 | **Take-profit** — gain ≥ 25% | Free (price check) | Monitor cycle |
| 3 | **Signal re-eval** — edge evaporated | LLM call | Trade cycle |
| 4 | **Divergence closed** — market reached consensus | Free (price check) | Monitor cycle |

### Execution Venues

| Venue | When used | Auth |
|-------|-----------|------|
| **Simmer** (primary) | Market exists in Simmer catalogue | `SIMMER_API_KEY` |
| **Polymarket CLOB** (fallback) | Market not in Simmer | `POLYGON_WALLET_PRIVATE_KEY` (local signing) |

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Required: REDIS_URL, SIMMER_API_KEY, OPENAI_API_KEY (or GEMINI_API_KEY),
#           TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, POLYGON_WALLET_PRIVATE_KEY
# See .env.example for all optional tuning knobs.

# 3. Verify build
npm run build

# 4. Probe Simmer connectivity
npm run probe:simmer

# 5. Run trade + monitor cycles via cron (every 5 min)
# See crontab example below.
```

### Crontab

```cron
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin

*/5 * * * * cd /path/to/polymarket-geopolitical-agent && npx tsx src/execution/index.ts >> /tmp/pga-trade.log 2>&1
*/5 * * * * cd /path/to/polymarket-geopolitical-agent && npx tsx src/monitor/index.ts >> /tmp/pga-monitor.log 2>&1
```

## Scripts

| Script | Description |
|---|---|
| `npm run build` | TypeScript type-check (no emit) |
| `npm run probe:simmer` | Verify Simmer SDK connectivity |
| `npm run cron:trade` | Run the full trade pipeline (ingest → map → re-eval → execute) |
| `npm run cron:monitor` | Run the position monitor (stop-loss / take-profit / divergence) |
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
