# mapping — Phase 2: Market Mapping & Execution Logic

Takes high-urgency OSINT items from Phase 1 and finds matching Polymarket contracts with exploitable divergence. Produces `TradeSignal[]` for Phase 3 execution.

## Pipeline

```
ScoredItem[]
  └──► extractEntities (LLM)
  └──► searchEvents (Gamma API) ──► CandidateMarket[]
         └──► estimateConsensusProbability (LLM) per market
                └──► computeDivergence + Half-Kelly sizing
                       └──► TradeSignal[]  (if edge ≥ DIVERGENCE_THRESHOLD)
```

## Modules

### `gamma.ts`
Typed client for the public [Polymarket Gamma API](https://gamma-api.polymarket.com).

- `searchEvents(opts)` — keyword search for active events + nested markets
- `getMarket(marketId)` — fetch a single market by ID (used by Phase 4 price fetcher)
- `parseOutcomePrices(raw)` — normalises `outcomePrices` from either JSON-encoded string (`'["0.72","0.28"]'`) or pre-parsed `string[]`
- `parseYesPrice(raw)` — extracts the YES price as a `number` from either form

> **Critical:** Gamma API v2 returns `outcomePrices` as a JSON-encoded string, not a parsed array. Always use `parseOutcomePrices()` — never `Array.isArray()` directly.

### `entityExtractor.ts`
Two responsibilities:
1. **Entity extraction** — given a headline, asks an LLM to extract geopolitical named entities (countries, leaders, organisations) as short search keywords (max 5).
2. **Market search** — queries Gamma with each keyword; de-duplicates by market ID; filters out markets with liquidity < 100 USDC.

Provider priority: **Gemini Flash** → **OpenAI GPT-4o-mini** (fallback). Falls back to scorer keywords if LLM extraction fails.

Returns `CandidateMarket[]` sorted by liquidity (highest first).

### `consensusCalculator.ts`
Asks an LLM: *"Given this market question, description, and breaking news headline — what is the true probability this resolves YES?"*

Returns `{ probability: number, reasoning: string }` where `probability ∈ [0, 1]`.

Provider priority: **Gemini Flash** → **OpenAI GPT-4o-mini** (fallback). Validates range strictly — throws on `probability < 0` or `> 1`.

### `divergenceCalculator.ts`
Pure functions, no I/O:

- `computeDivergence(input)` — computes edge (`consensus - marketPrice`), direction (`YES`/`NO`), and Half-Kelly stake. Returns `{ hasTrade, decision }`.
- `computeHalfKelly(p, price)` — Half-Kelly formula: `kelly = (b·p − q) / b`, stake = `kelly × 0.5 × bankroll`, capped at `MAX_BET_FRACTION`.

For NO trades, operates in complementary probability space: `outcomePrice = 1 - yesPrice`, `tradeProbability = 1 - consensusP`.

### `index.ts`
Orchestrator. For each item: find candidates (capped at 10 per item to bound LLM cost) → estimate consensus → compute divergence → collect signals.

```ts
const signals: TradeSignal[] = await runMapping(items, bankrollUsd);
```

## TradeSignal shape

```ts
interface TradeSignal {
  marketId: string;        // Gamma market ID
  conditionId: string;     // CLOB condition ID
  clobTokenIds: string[];  // [YES token, NO token]
  question: string;
  direction: 'YES' | 'NO';
  stakeUsd: number;        // Half-Kelly, capped at MAX_BET_FRACTION * bankroll
  edgeMagnitude: number;   // |consensus - marketPrice|
  consensusProbability: number;
  outcomePrice: number;    // Price of the outcome we're buying
  halfKellyFraction: number;
  sourcedFrom: string;     // Triggering headline
  reasoning: string;       // LLM reasoning for probability estimate
}
```
