import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { dedup } from '../shared/redis.js';
import {
  fetchWithTimeout,
  getMarketBySlug,
  getEventTagSlugs,
  parseClobTokenIds,
  parseOutcomePrices,
} from '../mapping/gamma.js';
import { getOpenPositions } from '../execution/positionLedger.js';
import { fetchCurrentPrice } from '../monitor/priceFetcher.js';
import { executeTakeProfit } from '../monitor/takeProfitExecutor.js';
import { getPriceFeed } from '../shared/feedSingleton.js';
import { recordCopytradeFilter, recordCopytradeMetric } from '../shared/telemetry.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import { notify } from '../execution/telegram.js';
import { checkTimeToResolution } from '../mapping/divergenceCalculator.js';
import { priceZoneOf } from '../shared/zones.js';
import type { Redis } from 'ioredis';
import type { TradeSignal } from '../mapping/index.js';
import type { ExitReason } from '../monitor/takeProfitEvaluator.js';
import type { Position } from '../execution/positionLedger.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_TRADE_LIMIT = 100;
const COPYTRADE_DEDUP_TTL_SECONDS = 7 * 24 * 3600;

interface ActivityTrade {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: 'TRADE';
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: 'BUY' | 'SELL';
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
}

export interface CopytradeResult {
  signals: TradeSignal[];
  exits: number;
}

export function parseWalletList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

// Keywords are checked as whole words (word-boundary anchored) to prevent
// short tokens like 'un' or 'cold' matching unrelated substrings.
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  weather: [
    'rain',
    'snow',
    'storm',
    'hurricane',
    'temperature',
    'precipitation',
    'tornado',
    'wind',
    'heat wave',
    'cold snap',
    'blizzard',
    'drought',
  ],
  geopolitical: [
    // Core conflict terms
    'war',
    'conflict',
    'invasion',
    'ceasefire',
    'nuclear',
    'military',
    'sanctions',
    'treaty',
    'embargo',
    'coup',
    'troops',
    'airstrike',
    'missile',
    'drone',
    'occupation',
    'hostage',
    'prisoner swap',
    // Diplomacy / international relations
    'diplomacy',
    'diplomatic',
    'peace deal',
    'peace talks',
    'summit',
    'sovereignty',
    'annexation',
    'prime minister',
    'foreign minister',
    // Countries / regions that drive most geopolitical markets
    'iran',
    'russia',
    'ukraine',
    'china',
    'taiwan',
    'israel',
    'hamas',
    'hezbollah',
    'nato',
    'north korea',
    'gaza',
    'venezuela',
    'myanmar',
    // International institutions
    'united nations',
    'iaea',
    'icc',
    'g7',
    'g20',
    // Nuclear / WMD specifics (catch markets like "enrichment of uranium")
    'uranium',
    'enrichment',
    'warhead',
    'ballistic',
  ],
  'sports-nba': ['nba', 'basketball', 'lakers', 'warriors', 'celtics', 'playoffs', 'finals', 'mvp'],
  'sports-nfl': ['nfl', 'american football', 'super bowl', 'touchdown', 'quarterback', 'playoffs'],
  'sports-nhl': [
    'nhl',
    'hockey',
    'stanley cup',
    'bruins',
    'rangers',
    'maple leafs',
    'canadiens',
    'panthers',
    'lightning',
    'capitals',
    'penguins',
    'flyers',
    'devils',
    'islanders',
    'red wings',
    'hurricanes',
    'senators',
    'sabres',
    'blackhawks',
    'stars',
    'wild',
    'avalanche',
    'blues',
    'predators',
    'jets',
    'oilers',
    'flames',
    'canucks',
    'kraken',
    'sharks',
    'ducks',
    'golden knights',
    'utah hockey',
    'mcdavid',
    'crosby',
    'ovechkin',
    'matthews',
    'power play',
    'face-off',
    'empty net',
  ],
  'sports-f1': [
    'formula 1',
    'formula one',
    'formula-1',
    'grand prix',
    'pole position',
    'drivers champion',
    'constructors champion',
    'verstappen',
    'hamilton',
    'norris',
    'leclerc',
    'bottas',
    'russell',
    'piastri',
    'sainz',
    'alonso',
    'ferrari',
    'mclaren',
    'red bull',
    'cadillac',
    'aston martin',
  ],
  'sports-mma': [
    'ufc',
    'mma',
    'bellator',
    'one championship',
    'mixed martial arts',
    'octagon',
    'pfl',
    'submission',
    'knockout',
    'by ko',
    'tko',
    'o/u rounds',
    'o/u 1.5 rounds',
    'o/u 2.5 rounds',
    'o/u 3.5 rounds',
    'decision',
  ],
  'sports-soccer': [
    'soccer',
    'fifa',
    'world cup',
    'champions league',
    'premier league',
    'epl',
    'la liga',
    'bundesliga',
    'serie a',
    'ligue 1',
    'mls',
    'liga mx',
    'europa league',
    // "win on YYYY-MM-DD" — match-day question pattern (e.g. "Will FC Köln win on 2026-04-17?")
    'win on',
    // Big-5 club names
    'köln',
    'koln',
    'dortmund',
    'münchen',
    'munich',
    'leverkusen',
    'wolfsburg',
    'arsenal',
    'tottenham',
    'chelsea',
    'barcelona',
    'real madrid',
    'atletico',
    'juventus',
    'inter milan',
    'ac milan',
    'ajax',
    'psg',
    'liverpool',
    'manchester',
    // Additional clubs surfaced from blocked trades
    'vejle',
    'silkeborg',
    'necaxa',
    'guadalajara',
    'tigres',
    'atlas fc',
    'atlas',
    'strasbourg',
    'ogc nice',
    'real sociedad',
    'getafe',
    'elche',
    'bournemouth',
    'leeds',
    'odense',
    'karagumruk',
    'karagümrük',
    'fc københavn',
    'copenhagen',
  ],
  'sports-mlb': ['mlb', 'baseball', 'world series', 'home run', 'pitcher'],
  'sports-tennis': [
    'tennis',
    'atp',
    'wta',
    'grand slam',
    'wimbledon',
    'roland garros',
    'french open',
    'us open',
    'australian open',
  ],
  sports: [
    'olympics',
    'nfl',
    'nba',
    'soccer',
    'fifa',
    'super bowl',
    'championship',
    'world cup',
    'mlb',
    'atp',
    'wta',
    'nhl',
    'hockey',
  ],
  'crypto-regulatory': [
    'bitcoin',
    'ethereum',
    'doge',
    'dogecoin',
    'sec',
    'etf',
    'bnb',
    'tao',
    'regulation',
    'coinbase',
    'binance',
    'halving',
    'solana',
    'xrp',
    'ripple',
    'shiba',
    'shib',
    'pepe',
    'crypto',
    'cryptocurrency',
    'blockchain',
  ],
  macro: [
    // Core macro indicators
    'fed',
    'inflation',
    'cpi',
    'pce',
    'ppi',
    'gdp',
    'recession',
    'unemployment',
    'nonfarm',
    'payrolls',
    'ism',
    'pmi',
    'retail sales',
    // Rates / monetary policy
    'interest rate',
    'rate cut',
    'rate hike',
    'rate hold',
    'fomc',
    'basis points',
    'bps',
    'yield',
    'bond',
    'federal funds',
    'quantitative',
    'balance sheet',
    // Institutions / officials
    'central bank',
    'federal reserve',
    'ecb',
    'boj',
    'bank of japan',
    'bank of england',
    'pboc',
    'rba',
    'imf',
    'powell',
    'yellen',
    'waller',
    'goolsbee',
    'kugler',
    'daly',
    'williams',
    // Trade / fiscal (moved here from geopolitical overlap)
    'tariff',
    'tariffs',
    'trade war',
    'trade deal',
    'trade deficit',
    'debt ceiling',
    'fiscal',
    'treasury',
    'dollar',
    'dxy',
    // Broader economic terms
    'economics',
    'jobs',
    'rate',
    'percentage',
  ],
  'ai-tech': ['openai', 'nvidia', 'gemini', 'anthropic', 'gpu', 'llm', 'silicon'],
  'us-politics': [
    'election',
    'biden',
    'trump',
    'senate',
    'congress',
    'white house',
    'democrat',
    'republican',
  ],
  mentions: [
    'mention',
    'phrase',
    'word',
    'speech',
    'press conference',
    'interview',
    'transcript',
    'say',
    'stated',
    'announced',
    'remark',
  ],
};

// Pre-compiled per-category regex (built once at module load, not per matchesCategory call).
// Multi-word phrases use a literal substring alternation; single words are \b-anchored.
const CATEGORY_REGEXES = new Map<string, RegExp>(
  Object.entries(CATEGORY_KEYWORDS).map(([cat, keywords]) => {
    const parts = keywords.map((kw) =>
      kw.includes(' ')
        ? kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape phrase for regex safety
        : `\\b${kw}\\b`,
    );
    return [cat, new RegExp(parts.join('|'))];
  }),
);

// Maps each scope name to the Gamma tag slugs that represent it.
// Used as a fallback when the keyword regex misses (e.g. obscure club/player names).
const SCOPE_TAG_ALIASES: Record<string, string[]> = {
  'sports-nhl': ['nhl', 'hockey'],
  'sports-nba': ['nba', 'basketball'],
  'sports-mlb': ['mlb', 'baseball'],
  'sports-nfl': ['nfl', 'american-football'],
  'sports-soccer': [
    'soccer',
    'football',
    'premier-league',
    'la-liga',
    'bundesliga',
    'serie-a',
    'ligue-1',
    'mls',
    'liga-mx',
    'champions-league',
    'europa-league',
  ],
  'sports-tennis': ['tennis', 'atp', 'wta'],
  'sports-f1': ['f1', 'formula-1', 'formula-one'],
  'sports-mma': ['mma', 'ufc'],
  weather: ['weather'],
  macro: ['economy', 'finance', 'business', 'macro', 'markets'],
  'crypto-regulatory': ['crypto', 'bitcoin', 'ethereum', 'defi', 'web3'],
  'us-politics': ['us-politics', 'politics', 'trump', 'congress', 'elections'],
  geopolitical: ['geopolitics', 'middle-east', 'russia', 'ukraine', 'china', 'israel', 'iran'],
};

// Soccer-specific Gamma tag slugs. Used by isSoccerMarket() to detect markets
// the venue itself classifies as soccer, regardless of question wording. Keeps
// the soccer notify-only filter robust against obscure leagues (Saudi Pro,
// J-League, Liga MX, etc.) that won't appear in any practical keyword list.
const SOCCER_TAG_SLUGS = new Set([
  'soccer',
  'football',
  'bundesliga',
  'german-bundesliga',
  'premier-league',
  'english-premier-league',
  'la-liga',
  'spanish-la-liga',
  'serie-a',
  'italian-serie-a',
  'ligue-1',
  'french-ligue-1',
  'mls',
  'major-league-soccer',
  'liga-mx',
  'mexican-liga-mx',
  'champions-league',
  'uefa-champions-league',
  'europa-league',
  'uefa-europa-league',
  'world-cup',
  'fifa-world-cup',
  'saudi-pro-league',
  'j-league',
  'j1-league',
  'j2-league',
  'japan-j1-league',
  'japan-j2-league',
  'k-league',
  'korean-k-league',
  'brasileirao',
  'brazilian-serie-a',
  'argentine-primera',
  'eredivisie',
  'primeira-liga',
  'super-lig',
  'turkish-super-lig',
  'a-league',
  'australian-a-league',
]);

/**
 * Decide whether a market is a soccer market, using Gamma tags as primary
 * signal and the keyword regex as fallback. Tags are the venue's own
 * classification — far more reliable than chasing every league/club name.
 */
export function isSoccerMarket(
  question: string,
  description: string | null,
  tagSlugs: string[],
): boolean {
  if (tagSlugs.some((slug) => SOCCER_TAG_SLUGS.has(slug))) return true;
  const text = `${question} ${description ?? ''}`.toLowerCase();
  return CATEGORY_REGEXES.get('sports-soccer')?.test(text) ?? false;
}

/**
 * Refine an `inferCategory` result using Gamma event tags. Used to rescue
 * categories that the regex missed because the question text was thin
 * (e.g. "Eastern Conference Playoff Series" — no NHL keywords, but the
 * event is tagged 'nhl'). Soccer tags take precedence so the soccer
 * notify-only gate fires even when the market also has the generic
 * `'sports'` tag.
 */
export function refineCategoryFromTags(category: string, tagSlugs: string[]): string {
  if (category !== 'unknown' && category !== 'sports') return category;
  if (tagSlugs.length === 0) return category;

  if (tagSlugs.some((s) => SOCCER_TAG_SLUGS.has(s))) return 'sports-soccer';
  if (tagSlugs.some((s) => s === 'nhl' || s === 'hockey')) return 'sports-nhl';
  if (tagSlugs.some((s) => s === 'nba' || s === 'basketball')) return 'sports-nba';
  if (tagSlugs.some((s) => s === 'nfl' || s === 'american-football')) return 'sports-nfl';
  if (tagSlugs.some((s) => s === 'mlb' || s === 'baseball')) return 'sports-mlb';
  if (tagSlugs.some((s) => s === 'tennis' || s === 'atp' || s === 'wta')) {
    return 'sports-tennis';
  }
  if (tagSlugs.some((s) => s === 'f1' || s === 'formula-1' || s === 'formula-one')) {
    return 'sports-f1';
  }
  if (tagSlugs.some((s) => s === 'mma' || s === 'ufc' || s === 'bellator')) {
    return 'sports-mma';
  }
  if (tagSlugs.includes('sports')) return 'sports';
  return category;
}

/**
 * Check if a market title or description matches any keyword from the allowed categories.
 * Keywords are matched as whole words (primary path — zero HTTP cost).
 *
 * Pass `tagSlugs` from `getEventTagSlugs()` to enable the tag-based fallback layer.
 * Tags are only checked when the keyword pass returns false — callers should
 * fetch tags lazily rather than unconditionally.
 */
export function matchesCategory(
  title: string,
  description: string | null,
  allowedScopes: string[],
  tagSlugs?: string[],
): boolean {
  if (allowedScopes.includes('all') || allowedScopes.length === 0) return true;

  // Warn about unrecognized scope values
  for (const scope of allowedScopes) {
    if (scope !== 'all' && !CATEGORY_KEYWORDS[scope]) {
      logger.warn('[copytrade] unknown COPYTRADE_MARKET_SCOPE value — will match nothing', {
        scope,
        knownCategories: Object.keys(CATEGORY_KEYWORDS),
      });
    }
  }

  const lowerText = `${title} ${description ?? ''}`.toLowerCase();

  // Primary: keyword regex
  for (const scope of allowedScopes) {
    if (CATEGORY_REGEXES.get(scope)?.test(lowerText)) return true;
  }

  // Fallback: Gamma event tags
  if (tagSlugs && tagSlugs.length > 0) {
    for (const scope of allowedScopes) {
      const aliases = SCOPE_TAG_ALIASES[scope];
      if (aliases?.some((alias) => tagSlugs.includes(alias))) return true;
    }
  }

  return false;
}

function slippageBps(fillPrice: number, currentPrice: number): number {
  if (fillPrice <= 0) return Number.POSITIVE_INFINITY;
  return (Math.abs(currentPrice - fillPrice) / fillPrice) * 10_000;
}

function positionKey(marketId: string, direction: Position['direction']): string {
  return `${marketId}:${direction}`;
}

async function fetchWalletTrades(
  wallet: string,
  limit = DEFAULT_TRADE_LIMIT,
): Promise<ActivityTrade[]> {
  const params = new URLSearchParams({
    user: wallet,
    type: 'TRADE',
    limit: String(limit),
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });
  const url = `${DATA_API_BASE}/activity?${params.toString()}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`copytrade activity fetch failed: ${res.status.toString()} ${res.statusText}`);
  }

  const data = (await res.json()) as ActivityTrade[];
  return Array.isArray(data) ? data : [];
}

function tradeDirection(trade: ActivityTrade): Position['direction'] {
  return trade.outcomeIndex === 0 ? 'YES' : 'NO';
}

export async function runCopytrade(redis: Redis, bankrollUsd: number): Promise<CopytradeResult> {
  const cfg = loadConfig();
  if (!cfg.COPYTRADE_ENABLED) return { signals: [], exits: 0 };

  const wallets = parseWalletList(cfg.COPYTRADE_WALLETS);
  if (wallets.length === 0) {
    logger.warn('[copytrade] enabled but no wallets configured');
    return { signals: [], exits: 0 };
  }

  // Build an index of copytrade positions so we can exit when the whale sells.
  // In both 'mirror' and 'rules' mode, a whale exit is a strong signal to close.
  const positions = await getOpenPositions(redis);
  const positionIndex = new Map<string, Position[]>();
  for (const position of positions) {
    // Only mirror-close positions that were opened by copytrade.
    if (!position.sourcedFrom.startsWith('copytrade:')) continue;
    const wallet = position.sourcedFrom.replace('copytrade:', '').toLowerCase();
    const key = `${positionKey(position.marketId, position.direction)}:${wallet}`;
    const bucket = positionIndex.get(key);
    if (bucket) {
      bucket.push(position);
    } else {
      positionIndex.set(key, [position]);
    }
  }

  const signals: TradeSignal[] = [];
  let exits = 0;
  const localDedup = new Set<string>();
  const walletLatestTs = new Map<string, number>();

  // 1. Fetch activity for all wallets in parallel
  const walletResults = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const trades = await fetchWalletTrades(wallet);
        return { wallet, trades, error: null };
      } catch (err) {
        return { wallet, trades: [], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  // 2. Identify trades that haven't been processed yet
  // Recency guard: drop anything older than COPYTRADE_MAX_TRADE_AGE_MIN. Protects
  // new wallets (no last_ts cursor → 0 → 100 historical trades flood the pipe)
  // and silent wallets resuming after days (cursor stale → same flood).
  const recencyFloorSec = Math.floor(Date.now() / 1000) - cfg.COPYTRADE_MAX_TRADE_AGE_MIN * 60;
  let staleDropTotal = 0;
  const pendingTrades: { wallet: string; trade: ActivityTrade }[] = [];
  for (const { wallet, trades, error } of walletResults) {
    if (error) {
      logger.warn('[copytrade] failed to fetch wallet activity', { wallet, error });
      continue;
    }

    const lastKey = `copytrade:last_ts:${wallet}`;
    const lastRaw = await redis.get(lastKey);
    const lastTimestamp = lastRaw ? Number.parseInt(lastRaw, 10) : 0;
    let newestFetchedTs = 0;

    for (const trade of trades) {
      if (trade.timestamp > newestFetchedTs) newestFetchedTs = trade.timestamp;
      if (trade.timestamp < recencyFloorSec) {
        staleDropTotal++;
        continue;
      }
      if (trade.timestamp <= lastTimestamp) continue;
      if (!trade.transactionHash) continue;

      const dedupKey = `copytrade:tx:${trade.transactionHash}:${trade.asset}:${trade.outcomeIndex.toString()}`;
      if (localDedup.has(dedupKey)) continue;

      pendingTrades.push({ wallet, trade });
    }

    // Advance the cursor watermark even when all trades were filtered (stale
    // wallets that only return history otherwise re-emit the same drops every
    // poll). Existing `trade.timestamp <= lastTimestamp` check in the next
    // cycle will short-circuit them before the recency guard runs.
    if (newestFetchedTs > 0) {
      walletLatestTs.set(wallet, Math.max(walletLatestTs.get(wallet) ?? 0, newestFetchedTs));
    }
  }

  if (staleDropTotal > 0) {
    logger.info('[copytrade] recency guard dropped stale trades', {
      count: staleDropTotal,
      maxAgeMin: cfg.COPYTRADE_MAX_TRADE_AGE_MIN,
    });
  }

  if (pendingTrades.length === 0) {
    logger.info('[copytrade] no new trades detected');
  }

  // 3. Process pending trades across all wallets, sorted by time
  const ordered = pendingTrades.sort((a, b) => a.trade.timestamp - b.trade.timestamp);

  for (const { wallet, trade } of ordered) {
    const dedupKey = `copytrade:tx:${trade.transactionHash}:${trade.asset}:${trade.outcomeIndex.toString()}`;
    if (localDedup.has(dedupKey)) continue;

    // Persistent dedup check (Redis)
    const priorDedup = await redis.get(dedupKey);
    if (priorDedup) {
      walletLatestTs.set(wallet, Math.max(walletLatestTs.get(wallet) ?? 0, trade.timestamp));
      continue;
    }

    const markDedup = async () => {
      localDedup.add(dedupKey);
      await dedup(dedupKey, COPYTRADE_DEDUP_TTL_SECONDS);
      walletLatestTs.set(wallet, Math.max(walletLatestTs.get(wallet) ?? 0, trade.timestamp));
    };

    await recordCopytradeMetric(redis, 'candidate_seen').catch(() => {
      /* ignore telemetry errors */
    });

    try {
      // Negative-result cache: if Gamma returned null for this slug within the
      // last hour, skip the HTTP call entirely. Amortises across wallets that
      // each reference the same resolved/non-existent slug.
      const slugMissKey = `copytrade:slug-404:${trade.slug}`;
      const cachedMiss = await redis.get(slugMissKey);
      if (cachedMiss) {
        await recordCopytradeFilter(redis, 'market_lookup_failed_cached').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      const market = await getMarketBySlug(trade.slug);
      if (!market) {
        logger.warn('[copytrade] market lookup failed', { slug: trade.slug });
        await redis.set(slugMissKey, '1', 'EX', 3600);
        await recordCopytradeFilter(redis, 'market_lookup_failed').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      // Category Filter — keyword-first, Gamma-tag fallback on miss.
      // We fetch event tags up-front (24h-cached, ~free after first hit) so the
      // soccer notify-only gate below can use Gamma's own classification —
      // most reliable signal for obscure leagues (Saudi Pro, J-League, Liga MX)
      // that no practical keyword list will cover.
      const scanText = `${trade.title} ${market.question}`;
      const keywordHit = matchesCategory(scanText, market.description, cfg.COPYTRADE_MARKET_SCOPE);
      let scopePassed = keywordHit;
      let marketTagSlugs: string[] = [];

      if (cfg.COPYTRADE_SCOPE_TAG_FALLBACK) {
        const eventIds = Array.isArray(market.events)
          ? market.events.map((e) => e.id).filter(Boolean)
          : [];
        if (eventIds.length > 0) {
          const tagArrays = await Promise.all(eventIds.map((id) => getEventTagSlugs(id)));
          marketTagSlugs = [...new Set(tagArrays.flat())];
          if (
            !keywordHit &&
            matchesCategory(scanText, market.description, cfg.COPYTRADE_MARKET_SCOPE, marketTagSlugs)
          ) {
            scopePassed = true;
            logger.debug('[copytrade] scope matched via event tags', {
              marketId: market.id,
              tags: marketTagSlugs,
            });
            await recordCopytradeFilter(redis, 'scope_tag_rescue').catch(() => {
              /* ignore telemetry errors */
            });
          }
        }
      }

      if (!scopePassed) {
        logger.info('[copytrade] skipped market outside scope', {
          title: trade.title,
          question: market.question,
          scope: cfg.COPYTRADE_MARKET_SCOPE,
        });
        await recordCopytradeFilter(redis, 'scope').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      if (!market.active || market.closed) {
        logger.info('[copytrade] skipped inactive market', {
          marketId: market.id,
          slug: trade.slug,
        });
        await recordCopytradeFilter(redis, 'inactive_market').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      if (market.endDate) {
        const hoursToResolve = (new Date(market.endDate).getTime() - Date.now()) / 3_600_000;
        if (hoursToResolve < cfg.COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS) {
          logger.info('[copytrade] skipped near-resolution market', {
            marketId: market.id,
            hoursToResolve: hoursToResolve.toFixed(2),
          });
          await recordCopytradeFilter(redis, 'near_resolution').catch(() => {
            /* ignore telemetry errors */
          });
          await markDedup();
          continue;
        }
      }

      // Time-to-resolution gate. Min bound is undefined (disabled) because the
      // near-resolution check above (COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS) already
      // enforces copytrade's floor; relying on PM_MIN_HOURS_TO_RESOLUTION here
      // would block sports markets that resolve in 2–5 h.
      const ttr = checkTimeToResolution(
        market.endDate ?? undefined,
        cfg.PM_MAX_HOURS_TO_RESOLUTION_COPYTRADE,
        undefined,
      );
      if (!ttr.ok) {
        logger.info('[copytrade] skipped by time-to-resolution gate', {
          marketId: market.id,
          skipReason: ttr.skipReason,
        });
        await recordCopytradeFilter(redis, 'time_to_resolution').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      const liquidity = Number.parseFloat(market.liquidity);
      if (!Number.isFinite(liquidity) || liquidity < cfg.COPYTRADE_MIN_LIQUIDITY) {
        logger.info('[copytrade] skipped low-liquidity market', {
          marketId: market.id,
          liquidity,
        });
        await recordCopytradeFilter(redis, 'low_liquidity').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
      const prices = parseOutcomePrices(market.outcomePrices);
      const gammaYesPrice = Number.parseFloat(prices[0] ?? '0');
      if (!Number.isFinite(gammaYesPrice)) {
        logger.warn('[copytrade] invalid price from Gamma', { marketId: market.id });
        await recordCopytradeFilter(redis, 'invalid_price').catch(() => {
          /* ignore telemetry errors */
        });
        continue;
      }

      // Prefer WS feed price (real-time) over Gamma price (potentially cached).
      // WS feed is keyed by marketId — falls back to Gamma if no live price available.
      const feed = getPriceFeed(redis);
      const wsPrice = await feed.getCachedPrice(market.id).catch(() => null);
      const currentYesPrice =
        wsPrice !== null && Number.isFinite(wsPrice) ? wsPrice : gammaYesPrice;

      const direction = tradeDirection(trade);
      const currentOutcomePrice = direction === 'YES' ? currentYesPrice : 1 - currentYesPrice;
      const slippage = slippageBps(trade.price, currentOutcomePrice);

      const category = inferCategory(market.question);
      const maxSlippage =
        cfg.COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES[category] ?? cfg.COPYTRADE_MAX_SLIPPAGE_BPS;

      if (slippage > maxSlippage) {
        logger.info('[copytrade] skipped high slippage', {
          marketId: market.id,
          category,
          slippageBps: slippage.toFixed(1),
          maxSlippageBps: maxSlippage,
        });
        await recordCopytradeFilter(redis, `slippage:${category}`).catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      // Extreme-price gate (BUY entries only — exits/mirror-sells bypass).
      // Long-tail / near-certain markets have asymmetric R/R and their stop-loss %
      // is dominated by spread noise.
      if (trade.side === 'BUY') {
        if (
          currentOutcomePrice < cfg.COPYTRADE_MIN_ENTRY_PRICE ||
          currentOutcomePrice > cfg.COPYTRADE_MAX_ENTRY_PRICE
        ) {
          logger.info('[copytrade] skipped extreme price', {
            marketId: market.id,
            direction,
            currentOutcomePrice: currentOutcomePrice.toFixed(4),
            minEntry: cfg.COPYTRADE_MIN_ENTRY_PRICE,
            maxEntry: cfg.COPYTRADE_MAX_ENTRY_PRICE,
          });
          await recordCopytradeFilter(redis, 'extreme_price').catch(() => {
            /* ignore telemetry errors */
          });
          await markDedup();
          continue;
        }

        // Directional slippage gate: reject only ADVERSE drift vs whale's fill.
        // Favorable drift (better fill for us) is allowed regardless of magnitude.
        if (trade.price > 0) {
          const adverseDriftPct = (trade.price - currentOutcomePrice) / trade.price;
          if (adverseDriftPct > cfg.COPYTRADE_MAX_ADVERSE_DRIFT_PCT) {
            logger.info('[copytrade] skipped adverse drift', {
              marketId: market.id,
              direction,
              whalePrice: trade.price.toFixed(4),
              currentOutcomePrice: currentOutcomePrice.toFixed(4),
              adverseDriftPct: (adverseDriftPct * 100).toFixed(2),
              maxAdverseDriftPct: (cfg.COPYTRADE_MAX_ADVERSE_DRIFT_PCT * 100).toFixed(2),
            });
            await recordCopytradeFilter(redis, 'adverse_drift').catch(() => {
              /* ignore telemetry errors */
            });
            await markDedup();
            continue;
          }
        }

        // Payout ratio gate: skip near-certain entries where upside headroom is too small.
        // At currentOutcomePrice=0.85, payoutRatio=(1-0.85)/0.85≈0.18 < default 0.20 → skip.
        const payoutRatio = (1 - currentOutcomePrice) / currentOutcomePrice;
        if (payoutRatio < cfg.COPYTRADE_MIN_PAYOUT_RATIO) {
          logger.info('[copytrade] skipped low payout ratio', {
            marketId: market.id,
            direction,
            currentOutcomePrice: currentOutcomePrice.toFixed(4),
            payoutRatio: payoutRatio.toFixed(3),
            minPayoutRatio: cfg.COPYTRADE_MIN_PAYOUT_RATIO,
          });
          await recordCopytradeFilter(redis, 'low_payout_ratio').catch(() => {
            /* ignore telemetry errors */
          });
          await markDedup();
          continue;
        }

        // Minimum edge magnitude gate: skip if market has fully repriced from whale's fill.
        // earlyEdge = |whale_fill_price - current_price| (direction-normalised to YES side).
        const whaleYesEquiv = direction === 'YES' ? trade.price : 1 - trade.price;
        const earlyEdge = Math.abs(whaleYesEquiv - currentYesPrice);
        if (earlyEdge < cfg.COPYTRADE_MIN_EDGE_MAGNITUDE) {
          logger.info('[copytrade] skipped low edge magnitude', {
            marketId: market.id,
            direction,
            whalePrice: trade.price.toFixed(4),
            currentYesPrice: currentYesPrice.toFixed(4),
            edgeMagnitude: earlyEdge.toFixed(4),
            minEdgeMagnitude: cfg.COPYTRADE_MIN_EDGE_MAGNITUDE,
          });
          await recordCopytradeFilter(redis, 'low_edge_magnitude').catch(() => {
            /* ignore telemetry errors */
          });
          await markDedup();
          continue;
        }

      }

      if (trade.side === 'SELL') {
        const walletKey = trade.proxyWallet.toLowerCase();
        const positionsToExit =
          positionIndex.get(`${positionKey(market.id, direction)}:${walletKey}`) ?? [];
        if (positionsToExit.length === 0) {
          await recordCopytradeFilter(redis, 'mirror_no_position').catch(() => {
            /* ignore telemetry errors */
          });
          await markDedup();
          continue;
        }

        let hadError = false;
        for (const pos of positionsToExit) {
          try {
            const currentPrice = await fetchCurrentPrice(pos);
            if (!currentPrice) {
              hadError = true;
              continue;
            }

            // Near-resolution guard: at near-ceiling prices on our side, a
            // market sell captures less than redemption. Skip the mirror and
            // let resolutionRedeemer handle payout.
            const ourSidePrice =
              pos.direction === 'YES'
                ? currentPrice.currentOutcomePrice
                : 1 - currentPrice.currentOutcomePrice;
            if (ourSidePrice >= cfg.COPYTRADE_MIRROR_EXIT_MAX_PRICE) {
              logger.info('[copytrade] mirror exit skipped — near resolution', {
                marketId: pos.marketId,
                direction: pos.direction,
                ourSidePrice: ourSidePrice.toFixed(4),
                ceiling: cfg.COPYTRADE_MIRROR_EXIT_MAX_PRICE,
              });
              await recordCopytradeFilter(redis, 'mirror_near_resolution').catch(() => {
                /* ignore telemetry errors */
              });
              continue;
            }

            const returnPct =
              pos.entryPrice > 0
                ? ((currentPrice.currentOutcomePrice - pos.entryPrice) / pos.entryPrice) * 100
                : 0;

            const reason: ExitReason = 'copytrade_mirror';
            const result = await executeTakeProfit({
              position: pos,
              currentPrice: currentPrice.currentOutcomePrice,
              returnPct,
              reason,
              redis,
            });

            if (result.success) {
              exits++;
            } else {
              hadError = true;
            }
          } catch (err) {
            hadError = true;
            logger.warn('[copytrade] mirror exit failed', {
              wallet,
              txHash: trade.transactionHash,
              slug: trade.slug,
              marketId: market.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        if (!hadError) {
          await markDedup();
        }
        continue;
      }

      const scaledStake = trade.usdcSize * cfg.COPYTRADE_SIZE_SCALE;
      const maxStake = Math.min(cfg.COPYTRADE_MAX_STAKE_USD, bankrollUsd * cfg.COPYTRADE_MAX_BET_FRACTION);
      let stakeUsd = Math.max(0, Math.min(scaledStake, maxStake));

      // Apply the same stake floor bump the executor uses: stakes >= 60%
      // of MIN_BET_USD get bumped up to the floor; below that get skipped.
      // This mirrors executor.ts line 1153-1173 so copytrade signals don't
      // arrive only to be rejected there.
      const minStake = cfg.MIN_BET_USD;
      const bumpThreshold = minStake * 0.6;
      if (stakeUsd >= bumpThreshold && stakeUsd < minStake) {
        logger.info('[copytrade] bumping stake to floor', {
          marketId: market.id,
          originalStake: stakeUsd,
          minBetUsd: minStake,
        });
        stakeUsd = minStake;
      }

      if (stakeUsd < bumpThreshold) {
        logger.info('[copytrade] skipped stake below bump threshold', {
          marketId: market.id,
          scaledStake,
          bumpThreshold,
          minBetUsd: minStake,
        });
        await recordCopytradeFilter(redis, 'stake_floor').catch(() => {
          /* ignore telemetry errors */
        });
        await markDedup();
        continue;
      }

      const consensusProbability = direction === 'YES' ? trade.price : 1 - trade.price;
      const edgeMagnitude = Math.abs(consensusProbability - currentYesPrice);

      const signal: TradeSignal = {
        marketId: market.id,
        conditionId: market.conditionId,
        clobTokenIds,
        question: market.question,
        direction,
        stakeUsd,
        edgeMagnitude,
        consensusProbability,
        consensusStddev: 0,
        outcomePrice: currentOutcomePrice,
        halfKellyFraction: 0,
        priceZone: priceZoneOf(currentOutcomePrice),
        sourcedFrom: `copytrade:${wallet}`,
        reasoning: `Copytrade mirror of ${wallet} ${trade.side} @ ${trade.price.toFixed(4)} (tx ${trade.transactionHash.slice(0, 10)}...)`,
        source: 'copytrade',
      };

      // Refine the inferred category using Gamma tags before the notify-only
      // and unknown gates. inferCategory only sees the question text; tags
      // rescue obscure markets (Saudi/Asian/Latin-American soccer leagues,
      // playoff-series titles with no team-name keywords, etc.) that no
      // practical keyword list can cover.
      const rawCategory = inferCategory(signal.question);
      let signalCategory = refineCategoryFromTags(rawCategory, marketTagSlugs);
      // Keyword-fallback for soccer when the venue tag is missing — the
      // keyword regex catches "Will <X> win on YYYY-MM-DD?" and named clubs
      // even on events the venue forgot to tag.
      if (
        signalCategory !== 'sports-soccer' &&
        (signalCategory === 'sports' || signalCategory === 'unknown') &&
        isSoccerMarket(signal.question, market.description, marketTagSlugs)
      ) {
        signalCategory = 'sports-soccer';
      }

      // Strict-categorization gate: refuse to enter trades whose category is
      // unknown after both inferCategory and the Gamma-tag refinement above.
      // Previously these silently bucketed as 'geopolitical' and bypassed
      // category-aware caps (slippage, stale-exit windows, notify-only).
      if (signalCategory === 'unknown') {
        logger.info('[copytrade] skipped uncategorized market', {
          wallet,
          marketId: market.id,
          question: signal.question,
          tags: marketTagSlugs,
        });
        await recordCopytradeFilter(redis, 'category_unknown').catch(() => {});
        await markDedup();
        continue;
      }

      // Per-category notify-only gate (default: ['sports-soccer']). Replaces
      // the prior blanket COPYTRADE_SPORTS_NOTIFY_ONLY behavior so tennis/F1/
      // MMA execute normally while soccer fires Telegram alerts only.
      // Telegram dedup at (wallet, market, direction) suppresses repeat pings
      // when whales slice one intent into N rapid transactions.
      if (cfg.COPYTRADE_NOTIFY_ONLY_CATEGORIES.includes(signalCategory)) {
        logger.info('[copytrade] signal suppressed — notify-only category', {
          wallet,
          question: signal.question,
          category: signalCategory,
          tags: marketTagSlugs,
          direction,
          outcomePrice: currentOutcomePrice,
          stakeUsd,
        });

        const notifKey = `copytrade:notif:${wallet}:${market.id}:${direction}`;
        const claim = await redis
          .set(notifKey, '1', 'EX', cfg.COPYTRADE_NOTIFY_DEDUP_TTL_SEC, 'NX')
          .catch(() => null);
        if (claim === 'OK') {
          void notify(
            `⚽ <b>Copytrade ${signalCategory} signal (suppressed)</b>\n` +
              `Wallet: <code>${wallet.slice(0, 10)}…</code>\n` +
              `Market: ${signal.question}\n` +
              `Side: ${direction} @ ${currentOutcomePrice.toFixed(3)}\n` +
              `Would-be stake: $${stakeUsd.toFixed(2)}\n` +
              `<i>Remove ${signalCategory} from COPYTRADE_NOTIFY_ONLY_CATEGORIES to execute</i>`,
          ).catch(() => {});
        }
        await recordCopytradeFilter(redis, `notify_only:${signalCategory}`).catch(() => {});
        await markDedup();
        continue;
      }

      signals.push(signal);
      await recordCopytradeMetric(redis, 'signals_created').catch(() => {
        /* ignore telemetry errors */
      });
      await markDedup();
    } catch (err) {
      logger.warn('[copytrade] trade processing failed', {
        wallet,
        txHash: trade.transactionHash,
        slug: trade.slug,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  // 4. Update latest timestamps in Redis
  for (const [wallet, ts] of walletLatestTs.entries()) {
    const lastKey = `copytrade:last_ts:${wallet}`;
    await redis.set(lastKey, ts.toString());
  }

  logger.info('[copytrade] cycle complete', { signals: signals.length, exits });
  return { signals, exits };
}
