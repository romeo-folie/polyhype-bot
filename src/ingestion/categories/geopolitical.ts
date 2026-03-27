import type { CategoryConfig } from './types.js';

const GEOPOLITICAL_PROMPT =
  'You are a geopolitical analyst. You will receive a list of news headlines. ' +
  'Rate the geopolitical urgency of each headline on a scale of 1-10, ' +
  'where 10 = immediate geopolitical crisis/military action, 1 = routine news. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["war", "conflict"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const geopolitical: CategoryConfig = {
  id: 'geopolitical',
  label: 'Geopolitical',
  feeds: [
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
    { url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
  ],
  scorerPrompt: GEOPOLITICAL_PROMPT,
  scoreThreshold: 8,
  entityContext: 'country, leader, military organization, conflict, international body',
};
