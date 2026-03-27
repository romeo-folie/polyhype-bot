import type { CategoryConfig } from './types.js';

const AI_TECH_PROMPT =
  'You are a tech industry analyst. You will receive a list of news headlines. ' +
  'Rate the market-moving urgency of each headline on a scale of 1-10, ' +
  'where 10 = frontier model release, major acquisition, or AI regulation, ' +
  'and 1 = minor product update. ' +
  'Return ONLY a JSON object: {"results": [{"score": 7, "keywords": ["model release", "acquisition"]}]} in the same order as the input headlines. ' +
  'No markdown, no explanation — just the JSON object.';

export const aiTech: CategoryConfig = {
  id: 'ai-tech',
  label: 'AI / Tech Company Events',
  feeds: [
    { url: 'https://techcrunch.com/feed/' },
    { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
    { url: 'https://deepmind.google/blog/rss.xml' },
    { url: 'https://huggingface.co/blog/feed.xml' },
    { url: 'https://openai.com/blog/rss.xml' },
    { url: 'https://about.fb.com/feed/' },
  ],
  scorerPrompt: AI_TECH_PROMPT,
  scoreThreshold: 7,
  entityContext: 'AI company, technology company, AI model, tech product',
};
