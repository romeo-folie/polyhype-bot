/**
 * Live bankroll tracker — Simmer portfolio + on-chain USDC.e as source of truth.
 *
 * getBankroll() fetches both the Simmer portfolio balance and the on-chain
 * USDC.e balance held in the Polygon wallet, returning their sum.
 *
 * On-chain balance is checked in parallel with Simmer. If the RPC call fails,
 * we degrade gracefully to Simmer-only (a failed on-chain check should never
 * block trading).
 *
 * deductStake() immediately adjusts the in-memory cache so consecutive
 * signals in the same cycle size against the post-trade balance.
 * creditProceeds() adds back to the cache for CLOB exits (Simmer tracks
 * its own wallet; CLOB proceeds are on-chain and not visible to Simmer).
 *
 * The Redis parameter is kept in signatures for backward compatibility with
 * existing callers but is not used.
 */
import type { Redis } from 'ioredis';
import { Contract, JsonRpcProvider, Network, FetchRequest, Wallet } from 'ethers';
import { getPortfolio } from './simmer.js';
import { loadConfig, USDC_E_ADDRESS, POLYGON_FALLBACK_RPCS } from './config.js';
import { logger } from './logger.js';

/** ERC-20 minimal ABI — only balanceOf needed. */
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];

/** Per-RPC call timeout (ms) — prevents hung provider from blocking the pipeline. */
const RPC_TIMEOUT_MS = 10_000;

/** Cached wallet address — derived once from private key, reused on subsequent calls. */
let _cachedWalletAddress: string | null = null;

/**
 * Fetch the USDC.e balance held in the Polygon wallet.
 *
 * Returns 0 on any error (RPC failure, missing key, etc.) so callers
 * can treat it as additive — a fetch failure is non-fatal.
 */
export async function getOnChainUsdcBalance(): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
    // CLOB not configured — skip on-chain check silently.
    return 0;
  }

  // For sigType=1 (POLY_PROXY), funds are held in POLYMARKET_FUNDER_ADDRESS, not the signer wallet.
  // The signer is only used for signing transactions; the proxy contract holds the actual collateral.
  // For sigType=0 (EOA), the signer wallet IS the funder — derive address from the private key.
  const sigType = cfg.POLYMARKET_SIGNATURE_TYPE ?? 0;
  if (sigType === 1 && cfg.POLYMARKET_FUNDER_ADDRESS) {
    // Use the funder address directly — no key derivation needed.
    _cachedWalletAddress = cfg.POLYMARKET_FUNDER_ADDRESS;
  } else if (!_cachedWalletAddress) {
    _cachedWalletAddress = new Wallet(cfg.POLYGON_WALLET_PRIVATE_KEY).address;
  }
  const walletAddress = _cachedWalletAddress;
  const userRpc = cfg.POLYGON_RPC_URL;
  const rpcUrls = [
    ...(userRpc ? [userRpc] : []),
    ...POLYGON_FALLBACK_RPCS.filter((r) => r !== userRpc),
  ];

  const polygonNetwork = new Network('matic', 137);

  for (const rpcUrl of rpcUrls) {
    try {
      const fetchReq = new FetchRequest(rpcUrl);
      fetchReq.timeout = RPC_TIMEOUT_MS;
      const provider = new JsonRpcProvider(fetchReq, polygonNetwork, { staticNetwork: polygonNetwork });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usdc = new Contract(USDC_E_ADDRESS, ERC20_BALANCE_ABI, provider) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      const raw: bigint = await usdc.balanceOf(walletAddress);
      // USDC.e has 6 decimals
      return Number(raw) / 1_000_000;
    } catch (err) {
      logger.warn('[bankroll] on-chain USDC.e balance fetch failed — trying next RPC', {
        rpcUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.warn('[bankroll] all RPCs failed for on-chain USDC.e balance — returning 0');
  return 0;
}

/** Warn when live balance drops below this threshold. */
const LOW_BALANCE_WARN_USD = 1.0;

/** TTL for the in-process balance cache — avoids hammering Simmer on every position-sizing call. */
const CACHE_TTL_MS = 15_000;

/** In-memory fallback: last successfully fetched balance. */
let lastKnownBalance: number | null = null;
let lastFetchTime = 0;

/** Reset cache state. Exported for test use only — do not call in production code. */
export function _resetCacheForTests(): void {
  lastKnownBalance = null;
  lastFetchTime = 0;
  _cachedWalletAddress = null;
}

/**
 * Get the current bankroll (Simmer portfolio + on-chain USDC.e).
 *
 * Fetches both sources in parallel and returns their sum. If the on-chain
 * call fails, degrades gracefully to Simmer-only. Caches the result for
 * CACHE_TTL_MS (15s) so rapid calls within a single pipeline cycle reuse
 * the same value.
 */
export async function getBankroll(_redis?: Redis): Promise<number> {
  const now = Date.now();
  if (lastKnownBalance !== null && now - lastFetchTime < CACHE_TTL_MS) {
    return lastKnownBalance;
  }

  try {
    const [portfolio, onChainUsdc] = await Promise.all([
      getPortfolio(),
      getOnChainUsdcBalance(),
    ]);
    const simmerUsdc = portfolio.balance_usdc;
    const totalUsdc = simmerUsdc + onChainUsdc;

    lastKnownBalance = totalUsdc;
    lastFetchTime = now;

    logger.info('[bankroll] combined balance', {
      simmerUsdc,
      onChainUsdc,
      totalUsdc,
    });

    if (totalUsdc <= 0) {
      logger.error('[bankroll] total balance is zero or negative — all trades will be skipped', {
        totalUsdc,
      });
    } else if (totalUsdc < LOW_BALANCE_WARN_USD) {
      logger.warn('[bankroll] total balance is suspiciously low', { totalUsdc });
    }

    return totalUsdc;
  } catch (err) {
    if (lastKnownBalance !== null) {
      logger.warn('[bankroll] balance fetch failed — using last known balance', {
        lastKnownBalance,
        error: err instanceof Error ? err.message : String(err),
      });
      return lastKnownBalance;
    }
    throw err;
  }
}

/** @deprecated No-op — Simmer tracks the wallet balance directly. */
export async function setBankroll(_redis: Redis, _amount: number): Promise<void> {
  logger.info('[bankroll] setBankroll is deprecated — Simmer tracks the wallet balance');
}

/**
 * Deduct a stake from the in-memory bankroll cache.
 *
 * Simmer deducts from the actual wallet on execution, but the in-process
 * cache needs updating immediately — otherwise the next signal in the same
 * cycle sizes against the full pre-trade balance and Simmer rejects it for
 * insufficient funds.
 */
export async function deductStake(_redis: Redis, stakeUsd: number): Promise<void> {
  if (lastKnownBalance !== null) {
    lastKnownBalance = Math.max(0, lastKnownBalance - stakeUsd);
  }
  logger.info('[bankroll] stake deducted from cache', { stakeUsd, remainingCached: lastKnownBalance });
}

/**
 * Credit proceeds back to the in-memory bankroll cache.
 *
 * For Simmer positions, Simmer tracks the wallet directly. For CLOB positions,
 * proceeds are on-chain — updating the cache here keeps position sizing accurate
 * until the next Simmer portfolio refresh.
 */
export async function creditProceeds(_redis: Redis, proceedsUsd: number): Promise<void> {
  if (lastKnownBalance !== null) {
    lastKnownBalance += proceedsUsd;
  }
  logger.info('[bankroll] proceeds credited', { proceedsUsd, cachedBalance: lastKnownBalance });
}
