import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { fetchWithTimeout } from '../mapping/gamma.js';

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

export function resolveCategory(scope: string[]): string {
  if (scope.includes('weather') && scope.length === 1) {
    return 'WEATHER';
  }
  return 'OVERALL';
}

export async function fetchLeaderboard(category: string, timePeriod: string, limit: number): Promise<LeaderboardEntry[]> {
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
  const envPath = path.resolve(process.cwd(), '.env');
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

export function selectWallets(entries: LeaderboardEntry[], minPnl: number, minVol: number, topN: number) {
  const filtered = entries.filter((entry) => entry.pnl >= minPnl && entry.vol >= minVol);
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

export async function run(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.COPYTRADE_ENABLED) {
    logger.info('[copytrade-shortlist] COPYTRADE_ENABLED=false; skipping shortlist update');
    return;
  }

  const category = resolveCategory(cfg.COPYTRADE_MARKET_SCOPE);
  const timeWindow = cfg.COPYTRADE_SHORTLIST_TIME_WINDOW;
  const topN = cfg.COPYTRADE_SHORTLIST_TOP_N;
  const minPnl = cfg.COPYTRADE_SHORTLIST_MIN_PNL_USD;
  const minVol = cfg.COPYTRADE_SHORTLIST_MIN_VOL_USD;

  const leaderboard = await fetchLeaderboard(category, timeWindow, DEFAULT_MAX_CANDIDATES);
  if (leaderboard.length === 0) {
    logger.warn('[copytrade-shortlist] empty leaderboard response', { category, timeWindow });
    return;
  }

  const { selected, backfilled } = selectWallets(leaderboard, minPnl, minVol, topN);
  const wallets = [...selected, ...backfilled].map((entry) => entry.proxyWallet);

  logger.info('[copytrade-shortlist] shortlist computed', {
    category,
    timeWindow,
    minPnl,
    minVol,
    topN,
    selected: selected.map((entry) => entry.proxyWallet),
    backfilled: backfilled.map((entry) => entry.proxyWallet),
  });

  if (!cfg.COPYTRADE_SHORTLIST_AUTO_APPLY) {
    logger.info('[copytrade-shortlist] auto-apply disabled; not updating COPYTRADE_WALLETS');
    return;
  }

  await updateEnvWallets(wallets);
  logger.info('[copytrade-shortlist] COPYTRADE_WALLETS updated', { count: wallets.length });
}

if (process.env['NODE_ENV'] !== 'test') {
  run().catch((err) => {
    logger.error('[copytrade-shortlist] failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  });
}
