/**
 * Hyperliquid SDK Wrapper — Lightweight EIP-712 Client.
 * 
 * Provides atomic trade execution for perps on Hyperliquid.
 * Uses ethers v6 for message signing.
 */

import { ethers } from 'ethers';
import axios from 'axios';
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
  'polygon-hermez': 'MATIC', // or POL
  'cardano': 'ADA',
  'ripple': 'XRP',
  'dogecoin': 'DOGE',
  'berachain': 'BERA',
  'jupiter-exchange-solana': 'JUP',
  'pendle': 'PENDLE',
  'ondo-finance': 'ONDO',
};

// EIP-712 Domain for Hyperliquid
const DOMAIN = {
  name: 'HyperliquidExchange',
  version: '1',
  chainId: 1337, // Always 1337 for Hyperliquid signing, even on testnet
  verifyingContract: '0x0000000000000000000000000000000000000000' as `0x${string}`,
};

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
    leverage: { type: string; value: number };
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

  constructor() {
    const cfg = loadConfig();
    if (!cfg.HYPERLIQUID_PRIVATE_KEY) {
      throw new Error('HYPERLIQUID_PRIVATE_KEY is missing');
    }
    this.wallet = new ethers.Wallet(cfg.HYPERLIQUID_PRIVATE_KEY);
    this.baseUrl = cfg.HYPERLIQUID_TESTNET ? TESTNET_API : MAINNET_API;
    
    logger.info('[hyperliquid] client initialised', {
      address: this.wallet.address,
      testnet: cfg.HYPERLIQUID_TESTNET,
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
  }): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      // 1. Get asset index for the symbol
      const assetIndex = await this.getAssetIndex(opts.symbol);
      if (assetIndex === -1) throw new Error(`Symbol ${opts.symbol} not found on Hyperliquid`);

      // 2. Fetch current price to estimate size in base asset
      const midPrice = await this.getMidPrice(opts.symbol);
      const sizeBase = opts.sizeUsd / midPrice;

      // 3. Construct the Action
      const action = {
        type: 'order',
        orders: [{
          asset: assetIndex,
          isBuy: opts.isBuy,
          limitPx: this.roundPrice(opts.isBuy ? midPrice * 1.1 : midPrice * 0.9, opts.symbol),
          sz: this.roundSize(sizeBase, opts.symbol),
          reduceOnly: opts.reduceOnly ?? false,
          orderType: { limit: { tif: 'Gtc' } }
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
          return { success: true, txHash: response.data.response.data.statuses[0].filled.oid.toString() };
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
   * Retrieve all open perp positions specifically structured for the agent.
   */
  async getOpenPositions(): Promise<HlPosition[]> {
    const state = await this.getClearinghouseState();
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
    const midPrice = await this.getMidPrice(symbol);
    const sizeUsd = Math.abs(currentSize) * midPrice;

    return this.placeMarketOrder({
      symbol,
      isBuy,
      sizeUsd,
      leverage: pos.position.leverage.value,
      reduceOnly: true,
    });
  }

  // --- Private Helpers ---

  private async signAction(action: any, nonce: number): Promise<any> {
    const hash = ethers.id(JSON.stringify(action) + nonce);
    const signature = await this.wallet.signMessage(ethers.getBytes(hash));
    const sigSplit = ethers.Signature.from(signature);

    return {
      r: sigSplit.r,
      s: sigSplit.s,
      v: sigSplit.v,
    };
  }

  private async getAssetIndex(symbol: string): Promise<number> {
    const response = await axios.post(`${this.baseUrl}/info`, { type: 'meta' });
    const universe = response.data?.universe || [];
    return universe.findIndex((u: any) => u.name === symbol);
  }

  private async getMidPrice(symbol: string): Promise<number> {
    const response = await axios.post(`${this.baseUrl}/info`, { type: 'allMids' });
    return parseFloat(response.data?.[symbol] || '0');
  }

  private roundPrice(px: number, symbol: string): number {
    return parseFloat(px.toPrecision(5));
  }

  private roundSize(sz: number, symbol: string): number {
    return parseFloat(sz.toFixed(4));
  }
}

let _client: HyperliquidClient | null = null;
export function getHyperliquid(): HyperliquidClient {
  if (!_client) _client = new HyperliquidClient();
  return _client;
}
