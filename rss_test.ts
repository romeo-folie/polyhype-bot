
import { fetchRssFeeds } from './src/ingestion/rss.js';
import { logger } from './src/shared/logger.js';

async function test() {
  const testFeeds = [
    { url: 'http://rss.cnn.com/rss/edition_world.rss' },
    { url: 'https://www.facebook.com/facebook/posts.rss' }, // Example FB RSS (usually fails)
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' } // Valid baseline
  ];

  console.log('--- RSS Fetch Test ---');
  try {
    const items = await fetchRssFeeds(testFeeds);
    console.log(`Successfully fetched ${items.length} items.`);
    items.slice(0, 5).forEach(i => console.log(`- [${i.source}] ${i.title}`));
  } catch (err) {
    console.error('Test failed with error:', err);
  }
}

test();
