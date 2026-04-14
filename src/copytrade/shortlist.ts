import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { fetchWithTimeout } from '../mapping/gamma.js';
import { enqueueWrite } from '../db/writeQueue.js';
import { getRedis, closeRedis } from '../shared/redis.js';
import {
  fetchAndScoreWallet,
  type QualityConfig,
  type QualityScoreResult,
  type WalletStats,
} from './walletQuality.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CANDIDATES = 50;

export interface LeaderboardEntry {
  rank: string;
  proxyWallet: string;
  userName: string;
  vol: number;
  pnl: number;
}

export interface ScoredEntry {
  entry: LeaderboardEntry;
  category: string;
  stats: WalletStats;
  score: QualityScoreResult;
}

const CATEGORY_MAP: Record<string, string> = {
  geopolitical: 'POLITICS',
  'us-politics': 'POLITICS',
  weather: 'WEATHER',
  'sports-nba': 'SPORTS',
  'sports-nfl': 'SPORTS',
  'sports-soccer': 'SPORTS',
  'sports-mlb': 'SPORTS',
  'sports-tennis': 'SPORTS',
  sports: 'SPORTS',
  macro: 'ECONOMICS',
  'crypto-regulatory': 'CRYPTO',
  'ai-tech': 'TECH',
  mentions: 'CULTURE',
};

export function resolveCategories(scope: string[]): string[] {
  if (scope.includes('all') || scope.length === 0) return ['OVERALL'];
  const scopes = scope;
  const cats = new Set<string>();
  for (const s of scopes) {
    const mapped = CATEGORY_MAP[s];
    if (mapped) {
      cats.add(mapped);
    } else {
      cats.add('OVERALL');
    }
  }
  return cats.size === 0 ? ['OVERALL'] : Array.from(cats);
}

export async function fetchLeaderboard(
  category: string,
  timePeriod: string,
  limit: number,
): Promise<LeaderboardEntry[]> {
  const params = new URLSearchParams({
    category,
    timePeriod,
    orderBy: 'PNL',
    limit: String(limit),
    offset: '0',
  });
  const url = `${DATA_API_BASE}/v1/leaderboard?${params.toString()}`;
  const res = await fetchWithTimeout(url, REQUEST_TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`Leaderboard fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as LeaderboardEntry[];
  return Array.isArray(data) ? data : [];
}

function normaliseWallet(raw: string): string | null {
  const w = raw.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(w) ? w : null;
}

export function formatWallets(wallets: string[]): string {
  return wallets
    .map((w) => normaliseWallet(w))
    .filter((w): w is string => Boolean(w))
    .join(',');
}

export async function updateEnvWallets(wallets: string[]): Promise<void> {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(__dirname, '../../.env');
  const envDir = path.dirname(envPath);
  const tempPath = path.join(envDir, '.env.tmp');
  const content = await fs.readFile(envPath, 'utf8');
  const walletsValue = formatWallets(wallets);

  const lineRegex = /^COPYTRADE_WALLETS=.*$/m;
  const next = lineRegex.test(content)
    ? content.replace(lineRegex, `COPYTRADE_WALLETS=${walletsValue}`)
    : `${content.trimEnd()}\nCOPYTRADE_WALLETS=${walletsValue}\n`;

  await fs.writeFile(tempPath, next, 'utf8');
  await fs.rename(tempPath, envPath);
}

export function selectWallets(
  entries: LeaderboardEntry[],
  minPnl: number,
  minVol: number,
  topN: number,
  minVolPnlRatio = 0, // vol/pnl >= this — filters lucky one-hit wallets vs systematic traders
) {
  const filtered = entries.filter((entry) => {
    if (entry.pnl < minPnl) return false;
    if (entry.vol < minVol) return false;
    // Vol/PnL ratio: systematic traders have high volume relative to PnL
    // A lucky one-off trader has low vol (few trades) but high PnL — we want to avoid those
    if (minVolPnlRatio > 0 && entry.pnl > 0 && entry.vol / entry.pnl < minVolPnlRatio) return false;
    return true;
  });
  const selected: LeaderboardEntry[] = [];
  const seen = new Set<string>();

  for (const entry of filtered) {
    if (selected.length >= topN) break;
    if (seen.has(entry.proxyWallet)) continue;
    selected.push(entry);
    seen.add(entry.proxyWallet);
  }

  const backfilled: LeaderboardEntry[] = [];
  if (selected.length < topN) {
    for (const entry of entries) {
      if (selected.length + backfilled.length >= topN) break;
      if (seen.has(entry.proxyWallet)) continue;
      backfilled.push(entry);
      seen.add(entry.proxyWallet);
    }
  }

  return { selected, backfilled };
}

function buildQualityConfig(cfg: ReturnType<typeof loadConfig>): QualityConfig {
  return {
    maxTrades: cfg.COPYTRADE_WALLET_MAX_TRADES,
    minAvgSizeUsd: cfg.COPYTRADE_WALLET_MIN_AVG_SIZE_USD,
    maxAvgSizeUsd: cfg.COPYTRADE_WALLET_MAX_AVG_SIZE_USD,
    minCategoryHhi: cfg.COPYTRADE_WALLET_MIN_CATEGORY_CONCENTRATION,
    winRateMinResolved: cfg.COPYTRADE_WIN_RATE_MIN_RESOLVED,
    winRateBonusMult: cfg.COPYTRADE_WIN_RATE_BONUS_MULT,
    winRatePenaltyMult: cfg.COPYTRADE_WIN_RATE_PENALTY_MULT,
    weights: {
      tradeCount: cfg.COPYTRADE_QUALITY_WEIGHT_TRADE_COUNT,
      avgSize: cfg.COPYTRADE_QUALITY_WEIGHT_AVG_SIZE,
      categoryFocus: cfg.COPYTRADE_QUALITY_WEIGHT_CATEGORY_FOCUS,
      sharpe: cfg.COPYTRADE_QUALITY_WEIGHT_SHARPE,
    },
  };
}

async function persistScore(
  wallet: string,
  category: string,
  stats: WalletStats,
  score: QualityScoreResult,
  minScore: number,
  enabled: boolean,
): Promise<void> {
  try {
    const redis = getRedis();
    const key = `copytrade:wallet_quality:${wallet}`;
    const payload: Record<string, string> = {
      wallet,
      category,
      score: score.score.toFixed(4),
      tradeCount: String(stats.tradeCount),
      avgTradeSizeUsd: stats.avgTradeSizeUsd.toFixed(2),
      totalVolumeUsd: stats.totalVolumeUsd.toFixed(2),
      categoryHhi: stats.categoryHhi.toFixed(4),
      overallResolvedTrades: String(stats.overallResolvedTrades),
      overallWinRate: stats.overallWinRate === null ? '' : stats.overallWinRate.toFixed(4),
      sharpe: stats.sharpe === null ? '' : stats.sharpe.toFixed(4),
      factorTradeCount: score.factors.tradeCount.toFixed(4),
      factorAvgSize: score.factors.avgSize.toFixed(4),
      factorCategoryFocus: score.factors.categoryFocus.toFixed(4),
      factorSharpe: score.factors.sharpe.toFixed(4),
      winRateMultiplier: score.factors.winRateMultiplier.toFixed(4),
      updatedAt: new Date().toISOString(),
    };
    await redis.hset(key, payload);
    await redis.expire(key, 14 * 86400);
  } catch (err) {
    logger.warn('[copytrade-shortlist] redis persist failed', {
      wallet,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  void enqueueWrite('shadow_observations', {
    kind: 'copytrade_wallet_quality',
    source: 'copytrade',
    wouldBlock: score.score < minScore,
    metricValue: score.score,
    threshold: minScore,
    payload: {
      wallet,
      category,
      enabled,
      tradeCount: stats.tradeCount,
      avgTradeSizeUsd: stats.avgTradeSizeUsd,
      categoryHhi: stats.categoryHhi,
      overallResolvedTrades: stats.overallResolvedTrades,
      overallWinRate: stats.overallWinRate,
      sharpe: stats.sharpe,
      factors: score.factors,
    },
  });
}

export async function run(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.COPYTRADE_ENABLED) {
    logger.info('[copytrade-shortlist] COPYTRADE_ENABLED=false; skipping shortlist update');
    return;
  }

  const apiCategories = resolveCategories(cfg.COPYTRADE_MARKET_SCOPE);
  const timeWindow = cfg.COPYTRADE_SHORTLIST_TIME_WINDOW;
  const topN = cfg.COPYTRADE_SHORTLIST_TOP_N;
  const minPnl = cfg.COPYTRADE_SHORTLIST_MIN_PNL_USD;
  const minVol = cfg.COPYTRADE_SHORTLIST_MIN_VOL_USD;
  const minVolPnlRatio = cfg.COPYTRADE_SHORTLIST_MIN_VOL_PNL_RATIO;
  const qualityEnabled = cfg.COPYTRADE_QUALITY_SHORTLIST_ENABLED;
  const qualityCfg = buildQualityConfig(cfg);
  const minScore = cfg.COPYTRADE_WALLET_MIN_SCORE;

  const combinedWallets = new Set<string>();
  const stats: Record<string, number> = {};
  const qualityStats: Record<
    string,
    { kept: number; filtered: number; scored: number }
  > = {};
  const scoredCache = new Map<string, { stats: WalletStats; result: QualityScoreResult }>();

  for (const category of apiCategories) {
    try {
      const leaderboard = await fetchLeaderboard(
        category,
        timeWindow,
        Math.max(DEFAULT_MAX_CANDIDATES, topN * 2),
      );
      if (leaderboard.length === 0) {
        logger.warn('[copytrade-shortlist] empty leaderboard response', { category, timeWindow });
        continue;
      }

      const { selected, backfilled } = selectWallets(
        leaderboard,
        minPnl,
        minVol,
        topN,
        minVolPnlRatio,
      );
      const baseResults = [...selected, ...backfilled];

      // Score every leaderboard candidate (not just base results) so shadow-log
      // coverage reflects the whole pool we'd consider under the new heuristic.
      // Skip duplicates across categories via `scoredCache`.
      const toScore = leaderboard.filter((e) => {
        const w = normaliseWallet(e.proxyWallet);
        return w !== null && !scoredCache.has(w);
      });
      const scoredThisCategory = await Promise.all(
        toScore.map(async (entry) => {
          const w = normaliseWallet(entry.proxyWallet);
          if (w === null) return null;
          const result = await fetchAndScoreWallet(w, qualityCfg);
          if (!result) return null;
          scoredCache.set(w, result);
          return { wallet: w, entry, ...result };
        }),
      );

      let kept = 0;
      let filtered = 0;
      for (const scored of scoredThisCategory) {
        if (!scored) continue;
        await persistScore(
          scored.wallet,
          category,
          scored.stats,
          scored.result,
          minScore,
          qualityEnabled,
        );
        if (scored.result.score < minScore) filtered++;
        else kept++;
      }

      let results: LeaderboardEntry[];
      let unscoredIncluded = 0;
      if (qualityEnabled) {
        // Rank strategy:
        //  - scored wallets: rank by `score` desc (highest quality first)
        //  - unscored wallets (transient API failure): treat as neutral and
        //    retain at their original leaderboard order behind the scored set.
        //    Dropping them would make the shortlist brittle to Data API
        //    outages and could leave categories empty.
        //  - explicitly filtered wallets (score < minScore): dropped.
        const ranked: { entry: LeaderboardEntry; score: number; rank: number }[] = [];
        for (const [rank, entry] of baseResults.entries()) {
          const w = normaliseWallet(entry.proxyWallet);
          if (w === null) continue;
          const cached = scoredCache.get(w);
          if (!cached) {
            ranked.push({ entry, score: Number.NaN, rank });
            unscoredIncluded++;
            continue;
          }
          if (cached.result.score < minScore) continue;
          ranked.push({ entry, score: cached.result.score, rank });
        }
        // Scored first (desc by score), then unscored in original leaderboard order.
        ranked.sort((a, b) => {
          const aScored = Number.isFinite(a.score);
          const bScored = Number.isFinite(b.score);
          if (aScored && bScored) return b.score - a.score;
          if (aScored) return -1;
          if (bScored) return 1;
          return a.rank - b.rank;
        });
        results = ranked.map((r) => r.entry);

        // If we dropped below topN, backfill from lower-ranked-but-qualifying
        // leaderboard candidates (also accepting unscored wallets as a last
        // resort, so a total API outage doesn't zero out the shortlist).
        if (results.length < topN) {
          const already = new Set(results.map((r) => r.proxyWallet));
          for (const entry of leaderboard) {
            if (results.length >= topN) break;
            if (already.has(entry.proxyWallet)) continue;
            const w = normaliseWallet(entry.proxyWallet);
            if (w === null) continue;
            const cached = scoredCache.get(w);
            if (cached && cached.result.score < minScore) continue;
            if (!cached) unscoredIncluded++;
            results.push(entry);
            already.add(entry.proxyWallet);
          }
        }
      } else {
        results = baseResults;
      }

      results.forEach((entry) => combinedWallets.add(entry.proxyWallet));
      stats[category] = results.length;
      qualityStats[category] = {
        kept,
        filtered,
        scored: scoredThisCategory.filter((s) => s !== null).length,
      };

      logger.info('[copytrade-shortlist] category processed', {
        category,
        selectedCount: selected.length,
        backfillCount: backfilled.length,
        qualityEnabled,
        scored: qualityStats[category].scored,
        kept,
        filtered,
        unscoredIncluded,
        finalCount: results.length,
      });
    } catch (err) {
      logger.error('[copytrade-shortlist] category fetch failed', {
        category,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const wallets = Array.from(combinedWallets);
  if (wallets.length === 0) {
    logger.warn('[copytrade-shortlist] no wallets found across all categories');
    return;
  }

  logger.info('[copytrade-shortlist] final shortlist computed', {
    apiCategories,
    stats,
    qualityEnabled,
    qualityStats,
    totalUniqueWallets: wallets.length,
  });

  if (!cfg.COPYTRADE_SHORTLIST_AUTO_APPLY) {
    logger.info('[copytrade-shortlist] auto-apply disabled; not updating COPYTRADE_WALLETS');
    return;
  }

  await updateEnvWallets(wallets);
  logger.info('[copytrade-shortlist] COPYTRADE_WALLETS updated', { count: wallets.length });
}

if (process.env.NODE_ENV !== 'test') {
  run()
    .catch((err: unknown) => {
      logger.error('[copytrade-shortlist] failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exitCode = 1;
    })
    .finally(() => {
      void closeRedis();
    });
}
