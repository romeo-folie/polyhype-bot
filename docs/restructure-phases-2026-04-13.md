# Full System Restructure — Implementation Phases
**Date**: 2026-04-13
**Based on**: `docs/research-polymarket-bot-strategies-2026-04-13.md`

---

## The Core Problem (from research + logs)

Our pipeline produces **1 trade per log rotation**. The research explains exactly why:

1. **We're takers in a maker's market** — -1.12% structural drag per trade
2. **We buy YES on longshots** — the losing side at 69/99 price levels
3. **LLMs default to ~50% on uncertainty** — 63% of divergence results killed by `extreme_price_llm_distrust`
4. **Zone 4/5 blocks prevent trading favorites** — where the research says the actual edge is (political favorites at 70-90¢ are underpriced)
5. **Urgency scoring kills 85%** — by score 8+, the market has already repriced
6. **No pure-math strategies** — we're ignoring NegRisk arb ($29M/year), weather ($24-65K documented), and cross-market correlation (70-80% win rate)

---

## Phase Overview

| Phase | Name | Evidence Strength | New Revenue? | Effort |
|-------|------|-------------------|-------------|--------|
| **0** | Pipeline Unblocking | Academic + logs | No — fixes existing | Small |
| **1** | Maker-First Execution | Academic (86M trades) | +1.12%/trade + rebates | Medium |
| **2** | NegRisk Multi-Outcome Arb | Academic + on-chain ($29M/yr) | Yes — pure math | Large |
| **3** | Calibration Bias Exploitation | Academic (292M trades) | Yes — unlocks blocked trades | Medium |
| **4** | Weather Market Scanner | Documented ($1K→$24K) | Yes — new domain | Medium |
| **5** | Longshot Bias / NO-Side Scanner | Academic (300K contracts) | Yes — structural edge | Medium |
| **6** | Cross-Market Correlation Arb | Academic (IBM+Columbia) | Yes — 70-80% WR | Large |
| **7** | OSINT Pipeline Overhaul | LiveTradeBench + KalshiBench | No — fixes existing | Large |
| **8** | Copytrade Hardening | On-chain + copy trading article | No — improves existing | Medium |
| **9** | Infrastructure & CLOB v2 | Platform announcement | Defensive | Medium |

---

## Phase 0: Pipeline Unblocking (Quick Wins)

**Goal**: Make the existing pipeline actually produce trades by removing the gates that research proves are wrong.

### 0.1 Quarter-Kelly sizing
- Change from half-Kelly (0.5×) to quarter-Kelly (0.25×)
- Community consensus among profitable traders
- Reduces ruin probability from 1/9 to much lower
- Code change in `src/mapping/divergenceCalculator.ts` (line ~238, the 0.5 multiplier)

### 0.2 Unblock Zone 4 for political favorites
- Research shows 70-90¢ political contracts are systematically underpriced (θ=1.83 means a 70¢ contract has ~83% true probability)
- Currently `ZONE4_DIRECTIONAL_BLOCK=true` and `ZONE5_DIRECTIONAL_BLOCK=true` kill these trades
- Relax for political/macro categories at minimum
- Config: `src/shared/config.ts` lines 116-117

### 0.3 Urgency threshold rethink
- Currently `URGENCY_THRESHOLD=7` kills 81% of scored items
- The bottleneck isn't item quality — by the time something scores 8+, the market has repriced
- Options: lower threshold, or replace urgency scoring with a faster relevance filter (direction-only: "does this news push this market up or down?")

### 0.4 Entity extraction cleanup
- Stop matching multi-outcome junk markets
- Currently `extreme_price_llm_distrust` kills 63% of divergence results because we're matching against low-priced outcomes in multi-outcome markets
- Filter by `outcomes.length === 2` + minimum liquidity *before* LLM calls

### 0.5 Noise gate relaxation
- `NOISE_STDDEV_THRESHOLD=0.08` kills 5% of signals
- With quarter-Kelly sizing protecting downside, we can afford slightly noisier signals
- Consider raising to 0.10-0.12

---

## Phase 1: Maker-First Execution Revolution

**Goal**: Flip our structural disadvantage (+1.12%/trade swing) and position for $5M+/month in maker incentives.

### 1.1 Expand maker eligibility
- Currently only `source === 'osint'` can use maker path (`executor.ts:117-119`)
- Research says makers profit on ALL order flow, not just slow signals
- Expand to: copytrade (whale fills are not time-critical for us), near-zero scanner, calibration-bias trades
- Keep taker-only for: crypto arb (latency-sensitive), oracle-lag, spot momentum

### 1.2 Optimize maker pricing
- Current `MAKER_PRICE_EDGE_BPS=20` is aggressive
- Research shows makers profit by "accommodating biased order flow" — can be slightly less aggressive (30-50 bps) and still capture structural edge while getting better fill rates

### 1.3 Maker exit expansion
- `MAKER_EXIT_ENABLED` is currently off
- Enable for all non-urgent exits (TP, trailing, stale, trend)
- Stop-loss stays taker (urgent)
- `MAKER_EXIT_ELIGIBLE_REASONS` config already supports this

### 1.4 Rebate farming strategy
- Polymarket distributes 100% of taker fees to makers
- Finance markets get 50% rebate share
- Consider placing resting orders on high-volume markets even without strong directional view (passive liquidity provision for rebates)

---

## Phase 2: NegRisk Multi-Outcome Arbitrage

**Goal**: Tap into the $29M/year pure-math arb opportunity. No prediction needed.

### 2.1 Multi-outcome market discovery
- Current system explicitly filters `outcomes.length !== 2` in `scanner.ts:88`
- Discover NegRisk markets via Gamma API (`negRisk=true` flag)
- Build dedicated scanner that fetches all active NegRisk events and their constituent markets

### 2.2 Sum-of-prices scanner
- For each NegRisk event with N outcomes, compute `sum(YES_prices)`
- When `sum < 1.00 - total_fees`, guaranteed profit
- Gap persists longer than binary arb (minutes vs seconds per research)

### 2.3 Atomic multi-leg execution
- Buy YES on ALL outcomes simultaneously
- Handle: partial fills (what if leg 3 of 5 fails?), rounding to tick sizes, fee calculation across N legs
- CLOB SDK already supports NegRisk orders

### 2.4 Risk management
- Max exposure per event
- Circuit breaker on partial fills
- Unwind logic for stuck legs

---

## Phase 3: Calibration Bias Exploitation

**Goal**: Apply the Le 2026 recalibration formula to unlock trades currently blocked by incorrect probability estimates.

### 3.1 Domain-specific market recalibration
Implement `p* = p^θ / [p^θ + (1-p)^θ]` where θ varies by domain:
- Politics: θ=1.83 (underconfident market → buy favorites)
- Sports >1mo: θ=1.74 (underconfident → buy favorites)
- Weather <48h: θ=0.69 (overconfident market → sell)
- Crypto: θ≈1.0 (well-calibrated, minimal adjustment)
- Entertainment: largest optimism gap → sell longshots

### 3.2 Apply as post-LLM correction
- After LLM consensus but before divergence calculation
- Calibration correction transforms market price to "true probability", changes edge calculation
- Goes in `divergenceCalculator.ts` as new step before edge computation

### 3.3 Alternative: market-price correction
- Instead of adjusting our estimate, adjust the market price to reflect structural bias
- E.g., political market at 70¢ → treat as "true efficient price" 83¢ → our 75% LLM estimate now shows negative edge (correct!) but 88% estimate shows real edge

### 3.4 Post-hoc LLM calibration (Platt scaling)
- Separate from market bias
- Use accumulated `calibration:*` Redis data to fit logistic correction to LLM outputs
- E.g., when LLM says 80%, historical resolution rate might be 65% — Platt scaling corrects

---

## Phase 4: Weather Market Scanner

**Goal**: New revenue stream exploiting gap between NOAA forecasts and casual bettors. Documented $1K→$24K.

### 4.1 NOAA/GFS data integration
- Free 31-member GFS ensemble forecasts updated every 6 hours
- Parse GRIB2 data for temperature, precipitation probability at target cities (NYC, London, Seoul)

### 4.2 Weather market discovery
- Scan Gamma API for weather tag/category
- Weather markets are typically "Will temperature in NYC exceed X°F on date Y?" — structured, verifiable

### 4.3 Probabilistic edge calculation
- GFS ensemble gives probability distribution directly (31 members → empirical CDF)
- No LLM needed for core probability
- Edge = `GFS_probability - market_price`

### 4.4 Weather-specific calibration
- Research shows weather markets are *overconfident* at short horizons (θ=0.69)
- Sell side is structurally favored for <48h weather markets

### 4.5 Scanning cadence
- Research recommends every 2 minutes for weather
- Current cron is 5+ minutes
- Weather-specific fast-poll loop

---

## Phase 5: Longshot Bias / NO-Side Scanner

**Goal**: Exploit the favorite-longshot bias. NO outperforms YES at 69/99 price levels.

### 5.1 NO-side scanner
- New scanner: look for overpriced cheap contracts (3-15¢ range) and buy NO instead of YES
- Current near-zero scanner tries to find *underpriced* cheap outcomes — research says this is the losing side

### 5.2 Systematic sell-YES / buy-NO
- Entertainment/media markets (4.79-7.32 pp optimism gap)
- Sports (2.23 pp)
- Political longshots
- Finance exempt (0.17 pp gap)

### 5.3 Multi-outcome longshot detection
- In NegRisk markets with N outcomes, identify 1-2 outcomes receiving disproportionate retail YES flow
- Sell YES on those outcomes (or equivalently, buy NO)

### 5.4 Rework near-zero scanner
- Currently configured to find YES opportunities at 3-10¢
- Flip to: find outcomes priced at 3-15¢ where YES side is overpriced (takers buying YES = optimism tax)
- Buy NO at 85-97¢

---

## Phase 6: Cross-Market Correlation Arbitrage

**Goal**: LLM finds logical links between markets, math finds the mispricing. 70-80% win rate documented.

### 6.1 Market relationship discovery
- LLM analyzes pairs/groups of markets for logical constraints
- E.g., "Chiefs win Super Bowl" at 28% while "AFC team wins Super Bowl" at 24% — impossible since Chiefs are AFC

### 6.2 Constraint graph
- Build graph of logical relationships: implication (A→B means P(A)≤P(B)), mutual exclusion, subset relationships
- Cache in Redis

### 6.3 Violation scanner
- Periodically check all constraint edges for violations
- When `P(A) > P(B)` but `A implies B`, arb: buy B, sell A

### 6.4 Execution
- Enter both legs
- Hold until markets converge or resolve
- Average holding period 2.3 days per research

---

## Phase 7: OSINT Pipeline Overhaul

**Goal**: Make the news→trade pipeline faster and more reliable based on LLM research findings.

### 7.1 Direction-only signals
- Instead of "what probability does this news imply?", ask "which direction does this push?" (UP/DOWN/NEUTRAL)
- Faster, more reliable, avoids LLM calibration problem
- Only estimate magnitude for sizing

### 7.2 Two-stage workflow
- Stage 1: rapid screening of 15-20 markets per cycle (2-3 min each, lightweight LLM call)
- Stage 2: deep analysis with full prompt only on flagged candidates
- Cuts LLM cost and latency

### 7.3 Faster ingestion cadence
- 5-minute cron is too slow for news-reactive trading
- Move to 1-2 minute cycles for breaking news categories (geopolitical, crypto-regulatory)
- Keep 5min for slow categories

### 7.4 Bayesian updating
- Track LLM estimates over time per market
- When new information arrives, update prior instead of re-estimating from scratch
- This is where LLMs "add the most value" per research

### 7.5 Model routing by domain
- Research shows different models excel at different domains:
  - Claude for political/legal
  - GPT-4o for rapid screening
  - Gemini for economic
  - DeepSeek for multi-outcome
- Route LLM calls by market category

---

## Phase 8: Copytrade Hardening

**Goal**: Improve copytrade execution quality and filter signal from noise. Article analysis shows the execution quality gap between whale fill and copier fill is where most edge evaporates — copying bots = becoming exit liquidity. Only manual directional traders with large edge (tens of percent) are suitable targets.

### 8.1 Bot vs. human trade classification
- A whale's activity may be 80% automated market-making and 20% directional conviction bets — only the latter is worth copying
- Classify by: order size relative to book depth, time-of-day patterns, market category (bot activity concentrates on high-volume liquid markets), fill pattern (bots fill many small orders rapidly, humans place fewer large orders)
- Skip signals that look like market-making or automated activity
- This is the highest-impact filter — without it, we're copying noise trades and providing exit liquidity to faster bots

### 8.2 Proportional sizing (portfolio mirror)
- Current system uses fixed `COPYTRADE_STAKE_USD` regardless of whale conviction
- Ratio-style approach: size proportionally to whale's portfolio allocation (`whaleStakeUsd / whaleEstimatedBankroll`)
- If a whale puts 5% of their portfolio into a market, we put 5% of ours — conviction signal embedded in sizing
- Need a bankroll estimator per tracked wallet (sum of open positions + recent closes)

### 8.3 Execution quality protection
- **Slippage guard**: compare current best ask against whale fill price, abort if drift exceeds threshold (e.g., 2-3%)
- **Per-market exposure cap**: prevent stacking multiple whale copies into the same market
- **Same-market dedup**: if we already have a copytrade position in a market, skip new signals for it
- **Fill-quality tracking**: log `(ourFillPrice - whaleFillPrice) / whaleFillPrice` to measure execution gap over time

### 8.4 Enable category specialist gate
- Already built and dark (`COPYTRADE_CATEGORY_SPECIALIST_ENABLED=false`)
- Stats tracking accumulating since 2026-04-09
- Check data sufficiency (need 10+ resolved trades per category per wallet), then flip

### 8.5 Multi-wallet consensus
- Don't mirror single whale
- Wait for 2+ tracked wallets to take same side before entering
- Reduces decoy trade risk

### 8.6 Execution timing jitter
- Add random 30-120s delay between whale detection and entry
- Prevents pattern detection by adversarial whales

### 8.7 Wallet selection heuristics (shortlist rework)
- Current shortlist over-indexes on leaderboard rank and total PnL — $900K case study shows the best copy targets are NOT the biggest whales
- **Low trade count** (<100 total bets): signals conviction-based trading, naturally excludes bots and market-makers. High trade count = automation or scalping = uncopyable.
- **High win rate in a specific category** (80%+ with 10+ resolved trades): niche specialists, not generalists. A trader who understands every MicroStrategy move or every Fed decision is worth more than a whale with 60% win rate across all categories.
- **Moderate position sizes** ($10K-$50K avg): the $40-50K range produces better copy targets than $1M+ whales. Big money ≠ edge — many large whales are market-making or taking high-profile bets with poor risk/reward.
- **Single-niche focus**: wallets concentrated in 1-2 categories are stronger signals than diversified portfolios. Our category specialist gate (8.4) already captures this — the shortlist should pre-filter for it.
- **Gradual trust ramp**: start copying new wallets at minimum size, increase allocation only after pattern confirmation (3-5 winning trades observed). Maps to a per-wallet trust score that scales `COPYTRADE_STAKE_USD`.

### 8.8 Whale quality scoring
- Beyond leaderboard: track Sharpe ratio, max drawdown, category hit rates per wallet
- Weight mirror sizing by whale quality
- Deprioritize wallets whose copies consistently show large execution gaps (they may be bots whose edge is latency-dependent and uncopyable)

---

## Phase 9: Infrastructure & CLOB v2

**Goal**: Defensive preparation for platform changes.

### 9.1 CLOB v2 migration
- New order struct, native "Polymarket USD" (not USDC.e), EIP-1271 support
- 1-week notice before cutover, 2-3 week rollout
- Need SDK update + order construction changes

### 9.2 Portfolio-level risk
- Track correlation between open positions
- Reduce Kelly fraction when entering correlated markets
- Current system sizes each trade independently

### 9.3 Regime detection
- Detect quiet→volatile transitions
- Widen stops in volatile regimes, tighten in quiet
- Use existing ATR/Bollinger infrastructure

---

## Recommended Sequencing

```
Phase 0 (Quick Wins)          ← START HERE
  ↓
Phase 1 (Maker-First)         ← biggest structural fix
  ↓
Phase 2 (NegRisk Arb)         ← highest revenue potential
  ↓ (can parallelize 3+4+5)
Phase 3 (Calibration Bias)    ← unlocks blocked trades
Phase 4 (Weather Scanner)     ← new revenue stream
Phase 5 (NO-Side Scanner)     ← structural edge exploit
  ↓
Phase 6 (Cross-Market Arb)    ← requires Phase 3's calibration work
  ↓
Phase 7 (OSINT Overhaul)      ← redesign after other revenue streams online
  ↓
Phase 8 (Copytrade)           ← incremental improvements
Phase 9 (Infrastructure)      ← whenever CLOB v2 timeline firms up
```

Phases 3, 4, and 5 can run in parallel since they're independent scanners. Phase 6 benefits from Phase 3's calibration infrastructure. Phase 7 is a larger redesign that makes more sense once other revenue streams are producing trades (reduces pressure on OSINT pipeline as sole trade source).

---

## Key Academic Sources

1. **Becker** — Microstructure of Wealth Transfer (maker/taker +/- 1.12%)
2. **Le 2026** — Decomposing Crowd Wisdom (calibration biases, recalibration formula, arXiv 2602.19520)
3. **Whelan** — Makers and Takers / Pricing and Losses (favorite-longshot bias)
4. **IMDEA** — Unravelling the Probabilistic Forest ($29M NegRisk arb, arXiv 2508.03474)
5. **KalshiBench** — LLM Epistemic Calibration (arXiv 2512.16030)
6. **LiveTradeBench** — 21 LLMs trading 50 days (arXiv 2511.03628)
7. **IBM+Columbia** — Cross-market correlation (70-80% win rate)
8. **Kelly Criterion** — Application to Prediction Markets (arXiv 2412.14144)
9. **Copy Trading Article** — Execution quality gap analysis, bot vs. human classification, portfolio mirror sizing (Ratio app), slippage protection systems
10. **$900K Copytrade Case Study** (@cryptosymbiiote) — Niche specialist wallet selection (<100 trades, 80%+ WR, $40-50K avg size, single category focus), gradual trust ramp, confirms bots/scalpers/insiders are uncopyable
