/**
 * Task 1.3 — Redis deduplication layer.
 *
 * Filters out articles already seen in the last 24 hours using Redis
 * pipelined SET NX commands for efficiency.
 */

import { getRedis } from '../shared/redis.js';
import { logger } from '../shared/logger.js';
import type { RawArticle } from './types.js';

const DEDUP_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function dedupKey(articleId: string): string {
  return `dedup:article:${articleId}`;
}

/**
 * Returns only articles not seen in the last 24h.
 * Marks returned (new) articles in Redis with TTL.
 */
export async function filterNew(articles: RawArticle[]): Promise<RawArticle[]> {
  if (articles.length === 0) return [];

  const redis = getRedis();

  // Pipeline EXISTS checks for all articles
  const checkPipeline = redis.pipeline();
  for (const article of articles) {
    checkPipeline.exists(dedupKey(article.id));
  }
  const existsResults = await checkPipeline.exec();

  // Identify new articles (not yet in Redis)
  const newArticles: RawArticle[] = [];
  for (let i = 0; i < articles.length; i++) {
    const result = existsResults?.[i];
    // result is [error, value] — value 0 means key does not exist
    if (result && result[0] === null && result[1] === 0) {
      newArticles.push(articles[i]!);
    }
  }

  // Pipeline SET NX for all new articles
  if (newArticles.length > 0) {
    const setPipeline = redis.pipeline();
    for (const article of newArticles) {
      setPipeline.set(dedupKey(article.id), '1', 'EX', DEDUP_TTL_SECONDS, 'NX');
    }
    await setPipeline.exec();
  }

  logger.info(`[dedup] ${String(newArticles.length)}/${String(articles.length)} articles are new`);
  return newArticles;
}
