import { ethers } from 'ethers';
import axios from 'axios';
import * as msgpack from '@msgpack/msgpack';
import { loadConfig } from './config.js';
import { logger } from './logger.js';

// --- Hyperliquid Constants ---
const MAINNET_API = 'https://api.hyperliquid.xyz';
const TESTNET_API = 'https://api.hyperliquid-testnet.xyz';

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
  'berachain': 'BERA',
  'jupiter-exchange-solana': 'JUP',
  'pendle': 'PENDLE',
  'ondo-finance': 'ONDO',
};

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
  for (const [id, symbol] of Object.entries(HL_SYMBOL_MAP)) {
    // Long IDs are unambiguous enough for substring matching.
    if (id.length >= 6 && lowerText.includes(id)) return symbol;
    // Short IDs and all ticker symbols require word boundaries.
    const wbId = new RegExp(`\\b${id}\\b`, 'i');
    const wbSym = new RegExp(`\\b${symbol.toLowerCase()}\\b`, 'i');
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

/**
 * Hyperliquid Client Singleton
 */
class HyperliquidClient {
  private wallet: ethers.Wallet;
  private baseUrl: string;
  private domain: any;
  private metaCache: any = null;
  private metaCacheTime = 0;
  private midCache: Record<string, string> = {};
  private midCacheTime = 0;

  constructor() {
    const cfg = loadConfig();
    if (!cfg.HYPERLIQUID_PRIVATE_KEY) {
      throw new Error('HYPERLIQUID_PRIVATE_KEY is missing');
    }
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
    try {
      // 1. Get asset index for the symbol
      const { index, szDecimals } = await this.getAssetMeta(opts.symbol);
      if (index === -1) throw new Error(`Symbol ${opts.symbol} not found on Hyperliquid`);

      // 2. Manage leverage (Account-level setting)
      await this.updateLeverage(opts.symbol, opts.leverage);

      // 3. Size calculation
      const midPrice = await this.getMidPrice(opts.symbol);
      const sizeBase = opts.sizeBase ?? (opts.sizeUsd / midPrice);

      // 4. Construct the Action
      const action = {
        type: 'order',
        orders: [{
          asset: index,
          isBuy: opts.isBuy,
          limitPx: this.roundPrice(opts.isBuy ? midPrice * 1.1 : midPrice * 0.9),
          sz: this.roundSize(sizeBase, szDecimals),
          reduceOnly: opts.reduceOnly ?? false,
          orderType: { limit: { tif: 'Ioc' } } // Market orders must use Ioc (Immediate or Cancel)
        }],
        grouping: 'na'
      };

      const nonce = Date.now();
      const signature = await this.signAction(action, nonce);

      const payload = {
        action,
        nonce,
        signature,
      };

      const response = await axios.post(`${this.baseUrl}/exchange`, payload);
      
      if (response.data?.status === 'ok') {
        const result = response.data.response.data.statuses[0];
        if (result.filled) {
          return { success: true, txHash: result.filled.oid.toString() };
        }
        if (result.resting) {
           // With Ioc, resting should generally not happen for the full size unless partially filled
           return { success: true, txHash: result.resting.oid.toString() };
        }
        if (result.error) {
          return { success: false, error: result.error };
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
  async updateLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      const { index } = await this.getAssetMeta(symbol);
      const action = {
        type: 'updateLeverage',
        asset: index,
        isCross: true,
        leverage: leverage,
      };
      
      const nonce = Date.now();
      const signature = await this.signAction(action, nonce);
      await axios.post(`${this.baseUrl}/exchange`, { action, nonce, signature });
    } catch (err) {
      logger.warn('[hyperliquid] updateLeverage failed', { symbol, leverage, error: String(err) });
    }
  }

  /**
   * Fetch current Clearinghouse state (balance/margin).
   */
  async getClearinghouseState(): Promise<any> {
    const response = await axios.post(`${this.baseUrl}/info`, {
      type: 'clearinghouseState',
      user: this.wallet.address,
    });
    return response.data;
  }

  /**
   * Retrieve all open perp positions, optionally from a pre-fetched state object.
   * Pass a pre-fetched state to avoid an extra API round-trip.
   */
  async getOpenPositions(preloadedState?: any): Promise<HlPosition[]> {
    const state = preloadedState ?? await this.getClearinghouseState();
    if (!state?.assetPositions) return [];

    return state.assetPositions.map((ap: any) => ({
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

  private async signAction(action: any, nonce: number): Promise<any> {
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
      const idx = this.metaCache.universe.findIndex((u: any) => u.name === symbol);
      return { index: idx, szDecimals: this.metaCache.universe[idx]?.szDecimals || 4 };
    }

    const response = await axios.post(`${this.baseUrl}/info`, { type: 'meta' });
    this.metaCache = response.data;
    this.metaCacheTime = Date.now();
    
    const idx = (this.metaCache?.universe || []).findIndex((u: any) => u.name === symbol);
    const szDecimals = this.metaCache?.universe?.[idx]?.szDecimals ?? 4;
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

    const response = await axios.post(`${this.baseUrl}/info`, { type: 'allMids' });
    this.midCache = response.data || {};
    this.midCacheTime = Date.now();
    
    return parseFloat(this.midCache[symbol] || '0');
  }

  private roundPrice(px: number): number {
    return parseFloat(px.toPrecision(5));
  }

  private roundSize(sz: number, szDecimals: number): number {
    return parseFloat(sz.toFixed(szDecimals));
  }
}

let _client: HyperliquidClient | null = null;

/**
 * Gets the singleton Hyperliquid client instance.
 */
export function getHyperliquid(): HyperliquidClient {
  if (!_client) _client = new HyperliquidClient();
  return _client;
}

/**
 * Resets the Hyperliquid client singleton.
 * Mandatory for test teardown to avoid leaking state/mocks.
 */
export function resetHyperliquid(): void {
  _client = null;
}
