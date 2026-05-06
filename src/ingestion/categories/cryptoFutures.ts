import type { CategoryConfig } from './types.js';

const CRYPTO_FUTURES_PROMPT =
  'You are a crypto market analyst. You will receive a list of news headlines. ' +
  'Rate how likely each headline is to move the spot/futures price of a named crypto asset significantly within the next hour, on a scale of 1-10, ' +
  'where 10 = major price catalyst (exchange hack, network outage, large-scale liquidation cascade, ETF launch/rejection, hard fork going live, CEX listing/delisting of major token), ' +
  'and 1 = routine news with no immediate price impact (opinion piece, minor update, scheduled maintenance with no disruption). ' +
  'Score 6-9 for: significant whale accumulation/dump, major protocol upgrade activation, DeFi exploit or rug pull, large fund allocation announcement, regulatory action directly targeting a named asset. ' +
  'Focus only on short-term price-action relevance, not long-term regulatory significance. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["ETH", "upgrade"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const cryptoFutures: CategoryConfig = {
  id: 'crypto-futures',
  label: 'Crypto / Futures',
  feeds: [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { url: 'https://cointelegraph.com/rss' },
    { url: 'https://www.theblock.co/rss.xml' },
  ],
  scorerPrompt: CRYPTO_FUTURES_PROMPT,
  scoreThreshold: 6,
  entityContext: 'cryptocurrency, blockchain protocol, DeFi, exchange, futures',
  dedupNamespace: 'crypto-futures',
};
