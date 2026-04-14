/**
 * Copytrade wallet-quality scoring — Phase 8 Step 1.
 *
 * Fetches per-wallet trade history from the Polymarket Data API and computes
 * a [0..1] quality score that biases shortlist selection away from bots, big
 * market-makers, and lucky one-off PnL toward single-category specialists
 * with <100 trades and $10–50K avg size — the cohort the research doc flags
 * as most copyable.
 *
 * See `docs/research-polymarket-bot-strategies-2026-04-13.md` and the plan at
 * `~/.claude/plans/phase-8-copytrade-hardening.md` §Step 1.
 */

import { fetchWithTimeout } from '../mapping/gamma.js';
import { inferCategory } from '../shared/outcomeRecorder.js';
import { logger } from '../shared/logger.js';

const DATA_API_BASE = 'https://data-api.polymarket.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_ACTIVITY_LIMIT = 500;

export interface ActivityTrade {
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

export interface CategoryBucket {
  trades: number;
  volumeUsd: number;
  /** Round-trip wins inferred from BUY+SELL cost basis in this category. */
  wins: number;
  losses: number;
}

export interface WalletStats {
  wallet: string;
  tradeCount: number;
  avgTradeSizeUsd: number;
  totalVolumeUsd: number;
  categoryDistribution: Record<string, CategoryBucket>;
  /** Herfindahl-Hirschman index on trade-count share across categories (1 = single category, →0 generalist). */
  categoryHhi: number;
  /** Overall win rate from resolved round-trips (0..1). `null` if too few round-trips. */
  overallWinRate: number | null;
  overallResolvedTrades: number;
  /** Simple Sharpe proxy on per-trip PnL (mean / stddev); `null` if too few round-trips. */
  sharpe: number | null;
}

export interface QualityWeights {
  tradeCount: number;
  avgSize: number;
  categoryFocus: number;
  sharpe: number;
}

export interface QualityScoreResult {
  score: number;
  factors: {
    tradeCount: number;
    avgSize: number;
    categoryFocus: number;
    sharpe: number;
    winRateMultiplier: number;
  };
}

export interface QualityConfig {
  maxTrades: number;
  minAvgSizeUsd: number;
  maxAvgSizeUsd: number;
  minCategoryHhi: number;
  winRateMinResolved: number;
  winRateBonusMult: number;
  winRatePenaltyMult: number;
  weights: QualityWeights;
}

export async function fetchWalletActivity(
  wallet: string,
  limit = DEFAULT_ACTIVITY_LIMIT,
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
    throw new Error(`wallet activity fetch failed: ${res.status.toString()} ${res.statusText}`);
  }
  const data = (await res.json()) as ActivityTrade[];
  return Array.isArray(data) ? data : [];
}

/**
 * Reconstruct round-trip PnL from activity by walking trades chronologically
 * and matching SELLs against the average-cost inventory per asset.
 *
 * Only fully-closed round-trips (SELL size ≤ BUY inventory) count. Positions
 * still open at the end of the window don't contribute wins/losses — we can't
 * tell from activity alone whether the whale is holding to redemption or will
 * dump at a loss.
 */
function matchRoundTrips(trades: ActivityTrade[]): {
  asset: string;
  category: string;
  title: string;
  pnlUsd: number;
  closedAt: number;
}[] {
  const inventory = new Map<string, { size: number; costUsd: number }>();
  const roundTrips: {
    asset: string;
    category: string;
    title: string;
    pnlUsd: number;
    closedAt: number;
  }[] = [];

  const chrono = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  for (const t of chrono) {
    if (!Number.isFinite(t.size) || t.size <= 0) continue;
    if (!Number.isFinite(t.usdcSize) || t.usdcSize < 0) continue;

    const key = t.asset;
    const slot = inventory.get(key) ?? { size: 0, costUsd: 0 };
    if (t.side === 'BUY') {
      slot.size += t.size;
      slot.costUsd += t.usdcSize;
      inventory.set(key, slot);
      continue;
    }

    if (t.side !== 'SELL') continue;
    if (slot.size <= 0) continue; // short / unattributed SELL — skip

    const fillSize = Math.min(t.size, slot.size);
    const avgCost = slot.size > 0 ? slot.costUsd / slot.size : 0;
    const proceedsUsd = fillSize * (t.usdcSize / t.size);
    const costBasis = fillSize * avgCost;
    const pnlUsd = proceedsUsd - costBasis;
    roundTrips.push({
      asset: key,
      category: inferCategory(t.title),
      title: t.title,
      pnlUsd,
      closedAt: t.timestamp,
    });
    slot.size -= fillSize;
    slot.costUsd -= costBasis;
    if (slot.size <= 1e-9) {
      inventory.delete(key);
    } else {
      inventory.set(key, slot);
    }
  }
  return roundTrips;
}

function computeHhi(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let hhi = 0;
  for (const c of counts) {
    const share = c / total;
    hhi += share * share;
  }
  return hhi;
}

export function computeWalletStats(wallet: string, trades: ActivityTrade[]): WalletStats {
  const tradeCount = trades.length;
  const totalVolumeUsd = trades.reduce((sum, t) => sum + (Number.isFinite(t.usdcSize) ? t.usdcSize : 0), 0);
  const avgTradeSizeUsd = tradeCount > 0 ? totalVolumeUsd / tradeCount : 0;

  const byCategory = new Map<string, CategoryBucket>();
  for (const t of trades) {
    const cat = inferCategory(t.title);
    const bucket = byCategory.get(cat) ?? { trades: 0, volumeUsd: 0, wins: 0, losses: 0 };
    bucket.trades += 1;
    bucket.volumeUsd += Number.isFinite(t.usdcSize) ? t.usdcSize : 0;
    byCategory.set(cat, bucket);
  }

  const roundTrips = matchRoundTrips(trades);
  let wins = 0;
  let losses = 0;
  const pnls: number[] = [];
  for (const rt of roundTrips) {
    const bucket = byCategory.get(rt.category);
    if (rt.pnlUsd > 0) {
      wins++;
      if (bucket) bucket.wins++;
    } else if (rt.pnlUsd < 0) {
      losses++;
      if (bucket) bucket.losses++;
    }
    pnls.push(rt.pnlUsd);
  }

  const overallResolvedTrades = wins + losses;
  const overallWinRate = overallResolvedTrades > 0 ? wins / overallResolvedTrades : null;

  let sharpe: number | null = null;
  if (pnls.length >= 5) {
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / pnls.length;
    const stddev = Math.sqrt(variance);
    sharpe = stddev > 1e-6 ? mean / stddev : null;
  }

  const categoryDistribution: Record<string, CategoryBucket> = {};
  for (const [cat, bucket] of byCategory.entries()) categoryDistribution[cat] = bucket;

  const counts = Array.from(byCategory.values()).map((b) => b.trades);
  const categoryHhi = computeHhi(counts);

  return {
    wallet,
    tradeCount,
    avgTradeSizeUsd,
    totalVolumeUsd,
    categoryDistribution,
    categoryHhi,
    overallWinRate,
    overallResolvedTrades,
    sharpe,
  };
}

function tradeCountFactor(tradeCount: number, maxTrades: number): number {
  if (tradeCount <= 0) return 0;
  if (tradeCount <= maxTrades) return 1;
  // Linear decay from 1.0 at `maxTrades` to 0.0 at 5× `maxTrades`.
  const slope = 4 * maxTrades;
  const decayed = 1 - (tradeCount - maxTrades) / slope;
  return Math.max(0, decayed);
}

function avgSizeFactor(avgUsd: number, minUsd: number, maxUsd: number): number {
  if (avgUsd <= 0) return 0;
  if (avgUsd >= minUsd && avgUsd <= maxUsd) return 1;
  // Exponential falloff outside the sweet-spot band. A whale 2× the high
  // bound or 1/2 the low bound should lose roughly half a point.
  if (avgUsd < minUsd) {
    const ratio = avgUsd / minUsd; // 0..1
    return Math.max(0, Math.pow(ratio, 0.5));
  }
  const ratio = maxUsd / avgUsd; // 0..1
  return Math.max(0, Math.pow(ratio, 0.5));
}

function categoryFocusFactor(hhi: number, minHhi: number): number {
  if (hhi >= minHhi) return 1;
  if (minHhi <= 0) return 1;
  return Math.max(0, hhi / minHhi);
}

function sharpeFactor(sharpe: number | null): number {
  if (sharpe === null) return 0.5; // unknown → neutral
  // Logistic centered at 1.0 — classic finance-textbook Sharpe target.
  const k = 2; // slope
  return 1 / (1 + Math.exp(-k * (sharpe - 1)));
}

function winRateMultiplier(
  wr: number | null,
  resolved: number,
  cfg: QualityConfig,
): number {
  if (wr === null || resolved < cfg.winRateMinResolved) return 1;
  if (wr >= 0.6) return cfg.winRateBonusMult;
  if (wr <= 0.4) return cfg.winRatePenaltyMult;
  return 1;
}

/**
 * Normalise weight vector so the base components sum to 1.0, then combine
 * multiplicatively with the win-rate tiebreaker.
 *
 * Returned score is clamped to [0, 1] (tight floor — WR multiplier ≥ 1.2 can
 * theoretically push a perfect base score past 1, so we clamp).
 */
export function scoreWallet(stats: WalletStats, cfg: QualityConfig): QualityScoreResult {
  const weightSum =
    cfg.weights.tradeCount + cfg.weights.avgSize + cfg.weights.categoryFocus + cfg.weights.sharpe;
  const w = weightSum > 0
    ? {
        tradeCount: cfg.weights.tradeCount / weightSum,
        avgSize: cfg.weights.avgSize / weightSum,
        categoryFocus: cfg.weights.categoryFocus / weightSum,
        sharpe: cfg.weights.sharpe / weightSum,
      }
    : { tradeCount: 0.25, avgSize: 0.25, categoryFocus: 0.25, sharpe: 0.25 };

  const f = {
    tradeCount: tradeCountFactor(stats.tradeCount, cfg.maxTrades),
    avgSize: avgSizeFactor(stats.avgTradeSizeUsd, cfg.minAvgSizeUsd, cfg.maxAvgSizeUsd),
    categoryFocus: categoryFocusFactor(stats.categoryHhi, cfg.minCategoryHhi),
    sharpe: sharpeFactor(stats.sharpe),
  };
  const wrMult = winRateMultiplier(stats.overallWinRate, stats.overallResolvedTrades, cfg);

  const base =
    f.tradeCount * w.tradeCount +
    f.avgSize * w.avgSize +
    f.categoryFocus * w.categoryFocus +
    f.sharpe * w.sharpe;
  const score = Math.max(0, Math.min(1, base * wrMult));

  return {
    score,
    factors: { ...f, winRateMultiplier: wrMult },
  };
}

/**
 * One-shot helper used by the shortlist worker: fetch + score a single wallet,
 * returning `null` on network / API failure so callers can fall through to the
 * leaderboard-only selection path.
 */
export async function fetchAndScoreWallet(
  wallet: string,
  cfg: QualityConfig,
): Promise<{ stats: WalletStats; result: QualityScoreResult } | null> {
  try {
    const trades = await fetchWalletActivity(wallet);
    const stats = computeWalletStats(wallet, trades);
    const result = scoreWallet(stats, cfg);
    return { stats, result };
  } catch (err) {
    logger.warn('[wallet-quality] fetch/score failed', {
      wallet,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
