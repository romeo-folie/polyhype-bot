# ingestion — Phase 1: Data Ingestion & Filtering

Scrapes and filters high-signal headlines across multiple market categories. Produces a list of high-urgency scored items for the mapping pipeline.

## Pipeline

```
Category RSS feeds ─┐
Geo scraper (GDELT) ─┼──► dedup (Redis) ──► LLM scorer (per-category) ──► filter by threshold ──► ScoredItem[]
                    ┘
```

## Modules

### `categories/`
Defines per-category ingestion configs (`CategoryConfig`) with feeds, scorer prompt, score threshold, and entity context.

#### CategoryConfig

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

#### Categories (Phase 5)

| Category | ID | Threshold |
|---|---|---|
| Geopolitical | `geopolitical` | 8 |
| Macro / Central Bank | `macro` | 8 |
| Crypto / Regulatory | `crypto-regulatory` | 8 |
| AI / Tech Company Events | `ai-tech` | 7 |
| US Politics (Non-Election) | `us-politics` | 7 |

### `rss.ts`
Fetches headlines from configured RSS feeds using [rss-parser](https://github.com/rbren/rss-parser). Supports per-feed headers and redirects.

Returns `RssItem[]` — normalised to `{ title, url, publishedAt, source }`.

### `scraper.ts`
GDELT v2 fetcher for geopolitical headlines (combined thematic query).

Falls back to empty array on fetch/parse failure — never aborts the pipeline.

### `dedup.ts`
Redis-backed deduplication layer. Keys are SHA-256 hashes of the item URL.

- `filterSeen(items, redis)` — returns only items not yet seen; marks all as seen (TTL: 48 h)

Prevents the same headline from being scored and traded multiple times within 48 hours.

### `scorer.ts`
Batches headlines (up to 10 per call) and sends them to an LLM for category-specific urgency scoring.

- Provider priority: **Gemini Flash** → **OpenAI GPT-4o-mini** (fallback)
- Returns `ScoredItem[]` — extends `RssItem` with `urgencyScore: number` (1–10) and `keywords: string[]`
- On total LLM failure: assigns score `1` and empty keywords (pipeline continues)

### `index.ts`
Cron entrypoint. Runs all categories in parallel: RSS + (optional) scrape → dedup → score → filter by `CategoryConfig.scoreThreshold`.

```ts
const items: ScoredItem[] = await runIngestion();
// items.urgencyScore >= category.scoreThreshold
```

## Entry point

```bash
npx tsx src/ingestion/index.ts
# or via package.json:
npm run cron:ingest
```
