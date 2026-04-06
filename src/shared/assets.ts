/**
 * Shared asset metadata and search queries.
 */

export const ASSET_SEARCH_QUERIES: Record<string, string[]> = {
  bitcoin: ['bitcoin', 'BTC'],
  ethereum: ['ethereum', 'ETH'],
  solana: ['solana', 'SOL'],
  bittensor: ['TAO', 'bittensor'],
  ripple: ['XRP', 'ripple'],
  binancecoin: ['BNB', 'binance coin'],
  dogecoin: ['dogecoin', 'DOGE'],
  cardano: ['cardano', 'ADA'],
  avalanche: ['avalanche', 'AVAX'],
  chainlink: ['chainlink', 'LINK'],
  'shiba-inu': ['SHIB', 'shiba'],
  sui: ['SUI'],
  pepe: ['PEPE'],
  'CL=F': ['oil', 'crude', 'OPEC', 'sanctions'],
  'GC=F': ['gold', 'safe haven', 'precious metals'],
};

/** Binance WebSocket symbol → CoinGecko asset ID mapping. */
export const BINANCE_SYMBOL_TO_ASSET: Record<string, string> = {
  btcusdt: 'bitcoin',
  ethusdt: 'ethereum',
  solusdt: 'solana',
  xrpusdt: 'ripple',
  bnbusdt: 'binancecoin',
  taousdt: 'bittensor',
  dogeusdt: 'dogecoin',
  adausdt: 'cardano',
  avaxusdt: 'avalanche',
  linkusdt: 'chainlink',
  suiusdt: 'sui',
  shibusdt: 'shiba-inu',
  pepeusdt: 'pepe',
};

const CRYPTO_ASSET_IDS = new Set(Object.values(BINANCE_SYMBOL_TO_ASSET));

/**
 * Check if an assetId belongs to a crypto asset.
 */
export function isCryptoAsset(assetId: string): boolean {
  return CRYPTO_ASSET_IDS.has(assetId);
}
