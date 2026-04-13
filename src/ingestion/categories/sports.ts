import type { CategoryConfig } from './types.js';

const SPORTS_PROMPT =
  'You are a sports betting analyst. You will receive a list of news headlines. ' +
  'Rate the market-moving urgency of each headline on a scale of 1-10, ' +
  'where 10 = confirmed star player out for playoff game, major trade before tip-off, ' +
  'or late scratch / starting lineup change, and 1 = routine recap or off-season chatter. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["injury", "starting lineup"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const sports: CategoryConfig = {
  id: 'sports',
  label: 'Sports (NBA / NHL)',
  feeds: [
    { url: 'https://sports.yahoo.com/nba/rss.xml' },
    { url: 'https://sports.yahoo.com/nhl/rss.xml' },
  ],
  scorerPrompt: SPORTS_PROMPT,
  scoreThreshold: 5,
  entityContext: 'sports team, player, league (NBA/NHL), game, playoff series',
};
