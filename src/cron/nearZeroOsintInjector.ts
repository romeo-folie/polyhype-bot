/**
 * Near-Zero NO-Side OSINT Injector
 *
 * Addresses the structural gap where all existing near_zero:osint_signals entries
 * are direction=YES — because the mapping pipeline only writes NO signals when a
 * market WS feed happens to show NO in the near-zero range (rare in practice).
 *
 * Strategy: actively scan for markets where NO is 3–10¢ (i.e., YES is 90–97¢,
 * meaning the outcome is already near-certain) and cross-match against recent
 * OSINT items. When a headline is relevant to a question, ask a mini-tier LLM:
 * "Does this news make NO of '{question}' even more likely (score 0–10)?"
 * If score ≥ NEAR_ZERO_INJECTOR_MIN_NO_SCORE, write a NO-direction entry to
 * near_zero:osint_signals so the main scanner can trade it.
 *
 * Run schedule (crontab): 15 * * * * — fires on the :15 of every hour,
 * offset from the scanner which runs on :00 and :30.
 *
 * LLM cost is bounded by NEAR_ZERO_INJECTOR_MAX_LLM_PER_RUN (default 10 pairs).
 *
 * Redis keys written:
 *   near_zero:osint_signals  — same zset as the mapping pipeline
 */

import 'dotenv/config';
import type { Redis } from 'ioredis';
import { getRedis, closeRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import { logger } from '../shared/logger.js';
import { getCachedMarkets } from '../shared/watchlist.js';
import { parseOutcomePrices } from '../mapping/gamma.js';
import { getRecentOsintItems } from '../ingestion/osintStore.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface InjectorCandidate {
  marketId: string;
  question: string;
  noPrice: number;
  endDate: string | null;
}

interface ScoreResult {
  score: number;
  reasoning: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const NEAR_ZERO_OSINT_KEY = 'near_zero:osint_signals';
const TIMEOUT_MS = 20_000;

/**
 * Compute a simple token-overlap count between an item's keywords and
 * the lowercased market question. Used as a cheap pre-filter before LLM.
 */
function computeEntityOverlap(keywords: string[], question: string): number {
  const qLower = question.toLowerCase();
  return keywords.filter((kw) => qLower.includes(kw.toLowerCase())).length;
}

/**
 * Ask the mini-tier LLM whether the headline implies NO of '{question}' is
 * increasingly likely (0 = not at all, 10 = near-certain).
 */
async function scoreNoRelevance(
  headline: string,
  question: string,
  endDateIso: string | null,
  apiKey: string,
  model: string,
): Promise<ScoreResult> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => { abortCtrl.abort(); }, TIMEOUT_MS);

  const systemPrompt =
    'You are a prediction-market analyst. You score how strongly a news headline ' +
    'implies the NO outcome of a binary question is likely to occur. ' +
    'Respond ONLY with valid JSON: {"score": <integer 0-10>, "reasoning": "<one sentence>"}. ' +
    'Score 10 = the headline makes NO near-certain; score 0 = completely unrelated.';

  const endDateLine = endDateIso ? `\nQuestion resolves by: ${endDateIso}` : '';
  const userPrompt =
    `Question: "${question}"${endDateLine}\n` +
    `News headline: "${headline}"\n\n` +
    'Score how strongly this headline implies the NO outcome is likely (0–10):';

  let completion: Awaited<ReturnType<typeof client.chat.completions.create>>;
  try {
    completion = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_completion_tokens: 80,
        temperature: 0,
      },
      { signal: abortCtrl.signal },
    );
  } finally {
    clearTimeout(abortTimer);
  }

  const raw = completion.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()) as {
    score: number;
    reasoning: string;
  };
  return { score: Number(parsed.score), reasoning: String(parsed.reasoning) };
}

async function writeNoSignal(
  redis: Redis,
  marketId: string,
  noPrice: number,
  headline: string,
  score: number,
  cfg: ReturnType<typeof loadConfig>,
): Promise<void> {
  const member = JSON.stringify({
    marketId,
    direction: 'NO',
    price: noPrice,
    headline: headline.slice(0, 300),
    urgencyScore: score,
  });
  const nowS = Math.floor(Date.now() / 1000);
  await redis.zadd(NEAR_ZERO_OSINT_KEY, nowS, member);
  // Prune stale entries (same TTL as the mapping pipeline writes).
  const cutoff = nowS - cfg.NEAR_ZERO_OSINT_SIGNAL_TTL_S;
  await redis.zremrangebyscore(NEAR_ZERO_OSINT_KEY, '-inf', cutoff);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runNearZeroOsintInjector(redis: Redis): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.NEAR_ZERO_INJECTOR_ENABLED) {
    logger.info('[nz-injector] disabled — skipping');
    return;
  }

  if (!cfg.OPENAI_API_KEY) {
    logger.warn('[nz-injector] OPENAI_API_KEY not configured — injector requires OpenAI; skipping');
    return;
  }

  // 1. Load recent OSINT items (last 24h).
  const osintItems = await getRecentOsintItems(redis);
  if (osintItems.length === 0) {
    logger.info('[nz-injector] no recent OSINT items — nothing to inject');
    return;
  }

  // 2. Find cached markets where NO is in the near-zero price range (3–10¢).
  //    These are markets where YES is 90–97¢ — outcome is near-certain.
  const allMarkets = await getCachedMarkets(redis);
  const candidates: InjectorCandidate[] = [];

  for (const market of allMarkets) {
    // NOTE: the watchlist slim-cache in `refreshDynamicWatchlist` does NOT
    // persist `active` / `closed` — they are always undefined here. Gating on
    // them silently rejected every market. The cache writer already filters to
    // `active=true&closed=false` at the Gamma fetch and drops past-endDate
    // markets, so no additional guard is needed.
    let noPrice: number;
    try {
      const prices = parseOutcomePrices(market.outcomePrices);
      if (!prices || prices.length < 2) continue;
      noPrice = parseFloat(prices[1] ?? '');
    } catch (err) {
      logger.warn('[nz-injector] skipping market with malformed outcomePrices', {
        marketId: market.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (
      isNaN(noPrice) ||
      noPrice < cfg.NEAR_ZERO_MIN_PRICE ||
      noPrice > cfg.NEAR_ZERO_MAX_PRICE
    ) continue;
    candidates.push({
      marketId: market.id,
      question: market.question,
      noPrice,
      endDate: market.endDate ?? null,
    });
  }

  if (candidates.length === 0) {
    logger.info('[nz-injector] no NO-side near-zero markets found');
    return;
  }

  // 3. Cross-match: for each (candidate, item) pair that shares enough keywords,
  //    score with LLM up to MAX_LLM_PER_RUN times.
  const maxLlm = cfg.NEAR_ZERO_INJECTOR_MAX_LLM_PER_RUN;
  const minOverlap = cfg.NEAR_ZERO_INJECTOR_MIN_ENTITY_OVERLAP;
  const minScore = cfg.NEAR_ZERO_INJECTOR_MIN_NO_SCORE;

  // Build top pairs to score. For each candidate we keep at most
  // PAIRS_PER_CANDIDATE best-matching OSINT items (by overlap then urgency),
  // then take the global top maxLlm across all candidates. This bounds
  // memory at O(candidates × PAIRS_PER_CANDIDATE) instead of O(N×M).
  const PAIRS_PER_CANDIDATE = 2;
  interface Pair { candidate: InjectorCandidate; headline: string; urgency: number; overlap: number }
  const pairs: Pair[] = [];

  for (const candidate of candidates) {
    const best: Pair[] = [];
    for (const item of osintItems) {
      const overlap = computeEntityOverlap(item.keywords, candidate.question);
      if (overlap >= minOverlap) {
        best.push({ candidate, headline: item.title, urgency: item.urgencyScore, overlap });
      }
    }
    if (best.length === 0) continue;
    best.sort((a, b) => b.overlap - a.overlap || b.urgency - a.urgency);
    pairs.push(...best.slice(0, PAIRS_PER_CANDIDATE));
  }

  // Final sort across all candidates; take only what the LLM budget allows.
  pairs.sort((a, b) => b.overlap - a.overlap || b.urgency - a.urgency);
  const pairsToEval = pairs.slice(0, maxLlm);

  logger.info('[nz-injector] pairs to evaluate', {
    totalCandidates: candidates.length,
    osintItems: osintItems.length,
    qualifiedPairs: pairs.length,
    pairsToEval: pairsToEval.length,
    llmBudget: maxLlm,
  });

  let llmCalls = 0;
  let injected = 0;

  for (const { candidate, headline, overlap } of pairsToEval) {

    llmCalls++;
    let result: ScoreResult;
    try {
      result = await scoreNoRelevance(
        headline,
        candidate.question,
        candidate.endDate,
        cfg.OPENAI_API_KEY,
        cfg.OPENAI_MODEL,
      );
    } catch (err) {
      logger.warn('[nz-injector] LLM score failed', {
        marketId: candidate.marketId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    logger.info('[nz-injector] pair scored', {
      marketId: candidate.marketId,
      question: candidate.question.slice(0, 80),
      overlap,
      noScore: result.score,
      minScore,
      reasoning: result.reasoning,
    });

    if (result.score >= minScore) {
      await writeNoSignal(redis, candidate.marketId, candidate.noPrice, headline, result.score, cfg);
      injected++;
      logger.info('[nz-injector] NO signal written', {
        marketId: candidate.marketId,
        noPrice: candidate.noPrice,
        score: result.score,
      });
    }
  }

  logger.info('[nz-injector] run complete', { llmCalls, injected, pairsEvaluated: Math.min(pairs.length, maxLlm) });
}

// CLI entrypoint
const isMain =
  (process.argv[1]?.endsWith('cron/nearZeroOsintInjector.ts') ?? false) ||
  (process.argv[1]?.endsWith('cron/nearZeroOsintInjector.js') ?? false);

if (isMain) {
  const redis = getRedis();
  runNearZeroOsintInjector(redis)
    .catch((err: unknown) => {
      logger.error('[nz-injector] fatal error', {
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    })
    .finally(() => {
      void closeRedis();
    });
}
