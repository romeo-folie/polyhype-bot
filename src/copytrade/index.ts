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

const WEATHER_KEYWORDS = [
  'temperature',
  'precipitation',
  'rain',
  'snow',
  'storm',
  'hurricane',
  'tornado',
  'wind',
  'heat',
  'cold',
];

export function isWeatherMarket(title: string): boolean {
  const lower = title.toLowerCase();
  return WEATHER_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function slippageBps(fillPrice: number, currentPrice: number): number {
  if (fillPrice <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(currentPrice - fillPrice) / fillPrice * 10_000;
}

function positionKey(marketId: string, direction: 'YES' | 'NO'): string {
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

function tradeDirection(trade: ActivityTrade): 'YES' | 'NO' {
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

  for (const wallet of wallets) {
    const lastKey = `copytrade:last_ts:${wallet}`;
    const lastRaw = await redis.get(lastKey);
    const lastTimestamp = lastRaw ? Number.parseInt(lastRaw, 10) : 0;

    let trades: ActivityTrade[] = [];
    try {
      trades = await fetchWalletTrades(wallet);
    } catch (err) {
      logger.warn('[copytrade] failed to fetch wallet activity', {
        wallet,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const ordered = [...trades].sort((a, b) => a.timestamp - b.timestamp);
    let latestTimestamp = lastTimestamp;

    for (const trade of ordered) {
      if (trade.timestamp < lastTimestamp) continue;
      if (!trade.transactionHash) continue;

      const dedupKey = `copytrade:tx:${trade.transactionHash}:${trade.asset}:${trade.outcomeIndex}`;
      if (localDedup.has(dedupKey)) continue;
      // If we've already persisted a dedup key from a prior run, skip immediately.
      const priorDedup = await redis.get(dedupKey);
      if (priorDedup) {
        if (trade.timestamp > latestTimestamp) {
          latestTimestamp = trade.timestamp;
        }
        continue;
      }

      const markDedup = async () => {
        if (localDedup.has(dedupKey)) return;
        localDedup.add(dedupKey);
        await dedup(dedupKey, COPYTRADE_DEDUP_TTL_SECONDS);
        if (trade.timestamp > latestTimestamp) {
          latestTimestamp = trade.timestamp;
        }
      };

      try {
        if (cfg.COPYTRADE_MARKET_SCOPE === 'weather' && !isWeatherMarket(trade.title)) {
          logger.info('[copytrade] skipped non-weather market', { title: trade.title });
          await markDedup();
          continue;
        }

        const market = await getMarketBySlug(trade.slug);
        if (!market) {
          logger.warn('[copytrade] market lookup failed', { slug: trade.slug });
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

    if (latestTimestamp > lastTimestamp) {
      await redis.set(lastKey, latestTimestamp.toString());
    }
  }

  logger.info('[copytrade] cycle complete', { signals: signals.length, exits });
  return { signals, exits };
}
