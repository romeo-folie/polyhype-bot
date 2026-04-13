# Polymarket Bot Strategy Research — Full Findings
**Date**: 2026-04-13
**Sources**: General web, Reddit, Bluesky, Twitter/X, academic papers, GitHub repos, Substack/Medium

---

## Part 1: The Current State of Polymarket Bot Trading

### Who Makes Money

- Only **7.6%** of Polymarket wallets are profitable (analysis of 1.5M+ wallets)
- **0.04%** of addresses capture >70% of all realized gains
- **14 of top 20** leaderboard wallets are bots
- **92%** of traders lose money
- Autonomous AI agents show positive P&L 37%+ of the time vs less than half that for humans
- 314,000 active traders on the platform

### Maker vs Taker Asymmetry (Academic — 86M trades analyzed)

The single most important structural finding:
- Takers average **-1.12%** excess return per trade
- Makers capture **+1.12%** per trade
- Makers do NOT profit through superior forecasting — they profit by "accommodating biased order flow"
- The "Optimism Tax": takers disproportionately buy YES contracts at longshot prices
- **NO contracts outperform YES at 69 of 99 price levels**
- Effect is strongest in entertainment/media (4.79-7.32 pp gap), moderate in sports (2.23 pp), nearly absent in finance (0.17 pp)
- Pre-October 2024, amateur makers lost money. Professionalization after election volume reversed the dynamic

Source: Becker — Microstructure of Wealth Transfer, Whelan — Makers and Takers on Kalshi

### The Favorite-Longshot Bias (Academic — 300K contracts)

- Cheap contracts (<10 cents) are **systematically overpriced** — they win far less often than needed for buyers to break even
- Takers lose 32% on average at low prices; makers lose ~10%
- This is a persistent, exploitable structural bias

Source: Whelan — Pricing and Losses on Kalshi

---

## Part 2: Proven Profit Models (Ranked by Evidence)

### Model 1: NegRisk Multi-Outcome Rebalancing — $29M/year

The largest single source of arbitrage profits on Polymarket.

- **Scale**: $29M extracted from April 2024 to April 2025 (73% of total $39.59M in documented arbitrage), despite representing only 8.6% of opportunities — a 29x capital efficiency advantage over binary arbitrage
- **Mechanics**: In multi-outcome markets (N>=3 mutually exclusive conditions), the sum of all YES prices should equal $1.00. When retail flow concentrates on 1-2 favorites, the sum drifts. Bots buy YES on all outcomes when sum < $1.00, locking in the gap as guaranteed profit
- **Example**: Election market with Trump=0.48, Harris=0.46, Other=0.03 sums to 0.97, yielding ~3 cents per unit risk-free
- **Window**: These mispricings persist longer than binary arb (minutes vs seconds)

Source: IMDEA paper, NegRisk Market Rebalancing analysis (Medium)

### Model 2: Domain Specialization — Top Win Rates

From on-chain analysis of 86M transactions:

- Wallets with 70%+ trades in 2-3 categories dramatically outperform generalists
- **HyperLiquid0xb** (sports specialist): $1.4M+ total profits, single MLB prediction yielding $755K
- **"Axios"** (political specialist): 96% win rate analyzing specific speaker word patterns in "mention markets"
- Pattern: 10-30 annual trades with extremely high confidence, not broad participation
- The key: develop deep domain expertise rather than trying to trade everything

### Model 3: Information Arbitrage (Theo/Fredi9999) — $85M

- Theo invested ~$100K in custom private polling ("Who do you think your neighbors will vote for?" — bypassing shy-voter effect)
- Turned it into **$85 million** across 10 associated wallets on the 2024 election
- Not intuition or ideology — research-driven capital allocation with proprietary data
- Demonstrates: original information acquisition beats any model-based approach

Source: The Free Press, CoinTrenches

### Model 4: Exploiting Domain-Specific Calibration Biases — Academic

A February 2026 paper analyzing 292 million trades found structured, exploitable miscalibration:

| Domain | Bias | Trading Implication |
|---|---|---|
| **Political** | Persistent underconfidence (prices compressed toward 50%) | Buy favorites — 70¢ contract = ~83% true probability |
| **Sports** | Well-calibrated <7 days, sharp underconfidence >1 month | Long-term sports favorites underpriced |
| **Weather** | Overconfident at short horizons (slope 0.69 within 48h) | Sell overpriced weather outcomes |
| **Crypto** | Nearly well-calibrated across horizons | Minimal structural edge |
| **Entertainment/Media** | Largest optimism gap (4.79-7.32 pp) | Sell longshots aggressively |
| **All domains** | Increasing underconfidence at longer horizons | Favorites become more underpriced over time |

**Recalibration formula**: `p* = p^θ / [p^θ + (1-p)^θ]` where θ varies by domain and time horizon:
- θ ≈ 1.83 for politics at 1-week horizon
- θ ≈ 1.74 for sports beyond 1 month
- θ ≈ 0.69 for weather within 48h (inverted — overconfidence)

Source: Le 2026 — Decomposing Crowd Wisdom (arXiv 2602.19520)

### Model 5: Weather Market Trading — $24K-$65K documented

- Bots exploit gap between NOAA/GFS meteorological forecasts and casual market participants' pricing
- Professional weather forecasts are 85-90% accurate on 1-2 day horizons
- One bot turned $1,000 into $24,000 trading only London weather
- Another pulled $65,000 across NYC, London, Seoul weather markets
- Single weather markets clear $300K-$400K in 24-hour volume
- Implementation: 31-member GFS ensemble forecasts, Kelly criterion sizing, scan every 2 minutes
- Edge persists because casual bettors keep entering based on gut feelings
- Demonstrates: **domain-specific data advantage beats general intelligence**

Source: Dev Genius weather bot article, multiple Twitter reports

### Model 6: Cross-Platform Arbitrage (Polymarket + Kalshi) — $40M/year total

- Buy YES on one platform, NO on another when combined cost < $1.00
- Captured spreads of 1.5-4.5% on Fed Rates and Election markets
- **But**: Opportunity duration has shrunk from 12.3 seconds (2024) to 2.7 seconds (Q1 2026)
- 73% of profits captured by sub-100ms bots
- Key limitation: "Prices can move between your first and second API call"
- Open-source: `realfishsam/prediction-market-arbitrage-bot` using `pmxt` unified API

### Model 7: Cross-Market Correlation Arbitrage — ~20% returns

- IBM + Columbia paper: AI agent discovers linked/correlated prediction markets and trades relationships
- Example: "Chiefs win" priced at 28% while "AFC team wins" priced at 24% — mathematically impossible since Chiefs are in AFC
- Pure math, no prediction needed. Win rate 70-80%, average holding period 2.3 days
- LLM identifies the logical links, math finds the mispricing
- ~20% average return over week-long holding periods

### Model 8: Market Making / Liquidity Provision

- Early LPs reported $200-300/day on $10K capital; scaled to $700-800/day at peak
- Polymarket distributes $5M+ monthly in liquidity incentives (April 2026)
- Makers pay $0 fees and earn daily rebate of 20-25% of taker fee collected from counterparty
- Rewards stack: liquidity rewards + maker rebates
- **Realistic steady-state**: ~10% APY on calm long-dated markets

**Profitability tiers:**
| Capital | Approach | Monthly Potential |
|---------|----------|-------------------|
| $1K-5K | Single market, learning | $50-200 |
| $5K-25K | Multiple markets, semi-auto | $200-1K |
| $25K-100K | Full automation, diverse | $1K-5K |
| $100K+ | Professional, cross-platform | $5K-20K+ |

**Key requirements:**
- Sub-10ms latency for controlled components
- Automatic withdrawal 2 minutes before major news events
- Dynamic spread adjustment based on volatility
- Never >30% allocation to one side
- VPS with 4+ CPU cores, 8-16GB RAM, NVMe, US East Coast

**WARNING**: The open-source poly-maker author explicitly warns: "In today's market, this bot is not profitable and will lose money." The Substack author who cloned it also reports zero net profit. Directional risk (single 30-40% adverse move) can wipe accumulated gains.

### Model 9: High-Probability "Bond" Strategy

- Buying near-certain outcomes (95%+) for modest returns
- Finding 2 weekly opportunities at 5% yields ~520% simple annual return
- Some traders earned >$150K/year
- **Critical asymmetry**: At $0.95, one failed bond wipes out 19 successful ones. At $0.97, one loss wipes out 32 wins
- 90%+ of large orders ($10K+) occur at prices above $0.95

### Model 10: Oracle Lag / Latency Arbitrage

- Chainlink RTDS updates in under a second, but traders take ~55 seconds on average to adjust orders
- One wallet turned $313 into $414,000 in one month (98% win rate, 6,615 predictions)
- Backtested: 61.4% win rate over 5,017 trades across BTC, ETH, XRP, SOL
- **Paper-to-live gap is severe**: Paper trading showed 522x returns; live execution showed -49.5% due to 2-4 cent slippage + fees
- **Polymarket response**: Dynamic taker fees reaching ~3.15% at 50-cent contracts, specifically designed to kill this
- Average arb window compressed from 12.3s (2024) to 2.7s (2026)
- 73% of arb profits captured by sub-100ms bots

---

## Part 3: LLM Probability Estimation — What the Research Actually Shows

### KalshiBench Results (Academic — 300 questions, verified outcomes)

- **All frontier LLMs are systematically overconfident**: When expressing 90%+ confidence, models achieve only 30-70% accuracy
- **Claude Opus 4.5** is the best-calibrated model (ECE=0.120, Brier=0.227) but still trails human superforecasters (Brier 0.15-0.20, ECE ~0.03-0.05)
- **Extended reasoning WORSENS calibration** — GPT-5.2-XHigh with reasoning showed triple the calibration error of simpler modes
- Only Claude Opus 4.5 achieved positive Brier Skill Score (0.057); most models performed worse than simply predicting the base rate
- LLMs are strongest on Entertainment (78.7%) and Sports (75.9%), weakest on Crypto (36.4%) and Science/Technology (0%)

### LiveTradeBench (50 days, 21 models, live money)

Six frontier models traded live with $10K each:
- **Best Polymarket performer**: Claude-Sonnet-3.7 at **+20.54%** return
- **Worst**: Qwen3-235B-Thinking at **-57.62%**
- **No generalization across markets**: Spearman correlation between stock and Polymarket performance approaches zero
- **General capability is NEGATIVELY correlated with trading performance** (LMArena score vs Polymarket returns: -0.38)
- **Reasoning models underperformed**: DeepSeek-R1, Qwen3-Thinking, GPT-o3 showed substantially higher volatility (>140%)
- Top performers distinguished themselves through **volatility control**, not aggressive positions
- LLM decisions referenced news >60% of the time, price history 40-50%
- **Research volume showed zero correlation with performance** — information synthesis quality, not quantity, drives results

### Practical LLM Strategy Insights

- Multi-model consensus (3+ LLMs) significantly outperforms single-model estimates
- Tight agreement (Claude 65%, GPT-4o 63%, Gemini 67%) suggests reliable signal; wide divergence = skip
- Two-stage workflow recommended: (1) rapid screening of 15-20 markets in 2-3 min each, (2) deep analysis with full prompt on flagged candidates
- **Bayesian updating on new information** is where LLMs add the most value
- In head-to-head tests, Claude-powered arrangement achieved 1,322% return while OpenClaw-driven setup was liquidated completely

### Model comparison for different domains:
- **Claude**: Best for complex political/legal markets, structured reasoning
- **GPT-4o**: Best for rapid multi-market screening, breadth
- **Gemini Pro**: Best for economic data markets
- **DeepSeek R1**: Best for complex multi-outcome scenarios

### What NOT to do with LLMs:
1. Do not rely on high-confidence predictions — expect 20-30% error rates even at 90%+ confidence
2. Do not use extended reasoning modes for probability estimation (worsens calibration)
3. Do not use LLMs as sole oracle — combine with market data, polls, other research
4. Do not skip post-hoc calibration (Platt scaling/temperature scaling)
5. Do not assume more research = better predictions (zero correlation found)

---

## Part 4: Position Sizing Research

### Kelly Criterion Findings

- Full Kelly has a **1/3 chance of halving your bankroll** before doubling it
- Half Kelly drops this to **1/9**
- **Quarter Kelly** reduces it further while retaining ~56% of long-run growth rate
- Community consensus among profitable Polymarket traders: **quarter-Kelly**
- Simulations show even with 50% uncertainty in edge estimates, optimal bet size decreases by only ~5%
- Real value of fractional Kelly: protects against edge overestimation + drawdown sensitivity + model failures simultaneously

### Position Management > Entry Quality

- SeriouslySirius: 53.3% win rate but $1.3M profit because profit/loss ratio is 2.52x
- The beachboy4 case: 51% win rate, **lost $2M** in 35 days due to:
  - Average bet size ~$400K with no position limits
  - Bought at high prices ($0.51-$0.67), only 50-90% upside but 100% downside
  - No stop-losses, hedging, or early exits
  - Losing positions ran to zero
- Academic data confirms: most losses come from poor exits, not bad entries

---

## Part 5: Competitive Landscape & Tools

### Notable Open-Source Repos

| Repo | Language | Strategy | Notes |
|------|----------|----------|-------|
| `Polymarket/agents` | Python | Official LLM agent framework (RAG + CLOB) | 2,900 stars, MIT license |
| `warproxxx/poly-maker` | Python | Market making with Google Sheets config | Author warns unprofitable now |
| `dylanpersonguy/Fully-Autonomous-Polymarket-AI-Trading-Bot` | Python | Multi-model ensemble, 15+ risk checks, Kelly | Most similar to our architecture |
| `NavnoorBawa/polymarket-prediction-system` | Python | 5-model stacking ensemble, quarter-Kelly, Platt calibration | Reports 95% direction accuracy |
| `realfishsam/prediction-market-arbitrage-bot` | Python | Cross-platform Polymarket+Kalshi arb | Used `pmxt` unified API |
| `echandsome/Polymarket-betting-bot` | TypeScript | Copy trading + odds-based strategies | Well-structured |
| `ent0n29/polybot` | Java+Python | Microservices, ClickHouse analytics, strategy reverse-engineering | Serious infra |
| `Archetapp BTC Bot Gist` | Python | 7-indicator BTC Up/Down 5min bot | Detailed, practical |

### PolySwarm Architecture (Academic Paper)

50 diverse LLM personas with distinct analytical archetypes. Each uses chain-of-thought prompting requiring explicit reasoning and confidence levels. Aggregation: confidence-weighted Bayesian combination: `p_combined = 0.70 * p_swarm + 0.30 * p_market`. Uses quarter-Kelly sizing with 30% max standard deviation gate.

Latency arb module derives CEX-implied probabilities using: `p_cex = Phi(ln(S/K) / (sigma * sqrt(T)))` — Black-Scholes-style log-normal model.

### Platform Changes

- **CLOB v2 + CTF Exchange V2** announced (April 2026): New order struct, faster matching engine, migration from USDC.e to native "Polymarket USD", EIP-1271 support. SDK update required. At least 1 week notice before cutover, 2-3 week rollout.
- **Dynamic taker fees** (March 2026): Up to ~3.15% on 50-cent contracts. Specifically targets latency arb. Maker rebates preserved.
- **$5M+/month in maker incentives** (April 2026): 100% of taker fees redistributed to makers. Finance gets 50% rebate share.

### Copy Trading Counter-Measures

- Top traders now use secondary/tertiary accounts and run decoy trades
- "The more popular a wallet becomes for copy trading, the less profitable it is to copy"
- Hubble AI (tracked 90,000 wallets): "The Polymarket Leaderboard is a lie. It shows you the lucky survivors, not the skilled winners."
- Counter-measures: execution lag between whale fill and copytrader fill erodes edge

---

## Part 6: Common Failure Modes

### Bot-Specific Failures
- **44% of published trading strategies fail to replicate** on new data
- **95% of AI trading bots lose money within 90 days**
- Paper-to-live gap can be enormous (522x paper vs -49.5% live)
- Thin markets: positions look cheap to enter but have no exit path
- Spreads of 5-10% can trap anyone sizing too big
- Overfitting to historical data

### The Top 10 Expensive Mistakes
1. Trading without reading resolution criteria
2. Averaging down on losing positions
3. Confusing narrative with probability
4. Ignoring base rates
5. Overconcentration (30%+ bankroll on single market)
6. Chasing moved markets (paying for someone else's edge)
7. Trading illiquid markets at face value
8. Recency bias
9. Outcome bias (judging process by single result)
10. Not keeping records

### Liquidity Trap Warning
- A position can show large paper profits but that value is theoretical until someone buys it
- Low-liquidity markets: buying is easy, selling is practically impossible
- When a market has little demand, prices are an illusion

---

## Part 7: Our System's Specific Problems (Diagnosed from Logs + Research)

### The OSINT Pipeline Funnel (from trade.log analysis, 2026-04-13)

| Stage | Count | Drop |
|---|---|---|
| Items ingested per cycle | ~2,400 | — |
| New (after dedup) | handful/cycle | ~95% deduped |
| Scored items | 849 | — |
| Score >= 7 (lowest threshold) | 158 (19%) | 81% killed |
| Score >= 8 (geo/macro/crypto threshold) | 118 (14%) | 86% killed |
| Reached entity extractor | 519 | — |
| No candidate market found | 160 | — |
| Reached divergence calc | 206 | — |
| hasTrade:true | **1** | — |

That one trade was a Magic vs. Celtics NBA game.

### Skip reasons for the 206 divergence results:
- `extreme_price_llm_distrust`: ~130 (63%) — LLMs defaulting to ~50% on tail markets
- `too_long_dated`: ~22 (11%) — geopolitical markets resolve months out
- `zone3_edge_below_fee_buffer`: ~14 (7%) — mid-range markets need 10% edge
- `noisy_signal` (stddev >0.08): 10 (5%) — LLMs disagree with each other
- `too_soon_expiring`: 6 (3%)
- `zone5_widow_maker`: 2 (1%)
- `negative_ev`: 1 (<1%)

### Five structural problems mapped to research:

1. **LLMs default to ~50% on uncertain events** → Confirmed by KalshiBench: all LLMs systematically overconfident, poor calibration on geopolitical
2. **Entity extractor hits same extreme-priced junk** → We're buying YES on longshots, which the research shows is the losing side
3. **Urgency scoring kills 85% of items** → By score 8+, market has already repriced. Pipeline is too slow
4. **Zone 4/5 blocks prevent trading favorites** → Research shows political favorites at 70-90¢ are systematically underpriced
5. **We're takers in a maker's market** → -1.12% structural disadvantage per trade

---

## Part 8: Redesign Recommendations

### New Revenue Streams to Build

1. **NegRisk multi-outcome arbitrage scanner** — Pure math, no prediction. $29M/year platform-wide. We already scan multi-outcome markets.
2. **Weather market scanner** — Free NOAA/GFS data vs casual bettors. Low competition, verifiable edge.
3. **Cross-market correlation arbitrage** — LLM finds logical links, math finds mispricing. 70-80% win rate.
4. **Calibration bias exploitation** — Apply domain-specific recalibration formula to unlock trades currently blocked by divergence threshold.
5. **Longshot bias exploitation** — Systematically sell YES / buy NO on overpriced cheap contracts instead of trying to estimate their true probability.

### Existing System Improvements

6. **Domain-specific calibration correction** — Transform raw LLM consensus → calibrated probability using Le 2026 recalibration formula per domain and time horizon.
7. **Flip from taker to maker on directional trades** — Expand maker execution path. +1.12% structural edge per trade.
8. **Quarter-Kelly instead of half-Kelly** — Community consensus. Reduces ruin probability further.
9. **Direction-only signals instead of probability estimation** — "Which way does this news push?" not "What probability does it imply?" Faster, more reliable.
10. **Unblock Zone 4 for political favorites** — Research shows 70-90¢ political contracts are underpriced. Remove or relax the block.
11. **Lower urgency thresholds or remove entirely** — The urgency gate is the #1 bottleneck. Consider replacing with a faster, lighter-weight relevance filter.
12. **Improve entity extraction** — Stop matching multi-outcome junk markets. Filter by market type and minimum liquidity before LLM calls.
13. **Post-hoc probability calibration** — Apply Platt scaling or temperature scaling to LLM outputs before divergence calculation.

### Copy Trading Improvements

14. **Counter counter-measures** — Multi-wallet consensus, execution timing jitter, whale quality scoring beyond leaderboard
15. **Domain-specialist wallet identification** — Track per-category win rates to find domain experts rather than lucky generalists

### Infrastructure

16. **Prepare for CLOB v2 migration** — New order struct, native Polymarket USD, SDK update required
17. **Maker rebate farming** — Position for $5M+/month in maker incentives
18. **Reduce cron interval for breaking news** — 5 minutes is too slow for news-reactive trading

---

## Key Academic Sources

1. Becker — Microstructure of Wealth Transfer in Prediction Markets (maker/taker analysis)
2. Le 2026 — Decomposing Crowd Wisdom (calibration biases, 292M trades, arXiv 2602.19520)
3. Whelan — Makers and Takers on Kalshi / Pricing and Losses
4. IMDEA — Unravelling the Probabilistic Forest (arbitrage analysis, 86M bets, arXiv 2508.03474)
5. Harvard — From Iran to Taylor Swift (insider trading, $143M anomalous profit)
6. KalshiBench — LLM Epistemic Calibration (arXiv 2512.16030)
7. LiveTradeBench — 21 LLMs trading 50 days (arXiv 2511.03628)
8. Prediction Arena — Benchmarking AI on Prediction Markets (arXiv 2604.07355)
9. PolySwarm — Multi-Agent LLM Framework (arXiv 2604.03888)
10. Anatomy of Polymarket — 2024 Election (arXiv 2603.03136)
11. Kelly Criterion Application to Prediction Markets (arXiv 2412.14144)

## Key Community Sources

- Polymarket Newsletter (official): Automated Market Making, Copytrade Wars
- warproxxx/poly-maker (GitHub): Market making bot + honest postmortem
- navnoorbawa (Substack): Quantitative prediction system with Platt calibration
- tezlee (Substack): Market making bot clone experiment
- realfishsam (DEV Community): Cross-platform arbitrage bot
- Medium/Illumination: "4 Polymarket Strategies Bots Profit From in 2026"
- Finance Magnates: Prediction Markets Bot Playground, Dynamic Fees
- Yahoo Finance: Arbitrage Bots Dominate, beachboy4 $2M loss
- Dev Genius: Weather bot analysis
- DeFi Prime: Definitive Guide to Polymarket Ecosystem (170+ tools)
