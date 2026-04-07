/**
 * Tape-based copytrade shortlist.
 *
 * Mirrors the public surface of `shortlist.ts` (`selectWallets()`,
 * `updateEnvWallets()`) but the data source is the local CLOB tape
 * (`clob:tape:*`) accumulated by `flowMonitor.ts` instead of the
 * Polymarket leaderboard REST API.
 *
 * The tape gives us a fresh, agent-local view of who is moving size on
 * watchlist markets — useful when leaderboard categories don't surface the
 * right wallets, and required for any tape-derived strategy.
 *
 * Win/loss is only computable for resolved markets, so PnL aggregation
 * here is realised PnL — open positions are notional only.
 */

import type { Redis } from 'ioredis';
import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { selectWallets, updateEnvWallets } from './shortlist.js';
import type { LeaderboardEntry } from './shortlist.js';

const TAPE_LOOKBACK_DAYS = 7;

export interface TapeAggregateRow {
  proxyWallet: string;
  notional: number;
  /** Realised PnL across resolved markets only. */
  realizedPnl: number;
  /** Number of resolved tape entries. */
  resolvedTrades: number;
}

interface TapeRecord {
  price?: number;
  size?: number;
  side?: 'BUY' | 'SELL';
  taker?: string;
  maker?: string;
  ts?: number;
}

/**
 * Walk every market tape (`clob:tape:*`) over the lookback window and
 * aggregate per-address notional + realised PnL. `resolvedMarketIds` is
 * the set of marketIds whose outcome is known — only those contribute to
 * realised PnL.
 *
 * Pure data-shape function: takes raw tape entries by market, no Redis IO.
 * The Redis-backed wrapper lives in `aggregateFromRedis()` below.
 */
export function aggregateTapeRows(
  tapeByMarket: Map<string, TapeRecord[]>,
  resolvedMarketIds: Set<string>,
  resolvedYesPriceByMarket: Map<string, number>,
): TapeAggregateRow[] {
  const byWallet = new Map<string, TapeAggregateRow>();
  const ensure = (wallet: string): TapeAggregateRow => {
    let row = byWallet.get(wallet);
    if (!row) {
      row = { proxyWallet: wallet, notional: 0, realizedPnl: 0, resolvedTrades: 0 };
      byWallet.set(wallet, row);
    }
    return row;
  };

  for (const [marketId, tape] of tapeByMarket) {
    const resolved = resolvedMarketIds.has(marketId);
    const finalYes = resolvedYesPriceByMarket.get(marketId);
    for (const t of tape) {
      const wallet = t.taker;
      if (!wallet) continue;
      const price = t.price ?? 0;
      const size = t.size ?? 0;
      const notional = price * size;
      if (!Number.isFinite(notional) || notional <= 0) continue;
      const row = ensure(wallet);
      row.notional += notional;
      if (resolved && typeof finalYes === 'number') {
        // Realised PnL on a YES-direction taker leg: paid `price`, redeems at `finalYes`.
        // Sell-side legs assume short on YES — symmetric inverse.
        const direction = t.side === 'BUY' ? 1 : t.side === 'SELL' ? -1 : 0;
        row.realizedPnl += direction * (finalYes - price) * size;
        row.resolvedTrades += 1;
      }
    }
  }

  return [...byWallet.values()];
}

/** Convert aggregate rows into the LeaderboardEntry shape selectWallets() expects. */
export function rowsToLeaderboardEntries(rows: TapeAggregateRow[]): LeaderboardEntry[] {
  return rows
    .sort((a, b) => b.realizedPnl - a.realizedPnl)
    .map((r, i) => ({
      rank: String(i + 1),
      proxyWallet: r.proxyWallet,
      userName: r.proxyWallet,
      vol: r.notional,
      pnl: r.realizedPnl,
    }));
}

async function readAllTapes(redis: Redis): Promise<Map<string, TapeRecord[]>> {
  const out = new Map<string, TapeRecord[]>();
  const pattern = 'clob:tape:*';
  const cutoff = Date.now() - TAPE_LOOKBACK_DAYS * 24 * 3600 * 1000;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    for (const key of keys) {
      const marketId = key.substring('clob:tape:'.length);
      const entries = await redis.zrangebyscore(key, cutoff, '+inf');
      const records: TapeRecord[] = [];
      for (const raw of entries) {
        try {
          records.push(JSON.parse(raw) as TapeRecord);
        } catch {
          // ignore
        }
      }
      if (records.length > 0) out.set(marketId, records);
    }
  } while (cursor !== '0');
  return out;
}

/**
 * Production entrypoint: pull tapes from Redis, aggregate, and return
 * the LeaderboardEntry shape selectWallets() consumes.
 */
export async function aggregateFromRedis(redis: Redis): Promise<LeaderboardEntry[]> {
  const tapes = await readAllTapes(redis);
  // Tape monitor doesn't yet store resolved outcomes — until that lands,
  // realised PnL is 0 and selectWallets() falls back to notional-only filters.
  const rows = aggregateTapeRows(tapes, new Set(), new Map());
  return rowsToLeaderboardEntries(rows);
}

export async function run(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.COPYTRADE_SHORTLIST_SOURCE !== 'tape') {
    logger.info('[tape-shortlist] COPYTRADE_SHORTLIST_SOURCE != tape; skipping');
    return;
  }
  const { getRedis, closeRedis } = await import('../shared/redis.js');
  const redis = getRedis();
  try {
    const entries = await aggregateFromRedis(redis);
    if (entries.length === 0) {
      logger.warn('[tape-shortlist] no tape data found');
      return;
    }
    const { selected, backfilled } = selectWallets(
      entries,
      cfg.COPYTRADE_SHORTLIST_MIN_PNL_USD,
      cfg.COPYTRADE_SHORTLIST_MIN_VOL_USD,
      cfg.COPYTRADE_SHORTLIST_TOP_N,
      cfg.COPYTRADE_SHORTLIST_MIN_VOL_PNL_RATIO,
    );
    const wallets = [...selected, ...backfilled].map((e) => e.proxyWallet);
    logger.info('[tape-shortlist] computed', { count: wallets.length });
    if (cfg.COPYTRADE_SHORTLIST_AUTO_APPLY) {
      await updateEnvWallets(wallets);
      logger.info('[tape-shortlist] COPYTRADE_WALLETS updated', { count: wallets.length });
    }
  } finally {
    await closeRedis();
  }
}
