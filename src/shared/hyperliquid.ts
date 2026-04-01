import { ethers } from 'ethers';
import axios from 'axios';
import * as msgpack from '@msgpack/msgpack';
import { createHash } from 'node:crypto';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

// --- Hyperliquid Constants ---
const MAINNET_API = 'https://api.hyperliquid.xyz';
const TESTNET_API = 'https://api.hyperliquid-testnet.xyz';

/** Hard timeout for all HL API requests — prevents hung workers. */
const HL_REQUEST_TIMEOUT_MS = 15_000;

// --- Hyperliquid Asset Mapping ---
/** Mapping of external asset IDs (CoinGecko/Binance/Yahoo) to HL perp symbols */
export const HL_SYMBOL_MAP: Record<string, string> = {
  'bitcoin': 'BTC',
  'ethereum': 'ETH',
  'solana': 'SOL',
  'arbitrum': 'ARB',
  'optimism': 'OP',
  'chainlink': 'LINK',
  'avalanche-2': 'AVAX',
  'polygon-hermez': 'POL', // Updated to POL
  'cardano': 'ADA',
  'ripple': 'XRP',
  'dogecoin': 'DOGE',
  'binancecoin': 'BNB',
  'bittensor': 'TAO',
  'sui': 'SUI',
  'berachain': 'BERA',
  'jupiter-exchange-solana': 'JUP',
  'pendle': 'PENDLE',
  'ondo-finance': 'ONDO',
};

/**
 * Pre-compiled regex patterns for resolveHlSymbol.
 * Created once at module load time to avoid re-allocating RegExp objects on every call.
 */
const HL_SYMBOL_PATTERNS: { id: string; symbol: string; wbId: RegExp; wbSym: RegExp }[] =
  Object.entries(HL_SYMBOL_MAP).map(([id, symbol]) => ({
    id,
    symbol,
    wbId: new RegExp(`\\b${id}\\b`, 'i'),
    wbSym: new RegExp(`\\b${symbol.toLowerCase()}\\b`, 'i'),
  }));

/**
 * Resolves a text string (headline or question) to a Hyperliquid asset symbol.
 *
 * Uses word-boundary regex matching to prevent short symbols ('sol', 'op', 'arb', etc.)
 * from matching common English words and triggering false-positive futures trades.
 * Long IDs (>= 6 chars, e.g. 'bitcoin') are matched as substrings; short IDs
 * and all symbols require a word boundary on each side.
 */
export function resolveHlSymbol(text: string): string | undefined {
  const lowerText = text.toLowerCase();
  for (const { wbId, symbol, wbSym } of HL_SYMBOL_PATTERNS) {
    if (wbId.test(lowerText) || wbSym.test(lowerText)) return symbol;
  }
  return undefined;
}

// EIP-712 Types for Hyperliquid
const TYPES = {
  'Agent': [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

// Monotonic nonce generator to prevent collision when Date.now() is called twice in the same millisecond.
let _hlNonce = Date.now();
function nextHlNonce(): number { return ++_hlNonce; }

export interface HlPosition {
  symbol: string;
  position: {
    szi: string;
    entryPx: string;
    leverage: { type: string; value: number } | number;
    unrealizedPnl: string;
    marginUsed: string;
    coin: string;
  };
}

interface HlDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

interface HlMetaUniverse {
  name: string;
  szDecimals: number;
  [key: string]: unknown;
}

interface HlMeta {
  universe: HlMetaUniverse[];
}

interface HlClearinghouseState {
  marginSummary: { accountValue: string };
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      leverage: { type: string; value: number } | number;
      unrealizedPnl: string;
      marginUsed: string;
    };
  }[];
}

/**
 * Hyperliquid Client Singleton
 */
class HyperliquidClient {
  private wallet: ethers.Wallet;
  private baseUrl: string;
  private domain: HlDomain;
  private metaCache: HlMeta | null = null;
  private metaCacheTime = 0;
  // Global mid-price cache: all symbols are refreshed atomically via `allMids` in
  // getMidPrice, so a single timestamp is correct. Per-symbol TTL would only be
  // needed if individual symbols were fetched independently.
  private midCache: Record<string, string> = {};
  private midCacheTime = 0;

  constructor() {
    const cfg = loadConfig();
    if (!cfg.HYPERLIQUID_PRIVATE_KEY) {
      throw new Error('HYPERLIQUID_PRIVATE_KEY is missing');
    }
    // SECURITY: this.wallet stores a live ethers.Wallet with the private key.
    // Never log this.wallet or pass it to error reporters — only log this.wallet.address.
    this.wallet = new ethers.Wallet(cfg.HYPERLIQUID_PRIVATE_KEY);
    this.baseUrl = cfg.HYPERLIQUID_TESTNET ? TESTNET_API : MAINNET_API;

    // Chain ID must be dynamic: HL Testnet = 1337, HL Mainnet = 42161 (Arbitrum)
    this.domain = {
      name: 'Exchange',
      version: '1',
      chainId: cfg.HYPERLIQUID_TESTNET ? 1337 : 42161,
      verifyingContract: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    };
    
    logger.info('[hyperliquid] client initialised', {
      address: this.wallet.address,
      testnet: cfg.HYPERLIQUID_TESTNET,
      chainId: this.domain.chainId,
    });
  }

  /**
   * Place a market order on Hyperliquid.
   */
  async placeMarketOrder(opts: {
    symbol: string;
    isBuy: boolean;
    sizeUsd: number;
    leverage: number;
    reduceOnly?: boolean;
    sizeBase?: number; // Added to avoid double lookup if possible
  }): Promise<{ success: boolean; txHash?: string; error?: string }> {
    // Dry-run mode: log the order without submitting — safe validation path.
    if (loadConfig().HL_DRY_RUN) {
      logger.info('[hyperliquid] DRY RUN — order not submitted', {
        symbol: opts.symbol,
        isBuy: opts.isBuy,
        sizeUsd: opts.sizeUsd,
        leverage: opts.leverage,
        reduceOnly: opts.reduceOnly ?? false,
      });
      return { success: true, txHash: 'dry-run' };
    }

    try {
      // 1. Get asset index for the symbol
      const { index, szDecimals } = await this.getAssetMeta(opts.symbol);
      if (index === -1) throw new Error(`Symbol ${opts.symbol} not found on Hyperliquid`);

      // 2. Manage leverage (Account-level setting).
      // Failure is hard-stop: proceeding with wrong leverage is a direct financial risk.
      const leverageOk = await this.updateLeverage(opts.symbol, opts.leverage);
      if (!leverageOk) {
        return { success: false, error: `updateLeverage failed for ${opts.symbol} — order aborted to avoid wrong-leverage trade` };
      }

      // 3. Size calculation — guard against zero/invalid mid price to prevent Infinity order size.
      const midPrice = await this.getMidPrice(opts.symbol);
      if (!midPrice || !isFinite(midPrice) || midPrice <= 0) {
        return { success: false, error: `getMidPrice returned invalid value (${String(midPrice)}) for ${opts.symbol} — order aborted` };
      }
      const sizeBase = opts.sizeBase ?? (opts.sizeUsd / midPrice);

      // 4. Construct the Action
      const action = {
        type: 'order',
        orders: [{
          asset: index,
          isBuy: opts.isBuy,
          limitPx: this.roundPrice(opts.isBuy
            ? midPrice * (1 + loadConfig().FUTURES_IOC_SLIPPAGE)
            : midPrice * (1 - loadConfig().FUTURES_IOC_SLIPPAGE)),
          sz: this.roundSize(sizeBase, szDecimals),
          reduceOnly: opts.reduceOnly ?? false,
          orderType: { limit: { tif: 'Ioc' } } // Market orders must use Ioc (Immediate or Cancel)
        }],
        grouping: 'na'
      };

      const nonce = nextHlNonce();
      const signature = await this.signAction(action, nonce);

      const payload = {
        action,
        nonce,
        signature,
      };

      const response = await axios.post(`${this.baseUrl}/exchange`, payload, { timeout: HL_REQUEST_TIMEOUT_MS });

      if (response.data?.status === 'ok') {
        const statuses = response.data?.response?.data?.statuses;
        if (!Array.isArray(statuses) || statuses.length === 0) {
          return { success: false, error: 'HL response missing statuses array' };
        }
        const result = statuses[0] as Record<string, unknown> | undefined;
        if (!result) {
          return { success: false, error: 'HL statuses[0] is undefined' };
        }
        const filled = result['filled'] as { oid?: unknown } | undefined;
        const resting = result['resting'] as { oid?: unknown } | undefined;
        const errorMsg = result['error'] as string | undefined;
        if (filled?.oid != null) {
          return { success: true, txHash: String(filled.oid) };
        }
        if (resting?.oid != null) {
          // With IOC, resting should not happen for the full size unless partially filled.
          return { success: true, txHash: String(resting.oid) };
        }
        if (errorMsg) {
          return { success: false, error: errorMsg };
        }
      }

      return { success: false, error: JSON.stringify(response.data) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Set leverage for an asset. Must be called before placing an order if leverage differs from default.
   */
  async updateLeverage(symbol: string, leverage: number): Promise<boolean> {
    try {
      const { index } = await this.getAssetMeta(symbol);
      const action = {
        type: 'updateLeverage',
        asset: index,
        isCross: true,
        leverage: leverage,
      };
      
      const nonce = nextHlNonce();
      const signature = await this.signAction(action, nonce);
      await axios.post(`${this.baseUrl}/exchange`, { action, nonce, signature }, { timeout: HL_REQUEST_TIMEOUT_MS });
      return true;
    } catch (err) {
      logger.error('[hyperliquid] updateLeverage failed — caller must abort order', { symbol, leverage, error: String(err) });
      return false;
    }
  }

  /**
   * Fetch current Clearinghouse state (balance/margin).
   */
  async getClearinghouseState(): Promise<HlClearinghouseState> {
    const response = await axios.post(`${this.baseUrl}/info`, {
      type: 'clearinghouseState',
      user: this.wallet.address,
    }, { timeout: HL_REQUEST_TIMEOUT_MS });
    return response.data;
  }

  /**
   * Retrieve all open perp positions, optionally from a pre-fetched state object.
   * Pass a pre-fetched state to avoid an extra API round-trip.
   */
  async getOpenPositions(preloadedState?: HlClearinghouseState): Promise<HlPosition[]> {
    const state = preloadedState ?? await this.getClearinghouseState();
    if (!state.assetPositions) return [];

    return state.assetPositions.map((ap) => ({
      symbol: ap.position.coin,
      position: {
        szi: ap.position.szi,
        entryPx: ap.position.entryPx,
        leverage: ap.position.leverage,
        unrealizedPnl: ap.position.unrealizedPnl,
        marginUsed: ap.position.marginUsed,
        coin: ap.position.coin,
      },
    }));
  }

  /**
   * Close a position by symbol.
   */
  async closePosition(symbol: string): Promise<{ success: boolean; txHash?: string; error?: string }> {
    const positions = await this.getOpenPositions();
    const pos = positions.find((p) => p.symbol === symbol);

    if (!pos) return { success: false, error: `No open position for ${symbol}` };

    const currentSize = parseFloat(pos.position.szi);
    if (Math.abs(currentSize) < 0.0001) return { success: true }; // already closedish

    const isBuy = currentSize < 0; // if short, we buy
    
    // Defensive leverage parsing: HL sometimes returns leverage as an object { type: string, value: number }
    const leverageValue = typeof pos.position.leverage === 'object' ? pos.position.leverage.value : pos.position.leverage;

    // Pass raw sizeBase to avoid slippage effects on size calculation
    return this.placeMarketOrder({
      symbol,
      isBuy,
      sizeUsd: 0, // Not used if sizeBase is provided
      sizeBase: Math.abs(currentSize),
      leverage: leverageValue,
      reduceOnly: true,
    });
  }

  // --- Private Helpers ---

  private async signAction(action: Record<string, unknown>, nonce: number): Promise<{ r: string; s: string; v: number }> {
    const msgpackBytes = msgpack.encode(action);
    
    // HL expects: keccak256(msgpack(action) + nonce(8 bytes) + vaultAddress(20 bytes))
    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64BE(BigInt(nonce));
    
    const vaultBuffer = Buffer.alloc(20); // Default zero address for no vault
    
    const dataToHash = Buffer.concat([Buffer.from(msgpackBytes), nonceBuffer, vaultBuffer]);
    const connectionId = ethers.keccak256(dataToHash);

    const signature = await this.wallet.signTypedData(this.domain, TYPES, {
      source: 'Exchange',
      connectionId: connectionId,
    });
    
    const sigSplit = ethers.Signature.from(signature);

    return {
      r: sigSplit.r,
      s: sigSplit.s,
      v: sigSplit.v,
    };
  }

  private async getAssetMeta(symbol: string): Promise<{ index: number; szDecimals: number }> {
    // 1 hour cache
    if (this.metaCache && Date.now() - this.metaCacheTime < 3600_000) {
      const idx = this.metaCache.universe.findIndex((u) => u.name === symbol);
      return { index: idx, szDecimals: this.metaCache.universe[idx]?.szDecimals ?? 4 };
    }

    const response = await axios.post(`${this.baseUrl}/info`, { type: 'meta' }, { timeout: HL_REQUEST_TIMEOUT_MS });
    this.metaCache = response.data as HlMeta;
    this.metaCacheTime = Date.now();
    
    const idx = (this.metaCache.universe ?? []).findIndex((u) => u.name === symbol);
    const szDecimals = this.metaCache.universe[idx]?.szDecimals ?? 4;
    return { index: idx, szDecimals };
  }

  /**
   * Fetch mid prices for all assets.
   * Note: The cache is updated globally for all symbols when any symbol is fetched.
   * TTL check is also global (all symbols expire together every 30s).
   */
  private async getMidPrice(symbol: string): Promise<number> {
    // 30 second cache
    if (this.midCache[symbol] && Date.now() - this.midCacheTime < 30_000) {
      return parseFloat(this.midCache[symbol]);
    }

    const response = await axios.post(`${this.baseUrl}/info`, { type: 'allMids' }, { timeout: HL_REQUEST_TIMEOUT_MS });
    this.midCache = response.data || {};
    this.midCacheTime = Date.now();
    
    return parseFloat(this.midCache[symbol] || '0');
  }

  private roundPrice(px: number): number {
    // toPrecision(5) truncates BTC prices (~$95,000) to 5 sig figs, losing sub-dollar precision.
    // Use 6 significant figures to preserve meaningful price resolution across all traded assets.
    return parseFloat(px.toPrecision(6));
  }

  private roundSize(sz: number, szDecimals: number): number {
    return parseFloat(sz.toFixed(szDecimals));
  }
}

let _client: HyperliquidClient | null = null;
/**
 * SHA-256 hash of the private key used to construct the current client.
 * We store a hash (not the raw key) so the module-level variable cannot be
 * used to reconstruct the key from a heap dump or process snapshot.
 */
let _clientKeyHash: string | null = null;

/** Hash a private key for comparison — never store the raw key at module level. */
function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Gets the singleton Hyperliquid client instance.
 * If the private key in config has changed since the last call (e.g. after a config
 * hot-reload), the singleton is automatically invalidated and a new client is created.
 * This prevents stale credentials being used after a key rotation.
 */
export function getHyperliquid(): HyperliquidClient {
  const cfg = loadConfig();
  // Track HYPERLIQUID_PRIVATE_KEY via its hash — never store the raw key at module level.
  const currentKeyHash = cfg.HYPERLIQUID_PRIVATE_KEY ? hashKey(cfg.HYPERLIQUID_PRIVATE_KEY) : null;
  if (!_client || currentKeyHash !== _clientKeyHash) {
    _client = new HyperliquidClient();
    _clientKeyHash = currentKeyHash;
  }
  return _client;
}

/**
 * Resets the Hyperliquid client singleton.
 * Mandatory for test teardown to avoid leaking state/mocks.
 */
export function resetHyperliquid(): void {
  _client = null;
  _clientKeyHash = null;
}
