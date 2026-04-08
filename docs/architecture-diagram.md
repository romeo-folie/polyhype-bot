# System Architecture — High-Level Component View

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL DATA SOURCES                               │
├──────────────┬──────────────┬──────────────┬──────────────┬─────────────────────┤
│   RSS feeds  │   Telegram   │  Binance WS  │  Gamma API   │  Whale wallets      │
│  (OSINT)     │  (TDLib)     │ (spot+kline) │ (PM markets) │  (on-chain)         │
└──────┬───────┴──────┬───────┴──────┬───────┴──────┬───────┴─────────┬───────────┘
       │              │              │              │                 │
       ▼              ▼              ▼              ▼                 ▼
┌──────────────────────────┐  ┌───────────────┐  ┌──────────────┐  ┌──────────────┐
│       INGESTION          │  │  SPOT FEEDS   │  │  WATCHLIST   │  │  COPYTRADE   │
│  ┌────────────────────┐  │  │  (manager.ts) │  │   refresh    │  │    worker    │
│  │ RSS cron           │  │  │  tick + kline │  │  (market     │  │              │
│  │ Telegram monitor   │  │  │  aggregator   │  │   cache)     │  │              │
│  │ dedup + category   │  │  └───────┬───────┘  └──────┬───────┘  └──────┬───────┘
│  │ classifier         │  │          │                 │                 │
│  └──────────┬─────────┘  │          ▼                 │                 │
└─────────────┼────────────┘  ┌───────────────┐         │                 │
              │               │ SPOT TRIGGER  │         │                 │
              │               │ (z-score/pct) │         │                 │
              │               └───────┬───────┘         │                 │
              ▼                       │                 │                 │
┌──────────────────────────┐          │                 │                 │
│   ENTITY EXTRACT +       │          │                 │                 │
│   MARKET CANDIDATE MATCH │◄─────────┼─────────────────┘                 │
│   (watchlist cache)      │          │                                   │
└──────────┬───────────────┘          │                                   │
           │                          │                                   │
           ▼                          ▼                                   │
┌────────────────────────┐   ┌──────────────────────┐                     │
│  MAPPING / LLM         │   │  CRYPTO ARB SCANNER  │                     │
│  consensus probability │   │  (Binance tick →     │                     │
│  (OpenAI/Gemini/       │   │   PM crypto trades)  │                     │
│   Anthropic/DeepSeek)  │   └──────────┬───────────┘                     │
│  divergence calculator │              │                                 │
│  Half-Kelly sizing     │              │                                 │
└──────────┬─────────────┘              │                                 │
           │                            │                                 │
           ▼                            │                                 │
┌──────────────────────┐                │                                 │
│  CONFLUENCE SCORER   │                │                                 │
│  (RSI/MACD/Stoch/    │◄───────────────┘                                 │
│   OBV/MFI/VWAP/CMF)  │                                                  │
│  gate + shadow log   │                                                  │
└──────────┬───────────┘                                                  │
           │                                                              │
           ▼                                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              EXECUTION LAYER                                     │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  executor.ts                                                               │  │
│  │   idempotency ──► venue routing ──► stake floor ──► position dedup        │  │
│  │                         │                                                  │  │
│  │     ┌───────────────────┼───────────────────────┐                          │  │
│  │     ▼                   ▼                       ▼                          │  │
│  │  Simmer API      CLOB maker path           Hyperliquid                     │  │
│  │  (PM taker)      (post-only GTC            (perps, bypasses                │  │
│  │                   + taker fallback)         executor routing)              │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
└──────────┬──────────────────────┬──────────────────────┬────────────────────────┘
           │                      │                      │
           ▼                      ▼                      ▼
    ┌────────────┐         ┌────────────┐         ┌──────────────┐
    │  Simmer    │         │ Polymarket │         │ Hyperliquid  │
    │   API      │         │   CLOB     │         │     API      │
    └─────┬──────┘         └─────┬──────┘         └──────┬───────┘
          │                      │                       │
          └──────────┬───────────┘                       │
                     ▼                                   ▼
          ┌────────────────────────┐         ┌────────────────────────┐
          │  MONITOR (PM)          │         │  FUTURES MONITOR       │
          │   fixed SL             │         │   SL / TP              │
          │   trailing stop        │         │   trailing stop        │
          │   (supersedes TP)      │         │   (now supersedes TP)  │
          │   stale-exit           │         │   max-hold             │
          │   maker-exit path      │         │   TA signal-fade       │
          │   signal re-eval (LLM) │         │                        │
          │   reconciliation       │         │                        │
          └──────────┬─────────────┘         └──────────┬─────────────┘
                     │                                  │
                     └───────────────┬──────────────────┘
                                     ▼
                    ┌────────────────────────────────┐
                    │  SHARED STATE / INFRA          │
                    │  ┌──────────────────────────┐  │
                    │  │  Redis (singleton)       │  │
                    │  │   positions / ledger     │  │
                    │  │   locks / dedup          │  │
                    │  │   bankroll / governor    │  │
                    │  │   klines / watchlist     │  │
                    │  │   calibration / metrics  │  │
                    │  └──────────────────────────┘  │
                    │  config (Zod) · logger         │
                    └──────────────┬─────────────────┘
                                   │
                                   ▼
                          ┌──────────────────┐
                          │ Telegram notifier │
                          │   (ops alerts)    │
                          └───────────────────┘
```

## Reading it top-to-bottom
External data → ingestion/feeds → signal generation (LLM mapping, spot trigger, arb scanner) → confluence gate → execution layer (three venues) → post-trade monitoring loops → all backed by Redis + config/logger + Telegram alerts.

## Key things the diagram makes visible
- **Three independent signal paths** converge at the executor: news sentiment (mapping), spot momentum (spot trigger), crypto arb.
- **Futures bypass the executor's venue routing** — they go straight to Hyperliquid from mapping/spot/arb. This is why the CLOB maker path never applies to futures.
- **Two monitor loops run in parallel**: PM monitor (cron, polls Simmer/CLOB) and futures monitor (Docker worker, polls HL every 5s).
- **Redis is the spine** — every component reads/writes state there; it's the only coordination mechanism between workers and cron jobs.
- **Workers (long-running) vs cron (periodic)**: `spot-feed`, `telegram`, `arb`, `copytrade`, `futures-monitor` are workers; ingestion, mapping, PM monitor, watchlist refresh are cron-driven.
