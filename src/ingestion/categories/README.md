# ingestion/categories — Category Registry

Defines the multi-category ingestion configurations for PGA. Each category provides:

- `feeds` (RSS sources, optional headers)
- `scorerPrompt` (domain-specific urgency rubric)
- `scoreThreshold` (minimum urgency for mapping)
- `entityContext` (hint for entity extraction)

## CategoryConfig

```ts
interface CategoryConfig {
  id: string;
  label: string;
  feeds: { url: string; headers?: Record<string, string> }[];
  scorerPrompt: string;
  scoreThreshold: number;
  entityContext: string;
}
```

## Categories

| ID | Label | Threshold | Feeds (examples) |
|---|---|---|---|
| `geopolitical` | Geopolitical | 8 | NYT World, Sky News World |
| `macro` | Macro / Central Bank | 8 | Federal Reserve, ECB, MarketWatch |
| `crypto-regulatory` | Crypto / Regulatory | 8 | CoinDesk, SEC 8-K, The Block |
| `ai-tech` | AI / Tech Company Events | 7 | TechCrunch, The Verge AI, DeepMind, HuggingFace, OpenAI, Meta AI |
| `us-politics` | US Politics (Non-Election) | 7 | Politico, GovTrack votes, NPR Politics |
