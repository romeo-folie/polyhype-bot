import process from 'node:process';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { dedup } from '../shared/redis.js';
import { fetchWithTimeout, getMarketBySlug, parseClobTokenIds, parseOutcomePrices } from '../mapping/gamma.js';
import { getOpenPositions } from '../execution/positionLedger.js';
import { fetchCurrentPrice } from '../monitor/priceFetcher.js';
import { executeTakeProfit } from '../monitor/takeProfitExecutor.js';
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
  weather: ['rain', 'snow', 'storm', 'hurricane', 'temperature', 'precipitation', 'tornado', 'wind', 'heat wave', 'cold snap', 'blizzard', 'drought'],
  geopolitics: ['war', 'conflict', 'united nations', 'sanctions', 'treaty', 'military', 'invasion', 'ceasefire', 'nuclear'],
  sports: ['olympics', 'nfl', 'nba', 'soccer', 'fifa', 'super bowl', 'championship', 'world cup'],
  crypto: ['bitcoin', 'ethereum', 'doge', 'dogecoin', 'sec', 'etf', 'bnb', 'tao', 'regulation', 'coinbase', 'binance', 'halving', 'solana', 'xrp', 'ripple', 'shiba', 'shib', 'pepe', 'crypto', 'cryptocurrency', 'blockchain'],
  macro: ['fed', 'inflation', 'cpi', 'gdp', 'recession', 'interest rate', 'rate cut', 'rate hike', 'central bank'],
  'ai-tech': ['openai', 'nvidia', 'gemini', 'anthropic', 'gpu', 'llm', 'silicon'],
  'us-politics': ['election', 'biden', 'trump', 'senate', 'congress', 'white house', 'democrat', 'republican'],
};

/**
 * Check if a market title or description matches any keyword from the allowed categories.
 * Keywords are matched as whole words to avoid false positives from short tokens.
 */
export function matchesCategory(title: string, description: string | null, allowedScopes: string[]): boolean {
  if (allowedScopes.includes('all') || allowedScopes.length === 0) return true;
  const scopes = allowedScopes;

  const lowerText = `${title} ${description ?? ''}`.toLowerCase();
  for (const scope of scopes) {
    const keywords = CATEGORY_KEYWORDS[scope];
    if (keywords?.some((kw) => {
      // Multi-word phrases: use substring match (the phrase already acts as its own boundary).
      // Single words: anchor with \b to prevent 'un' matching 'until', 'cold' matching 'colder'.
      if (kw.includes(' ')) return lowerText.includes(kw);
      return new RegExp(`\\b${kw}\\b`).test(lowerText);
    })) {
      return true;
    }
  }
  return false;
}

function slippageBps(fillPrice: number, currentPrice: number): number {
  if (fillPrice <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(currentPrice - fillPrice) / fillPrice * 10_000;
}

function positionKey(marketId: string, direction: Position['direction']): string {
  return `${marketId}:${direction}`;
}

async function fetchWalletTrades(wallet: string, limit = DEFAULT_TRADE_LIMIT): Promise<ActivityTrade[]> {
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
    throw new Error(`copytrade activity fetch failed: ${res.status} ${res.statusText}`);
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

  const positions = cfg.COPYTRADE_EXIT_MODE === 'mirror'
    ? await getOpenPositions(redis)
    : [];
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
  const pendingTrades: { wallet: string; trade: ActivityTrade }[] = [];
  for (const { wallet, trades, error } of walletResults) {
    if (error) {
      logger.warn('[copytrade] failed to fetch wallet activity', { wallet, error });
      continue;
    }

    const lastKey = `copytrade:last_ts:${wallet}`;
    const lastRaw = await redis.get(lastKey);
    const lastTimestamp = lastRaw ? Number.parseInt(lastRaw, 10) : 0;

    for (const trade of trades) {
      if (trade.timestamp <= lastTimestamp) continue;
      if (!trade.transactionHash) continue;

      const dedupKey = `copytrade:tx:${trade.transactionHash}:${trade.asset}:${trade.outcomeIndex}`;
      if (localDedup.has(dedupKey)) continue;

      pendingTrades.push({ wallet, trade });
    }
  }

  if (pendingTrades.length === 0) {
    logger.info('[copytrade] no new trades detected');
    return { signals: [], exits: 0 };
  }

  // 3. Process pending trades across all wallets, sorted by time
  const ordered = pendingTrades.sort((a, b) => a.trade.timestamp - b.trade.timestamp);
  const walletLatestTs = new Map<string, number>();

  for (const { wallet, trade } of ordered) {
    const dedupKey = `copytrade:tx:${trade.transactionHash}:${trade.asset}:${trade.outcomeIndex}`;
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

    try {
      const market = await getMarketBySlug(trade.slug);
      if (!market) {
        logger.warn('[copytrade] market lookup failed', { slug: trade.slug });
        continue;
      }

      // Category Filter (check both the activity Title and the official Market Question)
      const scanText = `${trade.title} ${market.question}`;
      if (!matchesCategory(scanText, market.description, cfg.COPYTRADE_MARKET_SCOPE)) {
        logger.info('[copytrade] skipped market outside scope', {
          title: trade.title,
          question: market.question,
          scope: cfg.COPYTRADE_MARKET_SCOPE,
        });
        await markDedup();
        continue;
      }

      if (!market.active || market.closed) {
        logger.info('[copytrade] skipped inactive market', { marketId: market.id, slug: trade.slug });
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
          await markDedup();
          continue;
        }
      }

      const liquidity = Number.parseFloat(market.liquidity ?? '0');
      if (!Number.isFinite(liquidity) || liquidity < cfg.COPYTRADE_MIN_LIQUIDITY) {
        logger.info('[copytrade] skipped low-liquidity market', {
          marketId: market.id,
          liquidity,
        });
        await markDedup();
        continue;
      }

      const clobTokenIds = parseClobTokenIds(market.clobTokenIds);
      const prices = parseOutcomePrices(market.outcomePrices);
      const currentYesPrice = Number.parseFloat(prices[0] ?? '0');
      if (!Number.isFinite(currentYesPrice)) {
        logger.warn('[copytrade] invalid price from Gamma', { marketId: market.id });
        continue;
      }

      const direction = tradeDirection(trade);
      const currentOutcomePrice = direction === 'YES' ? currentYesPrice : 1 - currentYesPrice;
      const slippage = slippageBps(trade.price, currentOutcomePrice);
      if (slippage > cfg.COPYTRADE_MAX_SLIPPAGE_BPS) {
        logger.info('[copytrade] skipped high slippage', {
          marketId: market.id,
          slippageBps: slippage.toFixed(1),
        });
        await markDedup();
        continue;
      }

      if (trade.side === 'SELL') {
        if (cfg.COPYTRADE_EXIT_MODE !== 'mirror') {
          await markDedup();
          continue;
        }
        const walletKey = trade.proxyWallet.toLowerCase();
        const positionsToExit = positionIndex.get(`${positionKey(market.id, direction)}:${walletKey}`) ?? [];
        if (positionsToExit.length === 0) {
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
      const maxStake = Math.min(cfg.COPYTRADE_MAX_STAKE_USD, bankrollUsd * cfg.MAX_BET_FRACTION);
      const stakeUsd = Math.max(0, Math.min(scaledStake, maxStake));
      if (stakeUsd <= 0) {
        logger.info('[copytrade] skipped zero stake after scaling', {
          marketId: market.id,
          scaledStake,
          maxStake,
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
        sourcedFrom: `copytrade:${wallet}`,
        reasoning: `Copytrade mirror of ${wallet} ${trade.side} @ ${trade.price.toFixed(4)} (tx ${trade.transactionHash.slice(0, 10)}...)`,
      };

      signals.push(signal);
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
