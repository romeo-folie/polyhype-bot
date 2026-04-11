/**
 * Trade memory embedding cron — Phase 5 (#146).
 *
 * Reads closed outcomes from Postgres that have not yet been embedded into
 * trade_memory_cases. For each outcome, builds a `reasoning_text` string,
 * calls OpenAI text-embedding-3-small to produce a vector(1536), then inserts
 * the case into trade_memory_cases.
 *
 * Schedule: nightly (see docker-compose.yml pga-cron service, INTERVAL 24h).
 *
 * Safety:
 *   - Skips outcomes already present in trade_memory_cases (LEFT JOIN dedup).
 *   - Batches OpenAI calls in groups of 20 to avoid rate limits.
 *   - Failures are logged and skipped — never crash the cron loop.
 *   - Requires OPENAI_API_KEY and PG_URL; exits 0 cleanly if either is absent.
 */

import { loadConfig } from '../shared/config.js';
import { getSql, closeSql } from '../db/client.js';
import { logger } from '../shared/logger.js';

const EMBED_BATCH_SIZE = 20;
const EMBED_MODEL = 'text-embedding-3-small';

interface OutcomeRow {
  outcome_id: string;
  decision_id: string | null;
  market_id: string;
  condition_id: string | null;
  question: string;
  category: string;
  direction: string;
  price_zone: number | null;
  result: string;
  return_pct: number;
  holding_hours: number;
  consensus_probability: number;
}

function buildReasoningText(row: OutcomeRow): string {
  const returnStr = `${row.return_pct >= 0 ? '+' : ''}${row.return_pct.toFixed(1)}%`;
  const probStr = `${(row.consensus_probability * 100).toFixed(0)}%`;
  const zoneStr = row.price_zone != null ? ` zone-${row.price_zone.toString()}` : '';
  return (
    `${row.direction} position on "${row.question.slice(0, 300)}" ` +
    `(${row.category}${zoneStr}, consensus ${probStr}). ` +
    `Result: ${row.result.toUpperCase()} | Return: ${returnStr} | ` +
    `Held: ${row.holding_hours.toFixed(1)}h`
  );
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.OPENAI_API_KEY) {
    logger.info('[embed-cron] OPENAI_API_KEY not set — skipping embedding run');
    return;
  }

  if (!cfg.PG_URL) {
    logger.info('[embed-cron] PG_URL not set — skipping embedding run');
    return;
  }

  const sql = getSql();

  // Find outcomes not yet embedded
  const rows = await sql<OutcomeRow[]>`
    SELECT
      o.outcome_id,
      o.decision_id,
      o.market_id,
      o.condition_id,
      o.question,
      o.category,
      o.direction::text,
      o.price_zone,
      o.result::text,
      o.return_pct,
      o.holding_hours,
      o.consensus_probability
    FROM outcomes o
    LEFT JOIN trade_memory_cases tmc ON tmc.outcome_id = o.outcome_id
    WHERE tmc.id IS NULL
      AND o.is_reconciled = false
      AND o.return_pct IS NOT NULL
      AND o.holding_hours IS NOT NULL
      AND o.consensus_probability IS NOT NULL
    ORDER BY o.closed_at DESC
    LIMIT 500
  `;

  if (rows.length === 0) {
    logger.info('[embed-cron] no unembedded outcomes — done');
    return;
  }

  logger.info('[embed-cron] embedding outcomes', { count: rows.length });

  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: cfg.OPENAI_API_KEY });

  let embedded = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(buildReasoningText);

    let embeddings: number[][];
    try {
      const resp = await client.embeddings.create({
        model: EMBED_MODEL,
        input: texts,
      });
      embeddings = resp.data.map((d) => d.embedding);
    } catch (err) {
      logger.warn('[embed-cron] OpenAI batch failed', {
        error: err instanceof Error ? err.message : String(err),
        batchStart: i,
        batchSize: batch.length,
      });
      failed += batch.length;
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      const row = batch[j]!;
      const embedding = embeddings[j];
      if (!embedding || embedding.length !== 1536) {
        failed++;
        continue;
      }

      const caseType: string = row.return_pct >= 0 ? 'success' : 'cautionary_traded';
      const reasoningText = texts[j]!;
      const embStr = `[${embedding.join(',')}]`;

      try {
        await sql`
          INSERT INTO trade_memory_cases (
            outcome_id, decision_id, market_id, condition_id, question, category,
            direction, price_zone, case_type, result, return_pct, holding_hours,
            consensus_probability, reasoning_text, embedding, model_version, is_reconciled
          ) VALUES (
            ${row.outcome_id}::uuid,
            ${row.decision_id ?? null}::uuid,
            ${row.market_id},
            ${row.condition_id ?? null},
            ${row.question},
            ${row.category},
            ${row.direction}::direction_t,
            ${row.price_zone ?? null},
            ${caseType}::memory_case_type_t,
            ${row.result}::outcome_result_t,
            ${row.return_pct},
            ${row.holding_hours},
            ${row.consensus_probability},
            ${reasoningText},
            ${embStr}::vector,
            ${EMBED_MODEL},
            false
          )
          ON CONFLICT DO NOTHING
        `;
        embedded++;
      } catch (err) {
        logger.warn('[embed-cron] insert failed', {
          error: err instanceof Error ? err.message : String(err),
          outcomeId: row.outcome_id,
        });
        failed++;
      }
    }

    logger.debug('[embed-cron] batch done', {
      batchStart: i,
      batchSize: batch.length,
      embedded,
      failed,
    });
  }

  logger.info('[embed-cron] embedding run complete', { embedded, failed, total: rows.length });
}

main()
  .catch((err) => {
    logger.error('[embed-cron] fatal error', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  })
  .finally(() => {
    closeSql().catch(() => {});
  });
