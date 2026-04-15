/**
 * One-shot probe for Polymarket's Gamma `/public-search` endpoint.
 *
 * Runs a fixed set of representative entity queries against /public-search
 * with events_status=active and prints the top few titles + liquidity per
 * query. Used to re-verify the endpoint's ranking quality and filter
 * behavior before relying on it in production.
 *
 * Run: npx tsx scripts/probe-public-search.ts [q1 q2 ...]
 */

const BASE_URL = 'https://gamma-api.polymarket.com';

interface PublicSearchEvent {
  id?: string;
  title?: string;
  slug?: string;
  liquidity?: number | string;
  active?: boolean;
  closed?: boolean;
  markets?: { question?: string }[];
}

interface PublicSearchResponse {
  events?: PublicSearchEvent[];
  pagination?: { hasMore?: boolean; totalResults?: number };
}

const DEFAULT_QUERIES = [
  'iran',
  'trump',
  'war',
  'russia',
  'nuclear',
  'bitcoin',
  'ethereum',
  'fed rate cut',
];

async function probeOne(query: string, limit = 5): Promise<void> {
  const url = `${BASE_URL}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit.toString()}&events_status=active`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`[${query}] ${res.status.toString()} ${res.statusText}`);
    return;
  }
  const data = (await res.json()) as PublicSearchResponse;
  const events = data.events ?? [];
  const total = data.pagination?.totalResults ?? 'n/a';
  console.log(`\n=== q="${query}" (returned ${events.length.toString()} / total ${total.toString()}) ===`);
  events.slice(0, limit).forEach((e, i) => {
    const liq = typeof e.liquidity === 'number' ? e.liquidity : parseFloat(String(e.liquidity ?? '0'));
    const title = (e.title ?? '').slice(0, 80);
    console.log(`  [${i.toString()}] liq=${liq.toFixed(0).padStart(10, ' ')} closed=${String(e.closed ?? '?').padStart(5)} ${title}`);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const queries = args.length > 0 ? args : DEFAULT_QUERIES;
  console.log(`Probing /public-search against ${queries.length.toString()} queries...`);
  for (const q of queries) {
    // eslint-disable-next-line no-await-in-loop
    await probeOne(q);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
