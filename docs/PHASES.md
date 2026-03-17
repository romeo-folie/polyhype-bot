# Phase Breakdown: Polymarket Geopolitical Trading Agent

**Date:** 2026-03-17
**Status:** V1

## Phase 0: Project Scaffolding & Setup
- **Goals:** Set up the repository and ensure the Simmer SDK (`polymarket-ai-divergence` skill) is accessible.
- **Deliverables:** Empty orchestration scripts and cron job definitions.
- **Acceptance Criteria:** Environment is ready for the ingestion script.
- **Complexity:** Simple

## Phase 1: Data Ingestion & Filtering (`world-monitor-scraper`)
- **Goals:** Scrape OSINT sources and score urgency.
- **Deliverables:** A Node.js skill/script that scrapes `worldmonitor.app`, `pizzint.watch`, and RSS feeds, deduplicates, and scores using a fast LLM.
- **Acceptance Criteria:** Script successfully outputs high-urgency (8+) articles with extracted keywords.
- **Complexity:** Moderate

## Phase 2: Market Mapping & Execution Logic
- **Goals:** Map high-urgency news to Polymarket contracts and calculate divergence.
- **Deliverables:** Orchestration logic to query the Polymarket Gamma API, calculate consensus probability, evaluate divergence (>10%), and calculate Half-Kelly sizing.
- **Acceptance Criteria:** System successfully identifies a valid `market_id`, `direction`, and `amount` based on an 8+ scored article.
- **Complexity:** Complex

## Phase 3: Trade Execution Orchestration & Notifications
- **Goals:** Wire up the execution logic to the Simmer SDK and send Telegram alerts.
- **Deliverables:** Integration code calling the `polymarket-ai-divergence` skill with the determined parameters, plus the Telegram webhook notification integration.
- **Acceptance Criteria:** Trades are successfully passed to Simmer SDK and Telegram alerts are fired.
- **Complexity:** Moderate

## Phase 4: Position Monitor & Take-Profit (`polymarket-position-monitor`)
- **Goals:** Actively manage open positions to secure profits.
- **Deliverables:** A separate script intended to run every 5 minutes that fetches open positions via Simmer SDK, checks Polymarket bid/ask, and triggers a sell if up +25% or divergence closes.
- **Acceptance Criteria:** Script successfully evaluates open positions and executes sells under the defined conditions.
- **Complexity:** Moderate