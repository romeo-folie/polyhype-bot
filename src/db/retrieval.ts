/**
 * Semantic retrieval for trade_memory_cases (Phase 5 / #146).
 *
 * `findSimilarCases` embeds a query string via OpenAI text-embedding-3-small,
 * then runs a pgvector cosine-similarity search against trade_memory_cases.
 * Filters by category and is_reconciled to keep results domain-relevant.
 *
 * Called from consensusCalculator.ts to prepend historical trade context to the
 * LLM prompt (MEMORY_RETRIEVAL_ENABLED=true required).
 *
 * Designed to be fully non-blocking: any error causes the function to return []
 * so the consensus pipeline is never gated on memory retrieval.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
import { getSql } from './client.js';

export interface SimilarCase {
  caseType: 'success' | 'cautionary_traded' | 'cautionary_skipped';
  result: string | null;
  returnPct: number | null;
  holdingHours: number | null;
  consensusProbability: number | null;
  question: string;
  category: string;
  direction: string;
  priceZone: number | null;
  reasoningText: string;
  similarity: number;
}

/**
 * Embed `text` using OpenAI text-embedding-3-small.
 * Returns null if OpenAI is not configured or the call fails.
 */
async function embedText(text: string): Promise<number[] | null> {
  const cfg = loadConfig();
  if (!cfg.OPENAI_API_KEY) return null;

  try {
    const { OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });
    const resp = await client.embeddings.create({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8_000),
    });
    return resp.data[0]?.embedding ?? null;
  } catch (err) {
    logger.warn('[retrieval] embedding call failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Find the top `limit` trade_memory_cases semantically similar to `queryText`,
 * filtered to the given `category`.
 *
 * Returns [] on any error (non-blocking for callers).
 */
export async function findSimilarCases(
  queryText: string,
  category: string,
  limit = 5,
): Promise<SimilarCase[]> {
  try {
    const embedding = await embedText(queryText);
    if (!embedding || embedding.length === 0) return [];

    const embStr = `[${embedding.join(',')}]`;
    const sql = getSql();

    const rows = await sql<{
      case_type: string;
      result: string | null;
      return_pct: number | null;
      holding_hours: number | null;
      consensus_probability: number | null;
      question: string;
      category: string;
      direction: string;
      price_zone: number | null;
      reasoning_text: string;
      similarity: number;
    }[]>`
      SELECT
        case_type,
        result,
        return_pct,
        holding_hours,
        consensus_probability,
        question,
        category,
        direction,
        price_zone,
        reasoning_text,
        (1 - (embedding <=> ${embStr}::vector)) AS similarity
      FROM trade_memory_cases
      WHERE category = ${category}
        AND is_reconciled = false
      ORDER BY embedding <=> ${embStr}::vector
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      caseType: r.case_type as SimilarCase['caseType'],
      result: r.result,
      returnPct: r.return_pct,
      holdingHours: r.holding_hours,
      consensusProbability: r.consensus_probability,
      question: r.question,
      category: r.category,
      direction: r.direction,
      priceZone: r.price_zone,
      reasoningText: r.reasoning_text,
      similarity: r.similarity,
    }));
  } catch (err) {
    logger.warn('[retrieval] findSimilarCases failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
      category,
    });
    return [];
  }
}

/**
 * Format a list of similar cases as a concise context block for the LLM prompt.
 * Returns empty string if cases is empty.
 */
export function formatMemoryContext(cases: SimilarCase[]): string {
  if (cases.length === 0) return '';

  const lines = cases.map((c) => {
    const returnStr =
      c.returnPct != null
        ? `${c.returnPct >= 0 ? '+' : ''}${c.returnPct.toFixed(1)}%`
        : 'N/A';
    const holdStr = c.holdingHours != null ? `${c.holdingHours.toFixed(1)}h` : 'N/A';
    const probSegment =
      c.consensusProbability != null
        ? ` [${(c.consensusProbability * 100).toFixed(0)}% conf]`
        : '';
    const tag = c.caseType === 'success' ? '✓' : c.caseType === 'cautionary_traded' ? '✗' : '⊘';
    return (
      `${tag} ${c.direction} on "${c.question.slice(0, 100)}"` +
      `${probSegment} → ${c.result?.toUpperCase() ?? 'SKIP'} | ${returnStr} in ${holdStr}`
    );
  });

  return (
    `Semantically similar past trades (use to calibrate — do not override your primary analysis):\n` +
    lines.join('\n') +
    '\n\n'
  );
}
