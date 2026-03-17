# Product Requirements Document: Polymarket Geopolitical Trading Agent

**Author:** Pam (PM) / Mark (Strategist) / Romeo (Orchestrator)
**Status:** V1 - Ready for Review
**Date:** 2026-03-17

## 1. Product Overview & Problem Statement
The goal is to build an autonomous geopolitical trading agent on Polymarket. It relies on OpenClaw, the Simmer SDK, and AI-driven OSINT (Open Source Intelligence) filtering to capitalize on market divergence during breaking global events. This is a standalone prediction market-focused variant, built from scratch, not an addition to the existing TradeEngine.

## 2. Target Users & Success Criteria
- **User:** Romeo (operator).
- **Success Criteria:** 
  - The agent successfully ingests OSINT data, scores it, finds relevant Polymarket contracts, executes trades when divergence >10% is found, and manages exits automatically.
  - The system operates autonomously via local cron jobs.

## 3. Financial & Risk Parameters
- **Initial Bankroll:** $100 (Funded via Polygon as `$USDE.e` + `$POL` for gas).
- **Max Bet Size:** 10% of portfolio ($10 per trade).
- **Position Management:** Aggressive Take-Profit. The agent takes profit if the spread closes or if the position hits a +25% return.

## 4. Feature List
### P0 - Core Orchestration & Ingestion
- **Data Ingestion:** A custom OpenClaw skill (`world-monitor-scraper`) to scrape RSS feeds and free OSINT dashboards (`worldmonitor.app`, `pizzint.watch`).
- **AI Filtering:** Deduplicated articles are passed to a fast LLM (e.g., `gpt-4o-mini` or `gemini-flash`) to score geopolitical urgency (1-10).

### P0 - Market Mapping & Execution Decision
- **Entity Extraction & Market Search:** For articles scoring 8+, extract core entities/keywords (e.g., "Trump", "Iran", "War") and query the public Polymarket Gamma API (`https://gamma-api.polymarket.com/events?query=...`) to find active, relevant contracts.
- **Divergence Calculation:** Read specific contract rules and current prices, calculate consensus probability (P) via LLM, and calculate Edge and Half-Kelly sizing. If divergence >10%, trigger execution.

### P0 - Execution & Position Management
- **Execution Orchestration:** Pass `market_id`, `direction` (YES/NO), and `amount` to the existing `polymarket-ai-divergence` Simmer SDK skill to fire the trade.
- **Take-Profit Monitor:** A dedicated cron job (`polymarket-position-monitor`) running every 5 minutes. It asks the Simmer SDK for open positions, checks current bid/ask on Polymarket, and executes a Sell order if the position is up +25% or if the original probability divergence has closed.

### P1 - Notifications
- **Telegram Updates:** Push structured updates detailing the trade, divergence identified, and the OSINT source upon execution or taking profit.

## 5. Out-of-Scope Items
- Building the blockchain execution layer from scratch (Simmer SDK handles this).
- Paid OSINT/News APIs (GDELT/NewsData/NewsAPI.ai) for the MVP. We will stick to scraping free dashboards and RSS for now.
- Integration into `trade-engine`.

## 6. Non-Functional Requirements
- **Language & Runtime:** TypeScript on Node.js.
- **State Management:** Redis (in-memory caching for sub-millisecond deduplication and active position tracking).
- **Ingestion/Scraping:** `rss-parser` + `Cheerio` (Playwright only as a fallback for JS-heavy SPAs).
- **API Communication:** Native `fetch` (no bulky wrappers like LangChain).
- **Hosting:** Local execution on the existing machine.
- **Engine:** OpenClaw running an isolated session.

## 7. Open Questions and Dependencies
- N/A - Ambiguities resolved.