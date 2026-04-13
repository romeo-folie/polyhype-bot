/**
 * Entity extraction from market questions.
 *
 * Extracts meaningful keyword tokens from a Polymarket question for
 * pair-finding. Strips punctuation, lowercases, and removes common stop
 * words and short tokens. No LLM — pure string processing.
 *
 * The output is used by pairFinder.ts to build a reverse index and
 * efficiently find market pairs with overlapping entities.
 */

// Common English stop words + prediction-market boilerplate that carry
// no entity-matching signal.
const STOP_WORDS = new Set([
  // articles / prepositions / conjunctions
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or',
  'but', 'not', 'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'shall', 'can',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
  'he', 'she', 'his', 'her', 'him', 'who', 'what', 'when', 'where',
  'which', 'how', 'than', 'then', 'if', 'so', 'no', 'yes', 'any', 'all',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'only', 'own', 'same', 'about', 'up', 'out', 'into', 'over', 'after',
  'before', 'between', 'under', 'again', 'further', 'once',
  // prediction-market boilerplate
  'market', 'resolve', 'resolves', 'resolved', 'resolution',
  'price', 'above', 'below', 'exceed', 'reach', 'before', 'after',
  'end', 'start', 'date', 'year', 'month', 'day', 'time', 'during',
  'happen', 'happens', 'occurring', 'occur', 'occurs',
]);

// Minimum token length to keep (after lowercasing).
const MIN_TOKEN_LENGTH = 3;

/**
 * Extract meaningful entity tokens from a market question.
 *
 * @returns lowercased token set, e.g. `Set { 'russia', 'ukraine', 'invade' }`
 */
export function extractMarketEntities(question: string): Set<string> {
  // Strip all non-alphanumeric/space characters, collapse whitespace.
  const cleaned = question
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const tokens = new Set<string>();
  for (const word of cleaned.split(' ')) {
    if (word.length < MIN_TOKEN_LENGTH) continue;
    if (STOP_WORDS.has(word)) continue;
    // Skip pure numbers (years, thresholds like "100", "2026").
    if (/^\d+$/.test(word)) continue;
    tokens.add(word);
  }

  return tokens;
}
