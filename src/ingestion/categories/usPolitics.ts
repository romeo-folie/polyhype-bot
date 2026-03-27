import type { CategoryConfig } from './types.js';

const US_POLITICS_PROMPT =
  'You are a political analyst focused on U.S. governance. You will receive a list of news headlines. ' +
  'Rate the urgency of each headline on a scale of 1-10, ' +
  'where 10 = major vote, executive order, or Supreme Court ruling, ' +
  'and 1 = routine statement or poll. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["Senate", "bill"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const usPolitics: CategoryConfig = {
  id: 'us-politics',
  label: 'US Politics (Non-Election)',
  feeds: [
    { url: 'https://rss.politico.com/politics-news.xml' },
    { url: 'https://www.govtrack.us/posts.rss' },
    { url: 'https://feeds.npr.org/1014/rss.xml' },
  ],
  scorerPrompt: US_POLITICS_PROMPT,
  scoreThreshold: 7,
  entityContext: 'US politician, government agency, legislation, court',
};
