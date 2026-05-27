/**
 * Outcome recorder — Phase 8a.
 *
 * Records every closed position with full signal context for:
 *   1. Historical context injection into LLM consensus prompts
 *   2. Calibration tracking per category
 *
 * Storage: Redis hashes + sorted sets. Never throws — all errors are logged.
 */

import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import type { Redis } from 'ioredis';

export interface PositionOutcome {
  id: string;
  closedAt: string;
  executionId?: string;
  source:
    | 'osint'
    | 'copytrade'
    | 'spot'
    | 'arb'
    | 'crypto-arb'
    | 'futures'
    | 'hl-momentum'
    | 'sports'
    | 'clob-flow'
    | 'oracle-lag'
    | 'near-zero-arb'
    | 'longshot-bias'
    | 'correlation-arb'
    | 'weather'
    | 'fv-scanner';
  category: string;
  question: string;
  direction: 'YES' | 'NO' | 'UP' | 'DOWN' | 'LONG' | 'SHORT';
  urgencyScore?: number;
  consensusProbability: number;
  divergence: number;
  result: 'won' | 'lost' | 'pushed';
  returnPct: number;
  holdingHours: number;
  executionVenue: string;
  modeConfigured?: 'hybrid' | 'maker' | 'taker';
  entryExecutionPath?: string;
  entryOrderType?: 'maker' | 'taker' | 'none';
  fallbackReason?: string;
  decisionSpreadBps?: number;
  makerPriceImprovementBps?: number;
  makerPriceImprovementUsd?: number;
  exitReason?: string;
  /** Price-zone classification for the entry outcome price (Change 3 telemetry). */
  priceZone?: 1 | 2 | 3 | 4 | 5;
}

/**
 * Map a position's `sourcedFrom` field to the PositionOutcome source enum.
 */
export function inferSource(sourcedFrom: string): PositionOutcome['source'] {
  const s = sourcedFrom.toLowerCase();
  if (s === 'hl-momentum') return 'hl-momentum';
  if (s.startsWith('copytrade:')) return 'copytrade';
  if (s.startsWith('crypto-arb:')) return 'crypto-arb';
  if (s.startsWith('spot:') || s.startsWith('spot ')) return 'spot';
  if (s.startsWith('arb:') || s.startsWith('market arb')) return 'arb';
  if (s.startsWith('sports:')) return 'sports';
  if (s.startsWith('oracle-lag:')) return 'oracle-lag';
  if (s.startsWith('fv-scanner:')) return 'fv-scanner';
  if (s.startsWith('near-zero-arb')) return 'near-zero-arb';
  if (s.startsWith('longshot-bias')) return 'longshot-bias';
  if (s.startsWith('correlation-arb')) return 'correlation-arb';
  if (s.startsWith('weather:')) return 'weather';
  // Futures origin markers (monitor-driven, backfill, and HL hedges) — these
  // are futures decisions, not OSINT. OSINT-triggered futures trades still
  // label 'osint' by design: the decision source was news, HL is only the venue.
  if (
    s.startsWith('futures-monitor') ||
    s.startsWith('backfill:futures-monitor') ||
    s.startsWith('hedge:pm:')
  ) {
    return 'futures';
  }
  return 'osint'; // default: OSINT news pipeline
}

/**
 * Infer a category from a market question using keyword matching.
 */
export function inferCategory(question: string): string {
  const q = question.toLowerCase();

  // Short-resolution crypto price binaries (e.g. "Bitcoin Up or Down - April 12,
  // 8:55AM-9:00AM ET"). Must be matched BEFORE the general crypto bucket so
  // stale-exit uses the long age window reserved for this shape — these markets
  // sit flat near 0.5 until minutes before the oracle snapshot, then resolve in
  // a thin CLOB book, so the crypto-regulatory 8h window would dump them mid-
  // cycle straight into the empty-book partial-fill trap.
  if (
    /\bup or down\b/.test(q) &&
    /bitcoin|\bbtc\b|\beth\b|ethereum|\bsolana\b|\bsol\b/.test(q)
  ) {
    return 'crypto-updown';
  }

  // Short tokens (eth, sol, btc, etc.) are anchored with \b to prevent false matches
  // like "methane" → eth, "absolute" → sol, "protocol" → btc.
  if (
    /bitcoin|\bbtc\b|\beth\b|ethereum|crypto|\bsolana\b|\bsol\b|\bdoge\b|dogecoin|\bxrp\b|ripple|\bshib\b|shiba|\bpepe\b|binance|coinbase|\bcardano\b|\bada\b|\bavax\b|avalanche|\blink\b|chainlink|\bsui\b|\bdot\b|polkadot|\bmatic\b|polygon|\bltc\b|litecoin|uniswap|\buni\b|toncoin|\bton\b|\btrx\b|tron|stellar|\bxlm\b|\bnear\b|aptos|\bapt\b|arbitrum|\barb\b|optimism|\bop\b|render|\brndr\b|injective|\binj\b|bittensor|\btao\b/.test(
      q,
    )
  ) {
    return 'crypto-regulatory';
  }
  if (/\bfed\b|\brate\b|\bgdp\b|inflation|\bbank\b|\bcpi\b|recession/.test(q)) {
    return 'macro';
  }
  if (
    /trump|biden|congress|senate|white house|democrat|republican/.test(q) ||
    /\bmidterm/.test(q)
  ) {
    return 'us-politics';
  }
  if (/\bai\b|openai|nvidia|anthropic|gemini|gpu|llm/.test(q)) {
    return 'ai-tech';
  }
  if (/\bnba\b|basketball|lakers|warriors|celtics/.test(q)) {
    return 'sports-nba';
  }
  if (/\bnfl\b|american football|super bowl|quarterback/.test(q)) {
    return 'sports-nfl';
  }
  if (
    /soccer|\bfifa\b|world cup|champions league|europa league|premier league|\bepl\b|la liga|bundesliga|serie a|ligue 1|\bmls\b|liga mx|saudi pro league|saudi club|j[123][- ]?league|k[12][- ]?league|brasileirao|eredivisie|primeira liga|super lig|a-league|dortmund|leverkusen|wolfsburg|hoffenheim|stuttgart|köln|\bkoln\b|münchen|\bmunich\b|arsenal|tottenham|chelsea|liverpool|manchester|barcelona|real madrid|atl[eé]tico|juventus|inter milan|ac milan|\bajax\b|\bpsg\b|al[- ](hilal|nassr|ittihad|taawoun|ahli|fateh|fayha|raed|riyadh|wehda|orobah|kholood|khaleej|akhdoud|qadsiah|shabab|ettifaq)/.test(
      q,
    )
  ) {
    return 'sports-soccer';
  }
  if (/\bf1\b|formula[ -]?1|formula[ -]?one|grand prix/.test(q)) {
    return 'sports-f1';
  }
  if (/\bufc\b|\bmma\b|bellator|mixed martial|cage fighting/.test(q)) {
    return 'sports-mma';
  }
  // Tennis tournaments — question format is typically "<Tournament>: <Player> vs <Player>"
  // and rarely contains the word "tennis" itself. Keep in the generic `sports`
  // bucket so category-keyed config lookups (e.g. slippage maps) continue to use
  // existing sports defaults rather than silently falling back to global defaults.
  if (/tennis|atp|wta|roland.garros|wimbledon|australian open|french open|us open(?! source)|miami open|indian wells|monte.carlo|madrid open|barcelona open|italian open|rome masters|cincinnati|canadian open|rogers cup|shanghai|paris masters|davis cup|laver cup|atp finals|wta finals/.test(q)) {
    return 'sports';
  }
  if (/olympics|mlb|baseball|nhl|hockey|championship/.test(q)) {
    return 'sports';
  }
  // "Team A vs. Team B: O/U X.X" — after all sport-specific checks so that
  // markets with known keywords (MMA, tennis, etc.) get the precise bucket first;
  // anything remaining here is an unclassified over/under matchup → generic sports.
  if (/\bvs\.?\s/i.test(q) && /\bo\/u\b/i.test(q)) {
    return 'sports';
  }
  // "Will <X> win on YYYY-MM-DD?" — match-day question pattern is almost
  // exclusively used for soccer (occasionally MLB/NHL but those have keyword
  // matches above). Catches obscure clubs (Saudi/J-League/Liga MX) that don't
  // hit the named-club regex.
  if (/\bwill\b.+\bwin on \d{4}-\d{2}-\d{2}/.test(q)) {
    return 'sports';
  }
  if (/mention|say|tweet|post|transcript|phrase|word|quoted/.test(q)) {
    return 'mentions';
  }
  if (/highest temperature|lowest temperature|\bweather\b|\bsnow\b|\brainfall\b|hurricane/.test(q)) {
    return 'weather';
  }
  // Explicit geopolitical regex — country/conflict/diplomacy keywords.
  // This is the LAST positive match before fallback so generic terms don't
  // pre-empt more specific buckets above.
  // `elect`/`elects`/`elected`/`election`/`referendum`/`coalition government`
  // here catch non-US governance markets that don't hit specific country/conflict
  // keywords above (e.g. "Will Hungary elect TISZA?", "Will Canada's election
  // result in a Liberal majority?"). `election` is intentionally absent from the
  // us-politics check above so foreign elections route here, not there.
  if (
    /\b(war|conflict|invasion|ceasefire|nuclear|military|sanctions|treaty|embargo|coup|troops|airstrike|missile|drone strike|occupation|hostage|prisoner swap|diplomacy|diplomatic|peace deal|peace talks|sovereignty|annexation|prime minister|foreign minister|secretary of state|chancellor|united nations|iaea|icc|g7|g20|uranium|enrichment|warhead|ballistic|iran|russia|ukraine|china|taiwan|israel|hamas|hezbollah|nato|north korea|gaza|venezuela|myanmar|syria|lebanon|yemen|afghanistan|saudi arabia|qatar|turkey|hungary|hormuz|red sea|south china sea|elect|elects|elected|election|referendum|coalition government)\b/.test(
      q,
    )
  ) {
    return 'geopolitical';
  }
  // No category could be determined. Callers should treat 'unknown' as a
  // signal NOT to enter — uncategorized markets bypass our category-aware
  // gates (slippage caps, age windows, notify-only filters). Previously we
  // returned 'geopolitical' as a fallback, which silently mis-bucketed Saudi
  // Pro League, J-League, Mexican Liga MX, etc. as geopolitical and let
  // soccer trades through the COPYTRADE_NOTIFY_ONLY_CATEGORIES gate.
  return 'unknown';
}

/**
 * Record a closed position outcome to Redis.
 * NEVER throws — all errors are caught and logged.
 */
export async function recordOutcome(
  redis: Redis,
  outcome: Omit<PositionOutcome, 'id' | 'closedAt'>,
  opts?: { sourcedFrom?: string | undefined; closedAtMs?: number | undefined },
): Promise<void> {
  try {
    const cfg = loadConfig();
    const id = randomUUID();
    const ts = opts?.closedAtMs ?? Date.now();
    const closedAt = new Date(ts).toISOString();

    const full: PositionOutcome = { ...outcome, id, closedAt };

    // Reconciliation-imported positions have default consensus values (0.5/0)
    // that would poison calibration. Store the hash for audit but skip calibration sets.
    const isReconciled = opts?.sourcedFrom?.startsWith('reconciled:') ?? false;

    // Write hash (always — audit trail)
    const hashKey = `outcome:${id}`;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(full)) {
      fields[k] = String(v ?? '');
    }
    if (opts?.sourcedFrom) fields.sourcedFrom = opts.sourcedFrom;
    await redis.hset(hashKey, fields);
    await redis.expire(hashKey, cfg.OUTCOME_HISTORY_DAYS * 86400);

    // Add to sorted sets (skip category set for reconciled outcomes — keeps calibration clean)
    await redis.zadd('outcomes:all', ts, id);
    if (!isReconciled) {
      await redis.zadd(`outcomes:${outcome.category}`, ts, id);
    }
    await redis.zadd(`outcomes:source:${outcome.source}`, ts, id);

    // Prune if category exceeds max.
    // Remove pruned IDs from all index sets to avoid orphaned references.
    const count = await redis.zcard(`outcomes:${outcome.category}`);
    if (count > cfg.OUTCOME_MAX_PER_CATEGORY) {
      const excess = count - cfg.OUTCOME_MAX_PER_CATEGORY;
      // ioredis zpopmin returns a flat string[] alternating [member, score, member, score, ...]
      const pruned: string[] = await redis.zpopmin(`outcomes:${outcome.category}`, excess);
      const prunedIds = pruned.filter((_v, i) => i % 2 === 0);
      if (prunedIds.length > 0) {
        // Remove from the global index.
        await redis.zrem('outcomes:all', ...prunedIds);
        // Remove from each pruned outcome's actual source set (read from its hash),
        // not the current outcome's source — they may differ for cross-source prunes.
        for (const prunedId of prunedIds) {
          const src = await redis.hget(`outcome:${prunedId}`, 'source');
          if (src) await redis.zrem(`outcomes:source:${src}`, prunedId);
        }
        // Delete the hash entries to free memory.
        const hashKeys = prunedIds.map((id) => `outcome:${id}`);
        await redis.del(...hashKeys);
      }
    }

    logger.info('[outcome-recorder] recorded outcome', {
      id,
      category: outcome.category,
      result: outcome.result,
      returnPct: outcome.returnPct,
    });
  } catch (err) {
    logger.warn('[outcome-recorder] failed to record outcome (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Get recent outcomes for a category, reverse-chronologically.
 * Returns [] if Redis is unavailable or no outcomes exist.
 */
export async function getRecentOutcomes(
  redis: Redis,
  category: string,
  limit?: number,
): Promise<PositionOutcome[]> {
  try {
    const cfg = loadConfig();
    const cap = limit ?? cfg.CONTEXT_INJECTION_LIMIT;
    const ids: string[] = await redis.zrevrange(`outcomes:${category}`, 0, cap - 1);
    if (ids.length === 0) return [];

    const outcomes: PositionOutcome[] = [];
    for (const id of ids) {
      const data = await redis.hgetall(`outcome:${id}`);
      if (!data.id) continue;

      const parsed: PositionOutcome = {
        id: data.id,
        closedAt: data.closedAt ?? '',
        source: data.source as PositionOutcome['source'],
        category: data.category ?? '',
        question: data.question ?? '',
        direction: data.direction as PositionOutcome['direction'],
        consensusProbability: Number(data.consensusProbability) || 0,
        divergence: Number(data.divergence) || 0,
        result: data.result as 'won' | 'lost' | 'pushed',
        returnPct: Number(data.returnPct) || 0,
        holdingHours: Number(data.holdingHours) || 0,
        executionVenue: data.executionVenue ?? '',
      };
      if (data.executionId) parsed.executionId = data.executionId;
      if (data.urgencyScore !== undefined && data.urgencyScore !== null && data.urgencyScore !== '')
        parsed.urgencyScore = Number(data.urgencyScore);
      if (data.modeConfigured)
        parsed.modeConfigured = data.modeConfigured as NonNullable<
          PositionOutcome['modeConfigured']
        >;
      if (data.entryExecutionPath) parsed.entryExecutionPath = data.entryExecutionPath;
      if (data.entryOrderType)
        parsed.entryOrderType = data.entryOrderType as NonNullable<
          PositionOutcome['entryOrderType']
        >;
      if (data.fallbackReason) parsed.fallbackReason = data.fallbackReason;
      if (data.priceZone !== undefined && data.priceZone !== null && data.priceZone !== '') {
        const z = Number(data.priceZone);
        if (z >= 1 && z <= 5) parsed.priceZone = z as 1 | 2 | 3 | 4 | 5;
      }
      if (
        data.decisionSpreadBps !== undefined &&
        data.decisionSpreadBps !== null &&
        data.decisionSpreadBps !== ''
      )
        parsed.decisionSpreadBps = Number(data.decisionSpreadBps);
      if (
        data.makerPriceImprovementBps !== undefined &&
        data.makerPriceImprovementBps !== null &&
        data.makerPriceImprovementBps !== ''
      )
        parsed.makerPriceImprovementBps = Number(data.makerPriceImprovementBps);
      if (
        data.makerPriceImprovementUsd !== undefined &&
        data.makerPriceImprovementUsd !== null &&
        data.makerPriceImprovementUsd !== ''
      )
        parsed.makerPriceImprovementUsd = Number(data.makerPriceImprovementUsd);
      if (data.exitReason) parsed.exitReason = data.exitReason;
      outcomes.push(parsed);
    }

    return outcomes;
  } catch (err) {
    logger.warn('[outcome-recorder] failed to get recent outcomes (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
