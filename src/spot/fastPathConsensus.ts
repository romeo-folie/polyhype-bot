/**
 * Fast-path consensus estimator.
 *
 * For price-target markets (e.g. "Will BTC be above $100k on June 30?"):
 *   Uses a Black-Scholes-inspired binary option probability formula.
 *   Runs in <1ms with zero API calls once cached.
 *
 * For non-price-target markets (e.g. "Will the SEC approve a Bitcoin ETF?"):
 *   Falls back to the existing LLM-based consensus calculator,
 *   injecting the spot move as context.
 */

import { createHash } from 'node:crypto';
import { logger } from '../shared/logger.js';
import { estimateConsensusProbability } from '../mapping/consensusCalculator.js';
import { getRedis } from '../shared/redis.js';
import { loadConfig } from '../shared/config.js';
import type { Redis } from 'ioredis';
import type { SpotMove } from './thresholdDetector.js';
import type { CorrelatedMarket } from './marketCorrelator.js';

export interface FastConsensusResult {
  probability: number;
  reasoning: string;
  method: 'formula' | 'llm';
  /** Standard deviation across consensus samples.
   *  0 for formula-based estimates (deterministic).
   *  Real stddev for LLM-based estimates (multi-sample). */
  stddev: number;
  /** Number of LLM samples that contributed to the estimate. Undefined for
   *  the formula path (deterministic, so sample-count gates don't apply). */
  sampleCount?: number;
}

/** Default annualised volatility estimates by asset class. */
const DEFAULT_ANNUAL_VOL: Record<string, number> = {
  bitcoin: 0.8,
  ethereum: 0.9,
  'CL=F': 0.4,
  'GC=F': 0.2,
};

const DEFAULT_VOL = 0.6;

interface PriceTarget {
  targetPrice: number;
  direction: 'above' | 'below';
  deadlineMs: number; // epoch ms
  method: 'regex' | 'deepseek';
}

/**
 * Attempt to extract a price target from a market question.
 */
export function extractPriceTarget(question: string): PriceTarget | null {
  const priceMatch = question.match(/\$([0-9,]+(?:\.[0-9]+)?)\s*([kKmM])?/);
  if (!priceMatch) return null;

  let targetPrice = parseFloat(priceMatch[1]!.replace(/,/g, ''));
  const suffix = priceMatch[2]?.toLowerCase();
  if (suffix === 'k') targetPrice *= 1_000;
  if (suffix === 'm') targetPrice *= 1_000_000;
  if (!isFinite(targetPrice) || targetPrice <= 0) return null;

  const questionLower = question.toLowerCase();
  const isBelow = /\bbelow\b/.test(questionLower);
  const direction: 'above' | 'below' = isBelow ? 'below' : 'above';

  const deadlineMs = extractDeadline(question);
  if (deadlineMs == null) return null;

  return { targetPrice, direction, deadlineMs, method: 'regex' };
}

/** Returns UTC end-of-day (23:59:59.999 UTC) for a given year/month/day. */
function utcEndOfDay(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day, 23, 59, 59, 999);
}

function extractDeadline(question: string): number | null {
  const months: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };

  const monthDayYearMatch = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?!\d)(?:\s*,\s*|\s+)(\d{4})\b/i,
  );

  if (monthDayYearMatch) {
    const month = months[monthDayYearMatch[1]!.toLowerCase()]!;
    const day = parseInt(monthDayYearMatch[2]!, 10);
    const year = parseInt(monthDayYearMatch[3]!, 10);
    return utcEndOfDay(year, month, day);
  }

  const monthYearMatch = question.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i,
  );

  if (monthYearMatch) {
    const month = months[monthYearMatch[1]!.toLowerCase()]!;
    const year = parseInt(monthYearMatch[2]!, 10);
    // Use UTC end of the last day of the month (day=0 of next month = last day of current month)
    const lastDay = new Date(year, month + 1, 0).getUTCDate();
    return utcEndOfDay(year, month, lastDay);
  }

  const isoMatch = question.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1]!, 10);
    const month = parseInt(isoMatch[2]!, 10) - 1; // zero-indexed
    const day = parseInt(isoMatch[3]!, 10);
    return utcEndOfDay(year, month, day);
  }

  return null;
}

function normalCdf(x: number): number {
  const t = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2.0);
  const prob =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1.0 - prob : prob;
}

export function formulaProbability(
  currentPrice: number,
  targetPrice: number,
  direction: 'above' | 'below',
  annualVol: number,
  timeToExpiryYears: number,
): number {
  if (timeToExpiryYears <= 0) {
    if (direction === 'above') return currentPrice > targetPrice ? 0.99 : 0.01;
    return currentPrice < targetPrice ? 0.99 : 0.01;
  }

  const volSqrtT = annualVol * Math.sqrt(timeToExpiryYears);
  if (volSqrtT === 0) {
    if (direction === 'above') return currentPrice > targetPrice ? 0.99 : 0.01;
    return currentPrice < targetPrice ? 0.99 : 0.01;
  }

  const d2 =
    (Math.log(currentPrice / targetPrice) - 0.5 * annualVol * annualVol * timeToExpiryYears) /
    volSqrtT;
  const prob = direction === 'above' ? normalCdf(d2) : 1 - normalCdf(d2);
  return Math.max(0.01, Math.min(0.99, prob));
}

/**
 * DeepSeek-V3 Structural Parser (Intelligence Path)
 */
async function deepseekStructuralParse(question: string): Promise<PriceTarget | null> {
  const cfg = loadConfig();
  if (!cfg.DEEPSEEK_API_KEY) return null;

  // Redis cache check
  const parseCacheKey = 'deepseek:parse:' + createHash('sha256').update(question.trim()).digest('hex');
  try {
    const cached = await getRedis().get(parseCacheKey);
    if (cached !== null) {
      return cached === 'null' ? null : JSON.parse(cached) as PriceTarget;
    }
  } catch {
    // cache read failed — fall through to LLM
  }

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: cfg.DEEPSEEK_API_KEY,
      baseURL: 'https://api.deepseek.com/v1',
    });

    const prompt = `Extract binary option parameters from this Polymarket question.
Question: "${question}"
Today's Date: ${new Date().toISOString().split('T')[0]}

Rules:
1. Identify targetPrice: numerical value (handle $XXk as XX000).
2. Identify direction: "above" or "below".
3. Identify deadlineMs: epoch milliseconds for the resolution date. 
4. If relative (e.g. "by end of June"), assume the last day of the month at 23:59:59.

Return ONLY JSON: {"targetPrice": 100000, "direction": "above", "deadlineMs": 1751241600000}
If not a price-target market, return {"error": "not_price_target"}.`;

    const response = await client.chat.completions.create({
      model: cfg.DEEPSEEK_MODEL || 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      await cacheParseResult(parseCacheKey, null, cfg.DEEPSEEK_PARSE_CACHE_TTL_S);
      return null;
    }

    const parsed = JSON.parse(content);
    if (parsed.error) {
      await cacheParseResult(parseCacheKey, null, cfg.DEEPSEEK_PARSE_CACHE_TTL_S);
      return null;
    }

    const targetPrice = Number(parsed.targetPrice);
    const deadlineMs = Number(parsed.deadlineMs);
    const direction =
      parsed.direction === 'above' || parsed.direction === 'below' ? parsed.direction : null;

    if (
      !direction ||
      !Number.isFinite(targetPrice) ||
      targetPrice <= 0 ||
      !Number.isFinite(deadlineMs) ||
      deadlineMs <= 0
    ) {
      await cacheParseResult(parseCacheKey, null, cfg.DEEPSEEK_PARSE_CACHE_TTL_S);
      return null;
    }

    const result: PriceTarget = { targetPrice, direction, deadlineMs, method: 'deepseek' };
    await cacheParseResult(parseCacheKey, result, cfg.DEEPSEEK_PARSE_CACHE_TTL_S);
    return result;
  } catch (err) {
    logger.error('[deepseek-parser] failed', { error: String(err) });
    return null;
  }
}

async function cacheParseResult(key: string, value: PriceTarget | null, ttl: number): Promise<void> {
  try {
    await getRedis().set(key, value === null ? 'null' : JSON.stringify(value), 'EX', ttl);
  } catch {
    // cache write failed — non-fatal
  }
}

/**
 * Estimate consensus probability for a correlated market given a spot move.
 */
export async function estimateFastConsensus(
  move: SpotMove,
  market: CorrelatedMarket,
  annualVol?: number,
  opts?: { redis?: Redis },
): Promise<FastConsensusResult> {
  const cacheKey = `mapping:consensus:v2:${market.marketId}`;
  const redis = opts?.redis ?? getRedis();

  // 1. Hybrid Registry Check
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      const target = JSON.parse(cached) as PriceTarget;
      const now = Date.now();
      // Skip formula path if the market's deadline has already passed
      if (target.deadlineMs <= now) {
        // Market is expired — return current price as probability, skip formula
        logger.debug('[fast-consensus] cached target expired, using spot price', {
          marketId: market.marketId,
          deadlineMs: target.deadlineMs,
        });
      } else {
        const prob = formulaProbability(
          move.currentPrice,
          target.targetPrice,
          target.direction,
          annualVol ?? DEFAULT_ANNUAL_VOL[move.assetId] ?? DEFAULT_VOL,
          (target.deadlineMs - now) / (365.25 * 24 * 3600 * 1000),
        );
        return {
          probability: prob,
          method: 'formula',
          reasoning: `Formula (cached ${target.method}): target=${target.targetPrice}, dir=${target.direction}`,
          stddev: 0,
        };
      }
    }
  } catch {
    /* cache miss */
  }

  // 2. Extraction Path (Regex -> DeepSeek for likely price-target questions only)
  let target = extractPriceTarget(market.question);
  if (!target) {
    const question = market.question || '';
    const hasPriceCue =
      /\$|usd\b|us dollars?\b|dollars?\b|\b\d+(?:\.\d+)?k\b|\bprice\b|\babove\b|\bbelow\b|\bat least\b|\bat most\b/i.test(
        question,
      );
    const hasDateCue =
      /\b(on|by|before|after|during|at|end of)\b|jan(?:uary)?\b|feb(?:ruary)?\b|mar(?:ch)?\b|apr(?:il)?\b|may\b|jun(?:e)?\b|jul(?:y)?\b|aug(?:ust)?\b|sep(?:t(?:ember)?)?\b|oct(?:ober)?\b|nov(?:ember)?\b|dec(?:ember)?\b|\b\d{4}\b|\b(today|tomorrow|tonight|this week|this month|this year)\b/i.test(
        question,
      );
    if (hasPriceCue && hasDateCue) {
      target = await deepseekStructuralParse(market.question);
    }
  }

  if (target) {
    const now = Date.now();
    // Only cache and use formula if the market hasn't expired
    if (target.deadlineMs > now) {
      await redis.set(cacheKey, JSON.stringify(target), 'EX', 86400).catch(() => {});
      const prob = formulaProbability(
        move.currentPrice,
        target.targetPrice,
        target.direction,
        annualVol ?? DEFAULT_ANNUAL_VOL[move.assetId] ?? DEFAULT_VOL,
        (target.deadlineMs - now) / (365.25 * 24 * 3600 * 1000),
      );
      return {
        probability: prob,
        method: 'formula',
        reasoning: `Formula (${target.method}): target=${target.targetPrice}, dir=${target.direction}`,
        stddev: 0,
      };
    }
  }

  // 3. Slow Fallback (Full LLM)
  const consensus = await estimateConsensusProbability({
    question: market.question,
    description: market.description,
    headline: `Spot move detected for ${move.assetId}: ${move.changePercent > 0 ? '+' : ''}${move.changePercent.toFixed(2)}% in ${move.windowMinutes}min. Current price: ${move.currentPrice}.`,
    redis,
    skipContextInjection: true,
    ...(market.endDate ? { endDateIso: market.endDate } : {}),
  });

  const consensusStddev = (consensus as { stddev?: number }).stddev ?? 0;
  const consensusSampleCount = (consensus as { sampleCount?: number }).sampleCount;
  return {
    probability: consensus.probability,
    reasoning: consensus.reasoning,
    method: 'llm',
    stddev: consensusStddev,
    ...(consensusSampleCount !== undefined ? { sampleCount: consensusSampleCount } : {}),
  };
}
