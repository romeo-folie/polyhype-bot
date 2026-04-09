/**
 * Shared asset metadata and search queries.
 *
 * Single source of truth — imported by correlator, warmer, arb scanner, etc.
 */

export const ASSET_SEARCH_QUERIES: Record<string, string[]> = {
  // --- Major crypto ---
  bitcoin: ['bitcoin', 'BTC'],
  ethereum: ['ethereum', 'ETH'],
  solana: ['solana', 'SOL'],
  ripple: ['XRP', 'ripple'],
  binancecoin: ['BNB', 'binance coin'],
  dogecoin: ['dogecoin', 'DOGE'],
  cardano: ['cardano', 'ADA'],
  avalanche: ['avalanche', 'AVAX'],
  chainlink: ['chainlink', 'LINK'],
  sui: ['SUI'],
  bittensor: ['TAO', 'bittensor'],
  // --- Meme / speculative ---
  pepe: ['PEPE'],
  'shiba-inu': ['SHIB', 'shiba'],
  dogwifcoin: ['WIF', 'dogwifhat', 'dog wif hat'],
  bonk: ['BONK'],
  pengu: ['PENGU', 'Pudgy Penguins', 'pudgy'],
  // --- Political meme tokens (Polymarket-correlated) ---
  'official-trump': ['TRUMP', 'official trump', 'trump coin'],
  melania: ['MELANIA', 'melania trump', 'melania coin'],
  // --- Layer 2 / DeFi ---
  polkadot: ['polkadot', 'DOT'],
  polygon: ['polygon', 'MATIC', 'POL'],
  litecoin: ['litecoin', 'LTC'],
  uniswap: ['uniswap', 'UNI'],
  toncoin: ['toncoin', 'TON'],
  cosmos: ['cosmos', 'ATOM', 'Cosmos Hub'],
  stacks: ['stacks', 'STX', 'bitcoin L2'],
  // --- High-volume alts ---
  tron: ['tron', 'TRX'],
  stellar: ['stellar', 'XLM'],
  near: ['NEAR protocol', 'NEAR'],
  aptos: ['aptos', 'APT'],
  arbitrum: ['arbitrum', 'ARB'],
  optimism: ['optimism', 'OP'],
  render: ['render', 'RNDR', 'Render Network'],
  injective: ['injective', 'INJ'],
  // --- AI / narrative ---
  'fetch-ai': ['Fetch.ai', 'FET', 'ASI alliance', 'Fetch AI'],
  'virtual-protocol': ['Virtuals Protocol', 'VIRTUAL', 'virtual agents'],
  worldcoin: ['worldcoin', 'WLD', 'World ID', 'Sam Altman biometrics'],
  // --- DeFi / BTC ecosystem ---
  'ethena-usde': ['Ethena', 'ENA', 'USDe', 'ethena protocol'],
  celestia: ['Celestia', 'TIA', 'modular blockchain'],
  'bitcoin-ordinals': ['ordinals', 'ORDI', 'Bitcoin Ordinals', 'inscriptions'],
  thorchain: ['THORChain', 'RUNE', 'cross-chain swap'],
  // --- Commodities ---
  'CL=F': ['oil', 'crude', 'OPEC', 'sanctions'],
  'GC=F': ['gold', 'safe haven', 'precious metals'],
};

/** Binance WebSocket symbol → CoinGecko asset ID mapping. */
export const BINANCE_SYMBOL_TO_ASSET: Record<string, string> = {
  // --- Majors ---
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
  dotusdt: 'polkadot',
  maticusdt: 'polygon',
  ltcusdt: 'litecoin',
  uniusdt: 'uniswap',
  tonusdt: 'toncoin',
  trxusdt: 'tron',
  xlmusdt: 'stellar',
  nearusdt: 'near',
  aptusdt: 'aptos',
  arbusdt: 'arbitrum',
  opusdt: 'optimism',
  rndrusdt: 'render',
  injusdt: 'injective',
  // --- Previously unsubscribed (TA was dead) ---
  berausdt: 'berachain',
  jupusdt: 'jupiter-exchange-solana',
  pendleusdt: 'pendle',
  ondousdt: 'ondo-finance',
  polusdt: 'polygon-hermez',
  // --- New additions ---
  atomusdt: 'cosmos',
  stxusdt: 'stacks',
  trumpusdt: 'official-trump',
  melaniausdt: 'melania',
  wifusdt: 'dogwifcoin',
  bonkusdt: 'bonk',
  penguusdt: 'pengu',
  wldusdt: 'worldcoin',
  fetusdt: 'fetch-ai',
  virtualusdt: 'virtual-protocol',
  enausdt: 'ethena-usde',
  tiausdt: 'celestia',
  ordiusdt: 'bitcoin-ordinals',
  runeusdt: 'thorchain',
};

const CRYPTO_ASSET_IDS = new Set(Object.values(BINANCE_SYMBOL_TO_ASSET));

/**
 * Check if an assetId belongs to a crypto asset.
 */
export function isCryptoAsset(assetId: string): boolean {
  return CRYPTO_ASSET_IDS.has(assetId);
}

/**
 * Get search queries for the market warmer (appends 'price' to each asset's queries).
 */
export function getWarmerQueries(assetId: string): string[] {
  const base = ASSET_SEARCH_QUERIES[assetId] ?? [assetId];
  return [...base, 'price'];
}
