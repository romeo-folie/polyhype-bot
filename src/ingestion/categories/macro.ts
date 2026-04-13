import type { CategoryConfig } from './types.js';

const MACRO_PROMPT =
  'You are a macroeconomic analyst. You will receive a list of news headlines. ' +
  'Rate the market-moving urgency of each headline on a scale of 1-10, ' +
  'where 10 = surprise rate decision, CPI shock, or emergency central bank action, ' +
  'and 1 = routine speech or commentary. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["rate cut", "inflation"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const macro: CategoryConfig = {
  id: 'macro',
  label: 'Macro / Central Bank',
  feeds: [
    { url: 'https://www.federalreserve.gov/feeds/press_monetary.xml' },
    { url: 'https://www.ecb.europa.eu/rss/press.html' },
    { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
  ],
  scorerPrompt: MACRO_PROMPT,
  scoreThreshold: 6,
  entityContext: 'financial institution, central bank, economic indicator',
};
