import type { CategoryConfig } from './types.js';

const CRYPTO_PROMPT =
  'You are a crypto regulatory analyst. You will receive a list of news headlines. ' +
  'Rate the regulatory urgency of each headline on a scale of 1-10, ' +
  'where 10 = major ETF ruling, exchange ban, or legislation passed, ' +
  'and 1 = minor update or guidance. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["ETF", "SEC"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const cryptoRegulatory: CategoryConfig = {
  id: 'crypto-regulatory',
  label: 'Crypto / Regulatory',
  feeds: [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { url: 'https://cointelegraph.com/rss' },
    { url: 'https://www.theblock.co/rss.xml' },
  ],
  scorerPrompt: CRYPTO_PROMPT,
  scoreThreshold: 8,
  entityContext: 'cryptocurrency, regulatory body, financial regulator',
};
