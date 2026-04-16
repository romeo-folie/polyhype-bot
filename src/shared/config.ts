/**
 * Environment configuration.
 * Validate and centralise all env reads here.
 * Throws at startup if required variables are missing.
 */

import 'dotenv/config';
import process from 'node:process';
import { z } from 'zod';

/** Polymarket Conditional Tokens Framework (CTF) contract on Polygon mainnet. */
export const CTF_ADDRESS = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045';
/** USDC.e (bridged USDC) on Polygon mainnet — used for CLOB approvals. */
export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/**
 * Public Polygon RPC fallback endpoints — used by clob.ts and bankroll.ts.
 * Order matters: first is tried first. publicnode.com is last (rate-limited on free tier).
 */
export const POLYGON_FALLBACK_RPCS = [
  'https://polygon-rpc.com',
  'https://polygon.llamarpc.com',
  'https://polygon-bor-rpc.publicnode.com',
];

/**
 * Safe boolean coercion from env strings.
 *
 * `boolFromEnv` is a footgun: it uses JS truthiness, so the string
 * `"false"` becomes `true`. This helper accepts the conventional set of
 * falsy literals ("false", "0", "no", "off", "") as `false`, and any other
 * non-empty string as `true`. Native booleans pass through unchanged.
 */
const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'false' || s === '0' || s === 'no' || s === 'off') return false;
    return true;
  });

const envSchema = z.object({
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  SIMMER_API_KEY: z.string().min(1, 'SIMMER_API_KEY is required'),

  // Simmer — auto-redeem
  SIMMER_AUTO_REDEEM_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => !['false', '0', ''].includes(v.trim().toLowerCase())),

  // Simmer — venue gate. When false, new entries skip Simmer and go straight
  // to CLOB; exits on Simmer-entered positions route through CLOB submitClobSell.
  // Redemption + orphan reconciliation continue to use Simmer APIs.
  SIMMER_VENUE_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((v) => !['false', '0', ''].includes(v.trim().toLowerCase())),

  // LLM — at least one must be set (validated below)
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  // MTProto Credentials (from my.telegram.org)
  TELEGRAM_API_ID: z.coerce.number().optional(),
  TELEGRAM_API_HASH: z.string().optional(),
  TELEGRAM_MONITOR_ENABLED: boolFromEnv.optional().default(false),
  TELEGRAM_CHANNELS: z.string().optional().default('dbot_alerts,osint_intel'),
  TELEGRAM_DB_PATH: z.string().optional().default('./tdlib-data'),

  // Wallet / direct CLOB execution
  POLYGON_WALLET_PRIVATE_KEY: z.string().optional(),
  POLYGON_RPC_URL: z.string().url().optional(), // defaults to public RPC in clob.ts if absent
  POLYMARKET_FUNDER_ADDRESS: z.string().optional(),
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).optional().default(0),
  // Builder Relayer — for on-chain redemptions with Magic Proxy wallet (sigType=1)
  // Relayer URL defaults to the Polymarket production endpoint (no config needed)
  // Authenticate with EITHER Relayer API Key OR Builder API Key
  POLYMARKET_RELAYER_URL: z.string().url().optional().default('https://relayer-v2.polymarket.com'),
  POLYMARKET_RELAYER_API_KEY: z.string().optional(), // Relayer API key (simpler auth)
  POLYMARKET_RELAYER_API_KEY_ADDRESS: z.string().optional(), // Address owning the relayer key
  POLYMARKET_BUILDER_API_KEY: z.string().optional(), // Builder API key (alternative auth)
  POLYMARKET_BUILDER_SECRET: z.string().optional(),
  POLYMARKET_BUILDER_PASSPHRASE: z.string().optional(),
  CLOB_FALLBACK_ENABLED: z
    .string()
    .optional()
    .default('true')
    .refine((v: string) => ['true', 'false', '1', '0'].includes(v.trim().toLowerCase()), {
      message: "CLOB_FALLBACK_ENABLED must be 'true', 'false', '1', or '0'",
    })
    .transform((v: string) => !['false', '0'].includes(v.trim().toLowerCase())),
  CLOB_ORDER_TYPE: z.enum(['FOK', 'FAK']).optional().default('FAK'),

  // Model selection (optional — defaults to recommended fast/cheap models)
  OPENAI_MODEL: z.string().optional().default('gpt-4o-mini'),
  GEMINI_MODEL: z.string().optional().default('gemini-2.5-flash'),
  ANTHROPIC_MODEL: z.string().optional().default('claude-haiku-4-5'),
  DEEPSEEK_MODEL: z.string().optional().default('deepseek-reasoner'),

  // Tuning knobs (all optional — defaults apply)
  LLM_PROVIDER: z.enum(['openai', 'gemini']).optional().default('openai'),
  URGENCY_THRESHOLD: z.coerce.number().int().min(1).max(10).optional().default(7),
  DIVERGENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.08),
  MAX_BET_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.1),

  // Extreme-price LLM-distrust gate. Skips trades where the market is priced
  // very near 0 or 1 but the LLM consensus disagrees by an implausibly large
  // margin — protects against the LLM "default to 50% under uncertainty"
  // failure mode on long-tail / multi-outcome markets.
  MIN_PRICE_FOR_LLM_TRUST: z.coerce.number().min(0).max(0.5).optional().default(0.02),
  MAX_LLM_PROB_AT_LOW_PRICE: z.coerce.number().min(0).max(1).optional().default(0.15),

  // Price-zone EV gate (Zones of prediction market risk).
  // Zone 3 (0.40–0.60) requires extra edge to clear fees; Zones 4/5 are blocked
  // directionally by default because small probability errors flip Kelly sign.
  ZONE3_FEE_BUFFER: z.coerce.number().min(0).optional().default(0.02),
  ZONE4_DIRECTIONAL_BLOCK: boolFromEnv.optional().default(true),
  ZONE5_DIRECTIONAL_BLOCK: boolFromEnv.optional().default(true),

  // Kelly fraction multiplier. Community consensus: quarter-Kelly (0.25) balances
  // growth rate vs ruin probability better than half-Kelly (0.50).
  KELLY_FRACTION: z.coerce.number().min(0.05).max(1).optional().default(0.25),

  // Kelly sign-stability check. Perturb p by ±KELLY_PROBE_DELTA; if Kelly
  // flips negative on either side, treat as "no bet" (phantom edge).
  KELLY_PROBE_DELTA: z.coerce.number().min(0).max(0.5).optional().default(0.05),
  KELLY_REQUIRE_SIGN_STABLE: boolFromEnv.optional().default(true),

  // Noise gate — skip signals where LLM consensus stddev exceeds this threshold.
  // Retuned 2026-04-15 (0.13 → 0.22) after the deadline-surfacing fix (2e94071):
  // providers now legitimately disagree more on date-variant questions (7-day
  // vs 77-day horizon), so post-fix stddev distributions shifted upward. Paired
  // with the abstention filter in consensusCalculator (filters exact-0.5
  // anchor returns before mean/stddev), so remaining stddev reflects real
  // disagreement on real votes. The pessimistic-EV gate (p ± stddev) is the
  // primary defense against noisy edges; this threshold is a fast-fail for
  // pathologically wide panels.
  NOISE_STDDEV_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.22),

  // Target number of consensus samples per estimate. n=3 is the design baseline
  // (OpenAI / Gemini / DeepSeek); n=4 is a bonus when Anthropic is available.
  // When n<target, the noise threshold tightens by sqrt((n-1)/(target-1)) to
  // compensate for the systematically-smaller observed stddev with fewer
  // providers. Also gates the [consensus-calc] degraded log and the
  // insufficient-samples skip inside computeDivergence.
  CONSENSUS_TARGET_SAMPLES: z.coerce.number().int().min(2).max(10).optional().default(3),
  // Minimum real-vote samples required to trade. Counts NON-abstention votes
  // only (consensusCalculator filters exact-0.5 abstentions before passing
  // sampleCount through). Lowered 2026-04-15 from 3 → 2: the abstention
  // filter routinely leaves n=2 when one provider anchor-abstains, and
  // blocking those wastes tight-consensus signals. The n=2 single-dissenter
  // concern is handled by the noise gate (0.22 threshold) and the
  // pessimistic-EV gate (p ± stddev); both would reject a high-variance
  // 2-vote panel independently.
  CONSENSUS_MIN_SAMPLES: z.coerce.number().int().min(1).max(10).optional().default(2),

  // Anchor-collapse gate. consensusCalculator's prompt instructs providers to
  // return EXACTLY 0.50 under uncertainty. When every provider hits that
  // anchor, we get consensusP≈0.5 with stddev≈0 — a phantom "agreement" that
  // is actually the LLM default, not real signal. A genuine 50/50 market
  // would still show small provider disagreement. Burned 2026-04-15 on three
  // Virginia referendum bracket markets (all three fired YES at p=0.500,
  // stddev=0.000 — mutually exclusive brackets so 2 of 3 were guaranteed
  // losses). ±0.05 around 0.5 and stddev<0.01 captures the anchor signature
  // without rejecting legitimate near-50% consensus.
  ANCHOR_COLLAPSE_P_DELTA: z.coerce.number().min(0).max(0.5).optional().default(0.05),
  ANCHOR_COLLAPSE_STDDEV_EPSILON: z.coerce.number().min(0).max(0.5).optional().default(0.01),

  // Hyperliquid funding-rate pre-entry gate. HL `funding` is an hourly decimal.
  // Default 1 bp/hr (~8.76%/yr drag). Ship as shadow-logs first, flip after 3-5d.
  HL_FUNDING_GATE_ENABLED: boolFromEnv.optional().default(false),
  HL_MAX_ADVERSE_FUNDING_BPS: z.coerce.number().optional().default(1),

  // Time-to-resolution gate for Polymarket trades. Skips markets that resolve
  // too far in the future (capital sunk into long-dated markets is dead weight)
  // or too soon (illiquid resolution-day games). Per-source overrides because
  // signal alpha decays at different rates: news fastest, copytrade slowest.
  PM_MAX_HOURS_TO_RESOLUTION_DEFAULT: z.coerce.number().min(0).optional().default(504),
  PM_MIN_HOURS_TO_RESOLUTION: z.coerce.number().min(0).optional().default(6),
  PM_MAX_HOURS_TO_RESOLUTION_OSINT: z.coerce.number().min(0).optional().default(504),
  PM_MAX_HOURS_TO_RESOLUTION_SPOT: z.coerce.number().min(0).optional().default(168),
  PM_MAX_HOURS_TO_RESOLUTION_COPYTRADE: z.coerce.number().min(0).optional().default(2160),

  // Execution microstructure controls
  EXECUTION_MODE: z.enum(['hybrid', 'maker', 'taker']).optional().default('hybrid'),
  MAKER_MAX_WAIT_MS: z.coerce.number().int().min(0).optional().default(45_000),
  MAKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).optional().default(1000),
  MAKER_PRICE_EDGE_BPS: z.coerce.number().min(0).optional().default(40),
  // Empty-book maker: geopolitical/niche markets where the CLOB has no resting orders
  // (bid≈0.01/ask≈0.99). Instead of skipping, post a limit order at fair value and
  // resume polling across cron cycles (non-blocking). Fills may take minutes to hours.
  MAKER_EMPTY_BOOK_MAX_WAIT_MS: z.coerce.number().int().min(0).optional().default(900_000),
  MAKER_EMPTY_BOOK_EDGE_BPS: z.coerce.number().min(0).optional().default(150),
  // Minimum LLM consensus strength for empty-book entries. Consensus must be
  // >= this value or <= (1 - this value). Rejects borderline "I don't know"
  // signals (e.g. 0.53) against a ghost-book price that may be months stale.
  // Must be >= 0.5; values below 0.5 invert the skip band and disable the gate.
  MAKER_EMPTY_BOOK_MIN_CONSENSUS: z.coerce.number().min(0.5).max(1).optional().default(0.65),
  // Minimum LLM edge magnitude required for an empty-book maker entry. Signals
  // with small edge in a ghost book often reflect stale/noisy consensus rather than
  // real alpha; the adverse-selection risk in illiquid markets demands higher conviction.
  MAKER_EMPTY_BOOK_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.20),
  // Maximum consensus stddev allowed for empty-book maker entries. High stddev means
  // the LLM samples disagree — a poor basis for a GTC order in a market with no
  // real price discovery.
  MAKER_EMPTY_BOOK_MAX_STDDEV: z.coerce.number().min(0).max(1).optional().default(0.12),
  // Comma-separated whitelist of signal sources that may use the empty-book maker
  // path. Only sources with structural timing/informational edge belong here.
  // osint is excluded from the default whitelist and is discouraged: LLM opinion on
  // news is not a valid basis for a GTC order in a market with no real price
  // discovery or adverse-selection protection.
  MAKER_EMPTY_BOOK_ALLOWED_SOURCES: z
    .string()
    .optional()
    .default('oracle-lag,near-zero-arb')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  // Thresholds for detecting an empty/ghost book. bid < BID_THRESHOLD and
  // ask > ASK_THRESHOLD means no real market maker is resting on the book.
  EMPTY_BOOK_BID_THRESHOLD: z.coerce.number().min(0).max(0.5).optional().default(0.04),
  EMPTY_BOOK_ASK_THRESHOLD: z.coerce.number().min(0.5).max(1).optional().default(0.96),
  // Maker-exit (PM CLOB-entered positions only). Exits are more time-sensitive
  // than entries, so MAKER_EXIT_MAX_WAIT_MS defaults shorter than MAKER_MAX_WAIT_MS.
  // Eligible reasons is a comma-separated list; stop_loss is intentionally NOT eligible.
  MAKER_EXIT_ENABLED: boolFromEnv.optional().default(false),
  MAKER_EXIT_MAX_WAIT_MS: z.coerce.number().int().min(0).optional().default(30_000),
  MAKER_EXIT_PRICE_EDGE_BPS: z.coerce.number().min(0).optional().default(40),
  MAKER_EXIT_ELIGIBLE_REASONS: z
    .string()
    .optional()
    .default('take_profit_threshold,trailing_stop,stale_exit,trend_exit')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  // Trailing stop for PM positions — activation is TAKE_PROFIT_THRESHOLD (not a new knob).
  TRAILING_STOP_ENABLED: boolFromEnv.optional().default(false),
  TRAILING_GIVEBACK_PCT: z.coerce.number().min(0).optional().default(10),
  TRAILING_MIN_EXIT_BID: z.coerce.number().min(0).max(1).optional().default(0.05),
  TAKER_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  TAKER_MIN_EDGE_CATEGORIES: z
    .string()
    .optional()
    .default('{}')
    .transform((v, ctx) => {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'TAKER_MIN_EDGE_CATEGORIES must be a JSON object',
          });
          return z.NEVER;
        }
        return parsed;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'TAKER_MIN_EDGE_CATEGORIES must be valid JSON',
        });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.coerce.number().min(0).max(1))),
  TAIL_TAKER_BLOCK: boolFromEnv.optional().default(true),
  TAIL_PRICE_THRESHOLD: z.coerce.number().min(0).max(0.5).optional().default(0.2),
  TAIL_TAKER_OVERRIDE_EDGE: z.coerce.number().min(0).max(1).optional().default(0.2),

  // Entry spread guardrail: skip trades when the CLOB book spread exceeds this
  // width in basis points of mid. Catches degenerate markets (e.g. $0.01 bid /
  // $0.99 ask → 19600 bps) where the "edge" is an artifact of a one-sided book
  // rather than a real mispricing.
  MAX_ENTRY_SPREAD_BPS: z.coerce.number().min(0).optional().default(500),
  // Per-source spread override for oracle-lag signals. -1 = use global MAX_ENTRY_SPREAD_BPS.
  // BTC 15m Up/Down books near 50¢ have wide spreads that the 500 bps global ceiling was not
  // calibrated for — oracle-lag needs a looser ceiling because the oracle move IS the edge
  // signal, not a spread artefact. Set to e.g. 2000 once instrumentation confirms spread_too_wide.
  ORACLE_LAG_MAX_ENTRY_SPREAD_BPS: z.coerce.number().min(-1).optional().default(-1),

  TAKE_PROFIT_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.25),
  STOP_LOSS_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.3),
  REEVAL_ENABLED: boolFromEnv.optional().default(true),
  REEVAL_EDGE_FLOOR: z.coerce.number().min(0).max(1).optional().default(0.03),
  REEVAL_ITM_SKIP_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.90),

  // WebSocket price feed
  WS_ENABLED: boolFromEnv.optional().default(true),

  // Spot price monitor (Phase 5)
  SPOT_MONITOR_ENABLED: boolFromEnv.optional().default(false),
  SPOT_MOVE_THRESHOLD: z.coerce.number().min(0).optional().default(3),
  SPOT_LOOKBACK_MINUTES: z.coerce.number().int().min(1).optional().default(5),
  SPOT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).optional().default(15),
  SPOT_DIVERGENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.10),
  SPOT_CRYPTO_ASSETS: z
    .string()
    .optional()
    .default(
      'bitcoin,ethereum,solana,ripple,binancecoin,bittensor,dogecoin,cardano,avalanche,chainlink,sui',
    ),
  SPOT_COMMODITY_ASSETS: z.string().optional().default('CL=F,GC=F,SI=F,ES=F,NQ=F'),

  // ── Phase 1: CME settlement arb ──
  SETTLEMENT_ARB_ENABLED: boolFromEnv.optional().default(false),
  SETTLEMENT_PRE_WINDOW_S: z.coerce.number().int().min(0).optional().default(300),
  SETTLEMENT_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.03),
  SETTLEMENT_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(10),

  // ── Phase 2: CLOB flow monitor + tape-based shortlist ──
  CLOB_FLOW_ENABLED: boolFromEnv.optional().default(true),
  CLOB_FLOW_WHALE_MIN_NOTIONAL: z.coerce.number().min(0).optional().default(10000),
  CLOB_FLOW_IMBALANCE_WINDOW_S: z.coerce.number().int().min(1).optional().default(60),
  CLOB_FLOW_GATE_THRESHOLD: z.coerce.number().min(1).optional().default(1.5),
  COPYTRADE_SHORTLIST_SOURCE: z.enum(['leaderboard', 'tape']).optional().default('leaderboard'),

  // Arbitrage scanner (Phase: arb)
  ARB_ENABLED: boolFromEnv.optional().default(true),
  ARB_WORKER_ENABLED: boolFromEnv.optional().default(true),
  ARB_GLOBAL_MAX_TRADES_PER_MIN: z.coerce.number().int().min(1).optional().default(45),
  ARB_MAX_TRADES_PER_MIN: z.coerce.number().int().min(1).optional().default(30),
  CRYPTO_ARB_MAX_TRADES_PER_MIN: z.coerce.number().int().min(1).optional().default(15),

  // Feeds
  RSS_FEED_URLS: z
    .string()
    .optional()
    .default(
      'https://rss.nytimes.com/services/xml/rss/nyt/World.xml,https://feeds.skynews.com/feeds/rss/world.xml,https://feeds.bbci.co.uk/news/world/rss.xml,https://www.aljazeera.com/xml/rss/all.xml',
    ),
  RSS_USER_AGENT: z
    .string()
    .optional()
    .default(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ),
  BINANCE_WS_ENABLED: boolFromEnv.optional().default(true),
  BINANCE_SYMBOLS: z.string().optional().default('btcusdt,ethusdt,solusdt'),
  HELIUS_API_KEY: z.string().optional(),
  // Minimum NET edge (after ~2% per-leg Polymarket fees) to enter an arb trade.
  // Raised from 0.04 to 0.05 to ensure profit after fees.
  ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.05),
  ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Polymarket taker fee rate per trade (~2% default). Configurable for fee tier changes.
  ARB_FEE_RATE: z.coerce.number().min(0).max(1).optional().default(0.02),

  // ── NegRisk Multi-Outcome Arbitrage ──
  // Buys YES on every outcome in a NegRisk event when sum(asks) < 1.0 - fees.
  // Ships dark (NEGRISK_ARB_ENABLED=false). Flip after shadow-log review.
  NEGRISK_ARB_ENABLED: boolFromEnv.optional().default(false),
  // Minimum net edge (after fees) to trigger execution.
  NEGRISK_ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.01),
  // Bankroll fraction risked per NegRisk arb (lower than binary arb — multi-leg risk).
  NEGRISK_ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.03),
  // Per-leg fee rate. Most NegRisk events are currently fee-free.
  NEGRISK_ARB_FEE_RATE: z.coerce.number().min(0).max(1).optional().default(0.0),
  // Minimum fraction of outcomes with active orderbooks to consider arb-able.
  NEGRISK_ARB_MIN_COVERAGE: z.coerce.number().min(0).max(1).optional().default(0.90),
  // Skip events with more outcomes than this (execution time grows linearly).
  NEGRISK_ARB_MAX_OUTCOMES: z.coerce.number().int().min(2).optional().default(30),
  // Dedup TTL — don't re-scan same event within this window.
  NEGRISK_ARB_DEDUP_TTL_S: z.coerce.number().int().positive().optional().default(600),
  // Max NegRisk events to fetch from Gamma per scan.
  NEGRISK_ARB_MAX_EVENTS: z.coerce.number().int().min(1).optional().default(50),
  // Max arb executions per scan cycle.
  NEGRISK_ARB_MAX_PER_RUN: z.coerce.number().int().min(1).optional().default(1),
  // Scan interval in ms (separate from binary arb's 10s baseline).
  NEGRISK_ARB_SCAN_INTERVAL_MS: z.coerce.number().int().min(5000).optional().default(30000),

  // Crypto latency arbitrage (Phase 7)
  CRYPTO_ARB_ENABLED: boolFromEnv.optional().default(true),
  CRYPTO_ARB_VOLATILITY_GATE_ENABLED: boolFromEnv.optional().default(true),
  // Mean absolute % price change per tick. Below floor = flat market, above ceiling = too spiky.
  // Defaults tuned for 1-min BTC ticks: floor 0.0003 (~0.03%), ceiling 0.008 (~0.8%)
  CRYPTO_ARB_MIN_VOLATILITY: z.coerce.number().min(0).optional().default(0.0003),
  CRYPTO_ARB_MAX_VOLATILITY: z.coerce.number().min(0).optional().default(0.008),
  CRYPTO_ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  CRYPTO_ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.03),
  CRYPTO_ARB_DEDUP_TTL_S: z.coerce.number().int().positive().optional().default(180),
  CRYPTO_ARB_MARKET_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(3600),

  // Up/Down Bitcoin market trading
  UPDOWN_ENABLED: boolFromEnv.optional().default(false),
  UPDOWN_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  UPDOWN_MAX_HOURS_TO_RESOLUTION: z.coerce.number().min(1).optional().default(25),
  // Hard cap on Up/Down entries in a rolling 1h window. Independent of the
  // global crypto-arb governor — prevents runaway entries when confluence
  // stays directional across many 5-min market rollovers.
  UPDOWN_MAX_TRADES_PER_HOUR: z.coerce.number().int().min(1).optional().default(2),
  // PnL-gated cooldown: pause Up/Down entries when recent win rate drops.
  // Self-correcting kill-switch for volatility regimes the fair-value table
  // doesn't fit. Acts on closed-position outcomes only.
  UPDOWN_PNL_GATE_ENABLED: boolFromEnv.optional().default(true),
  UPDOWN_PNL_WINDOW_SIZE: z.coerce.number().int().min(1).optional().default(5),
  UPDOWN_PNL_MIN_WIN_RATE: z.coerce.number().min(0).max(1).optional().default(0.4),
  UPDOWN_PNL_COOLDOWN_MIN: z.coerce.number().int().min(1).optional().default(30),
  UPDOWN_PNL_MIN_SAMPLES: z.coerce.number().int().min(1).optional().default(3),

  // Oracle-Lag Scanner (BTC Up/Down 15m, Chainlink oracle-lag sniper).
  // Ships dark — flip ORACLE_LAG_ENABLED to true only after shadow-log review.
  ORACLE_LAG_ENABLED: boolFromEnv.optional().default(false),
  // Minimum Chainlink BTC move % over the lookback window to consider entry (0.07 = 7 bps).
  ORACLE_LAG_MIN_MOVE_PCT: z.coerce.number().min(0).optional().default(0.07),
  // Lookback window in seconds for the Chainlink move computation.
  ORACLE_LAG_MOVE_WINDOW_SEC: z.coerce.number().int().min(1).optional().default(5),
  // Skip entry if time to market resolution is below this many minutes.
  ORACLE_LAG_MIN_TIME_LEFT_MIN: z.coerce.number().min(0).optional().default(5),
  // Skip entry if market price on the signal side exceeds this (fee math breaks above ~0.62).
  ORACLE_LAG_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.62),
  // Fixed per-entry stake — bypasses Half-Kelly (edge is timing, not probability).
  ORACLE_LAG_STAKE_USD: z.coerce.number().min(0).optional().default(5),
  // Hard cap on live entries per hour.
  ORACLE_LAG_MAX_TRADES_PER_HOUR: z.coerce.number().int().min(1).optional().default(10),
  // Empty-book maker edge for oracle-lag signals only. The shared
  // MAKER_EMPTY_BOOK_EDGE_BPS (150 default) is designed for 24h+ LLM-consensus
  // markets where a wide margin compounds edge over many fills. Oracle-lag
  // trades 15m binaries with fair values near 0.50 and ghost books; 150 bps
  // rounds down two ticks, posting at 0.48 vs a 0.495 indicative, and never
  // fills before resolution. 50 bps (prior) posted at 0.49 — filled 1 of 5
  // times. 10 bps rounds to the same 0.01 tick as 0 bps only when fair ≥ 0.501
  // (e.g. 0.5012 − 0.001 = 0.5002 → 0.50); below 0.501 it rounds down a full
  // tick to 0.49. Since ORACLE_LAG_MIN_MOVE_PCT=0.12 forces fair to at least
  // P(YES) = 0.5012 in practice, the equivalence holds for live fires: we
  // post at 0.50 on UP entries — effectively at fair, maximally attractive
  // to arriving takers while still post-only (never crosses). Fee-free on
  // maker fills means this dominates any taker path as long as ghost books
  // remain the norm for these markets.
  ORACLE_LAG_MAKER_EDGE_BPS: z.coerce.number().min(0).optional().default(10),

  // Oracle-Lag gap-compression exit monitor (colocated in arb worker with the
  // scanner). Ships dark: when ORACLE_LAG_EXIT_ENABLED=false the monitor still
  // runs every tick and records a shadow_observations row on the first trigger
  // per position, but does NOT call executeTakeProfit — inherited TP/SL/stale
  // continue to decide exits. Flip to true only after shadow review proves the
  // early-exit beats hold-to-resolution on return.
  ORACLE_LAG_EXIT_ENABLED: boolFromEnv.optional().default(false),
  // Fraction of the entry PM↔fair gap that must close before firing a
  // compression exit. compressionPct = 1 - currentGap/entryGap; exit when
  // compressionPct >= this value.
  ORACLE_LAG_EXIT_COMPRESSION_PCT: z.coerce.number().min(0).max(1).optional().default(0.7),
  // Adverse Chainlink move (bps) past which we exit immediately — the
  // oracle-lag thesis is directional, so a reversal kills the edge.
  ORACLE_LAG_EXIT_REVERSAL_BPS: z.coerce.number().min(0).optional().default(5),
  // Hard timeout — drop the position after this many seconds regardless of
  // compression progress, since the convergence window is ~55s.
  // Upper-bounded at 1500s to stay safely inside the 30-minute exit-state
  // Redis TTL (see EXIT_STATE_TTL_SEC in oracleLagExitMonitor.ts) — otherwise
  // the key could expire before the timeout trigger fires.
  ORACLE_LAG_EXIT_MAX_HOLD_SEC: z.coerce.number().int().min(30).max(1500).optional().default(180),
  // Exit-monitor tick cadence.
  ORACLE_LAG_EXIT_TICK_MS: z.coerce.number().int().min(500).optional().default(2000),

  // Minimum edge to allow entry on fee-enabled markets (executor fee gate).
  // Defaults to 0.04 (4%) — must exceed this to justify the ~2% taker fee.
  FEE_MARKET_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.04),
  // Minimum NET-of-fees edge required to take a TAKER order on a fee-enabled market.
  // Maker fills bypass fees entirely, so this only gates the taker fallback path.
  // Default 0.015 (1.5%) — applied as `grossEdge - estimatedFeeBps/10000 >= threshold`.
  FEE_MARKET_MIN_NET_EDGE: z.coerce.number().min(0).max(1).optional().default(0.015),
  // Estimated taker fee on fee-enabled markets when actual bps is unknown.
  // Polymarket Up/Down and similar fee markets typically charge ~2% (200 bps).
  FEE_MARKET_DEFAULT_BPS: z.coerce.number().min(0).optional().default(200),

  // Tiered Market Logic
  TIERED_LOGIC_ENABLED: z
    .string()
    .optional()
    .default('false')
    .transform((value) => {
      const normalized = value.trim().toLowerCase();
      return normalized !== '' && normalized !== '0' && normalized !== 'false';
    }),
  STANDARD_MIN_VOLUME: z.coerce.number().min(0).optional().default(10000),
  STANDARD_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(5000),
  CRYPTO_MOVE_THRESHOLD: z.coerce.number().min(0).optional().default(0.5),
  CRYPTO_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(50),
  CRYPTO_MIN_VOLUME: z.coerce.number().min(0).optional().default(100),
  CRYPTO_COOLDOWN_MINUTES: z.coerce.number().int().min(1).optional().default(5),
  SHORT_DURATION_HOURS: z.coerce.number().min(0).optional().default(6),
  SHORT_DURATION_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(50),
  SHORT_DURATION_MIN_VOLUME: z.coerce.number().min(0).optional().default(100),

  // Tiered Exit Logic & Monitor Frequency
  CRYPTO_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.10),
  CRYPTO_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.15),
  CRYPTO_UPDOWN_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.10),
  CRYPTO_UPDOWN_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.03),
  SHORT_DURATION_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.10),
  SHORT_DURATION_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.15),
  COPYTRADE_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.40),
  COPYTRADE_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.50),
  COPYTRADE_SPORTS_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.15),
  MONITOR_HEAVY_INTERVAL_MIN: z.coerce.number().int().min(1).optional().default(5),
  // Persistent monitor worker sleep between cycles (ms). Only consumed by
  // `src/monitor/worker.ts` — the cron entrypoint still runs on its own schedule.
  // Default 5s gives ~12×/min position checks with ample Gamma rate-limit headroom.
  MONITOR_LOOP_INTERVAL_MS: z.coerce.number().int().min(1000).optional().default(5000),
  // Zone-aware stop-loss floor. For positions entered in the price tails
  // (entryPrice ≤ EXTREME_LOW or ≥ EXTREME_HIGH), a flat % stop is dominated
  // by spread noise (e.g. -15% on a 3¢ outcome = 0.45¢ = one tick). Require
  // BOTH the % threshold AND an absolute price move of at least this many
  // cents before firing stop_loss. Applies to all sources.
  ZONE_AWARE_SL_ENABLED: boolFromEnv.optional().default(true),
  ZONE_AWARE_SL_EXTREME_LOW: z.coerce.number().min(0).max(1).optional().default(0.1),
  ZONE_AWARE_SL_EXTREME_HIGH: z.coerce.number().min(0).max(1).optional().default(0.9),
  ZONE_AWARE_SL_MIN_ABS_MOVE: z.coerce.number().min(0).max(1).optional().default(0.02),

  // Stale-position exit — rotate capital out of PM positions that never print profit.
  // Rule A: if peak PnL never reached STALE_PEAK_PNL_TARGET_PCT by category age threshold → exit.
  // Rule B: if still underwater + flat (range < STALE_VOL_MAX_PCT over STALE_VOL_WINDOW_H) after
  //         category threshold + STALE_UNDERWATER_EXTRA_H → exit.
  // Excludes copytrades and futures. Re-entry blocked for STALE_REENTRY_COOLDOWN_H.
  STALE_EXIT_ENABLED: boolFromEnv.optional().default(false),
  STALE_PEAK_PNL_TARGET_PCT: z.coerce.number().min(0).optional().default(3.0),
  STALE_MIN_AGE_H_DEFAULT: z.coerce.number().min(1).optional().default(12),
  STALE_MIN_AGE_H_SPORTS: z.coerce.number().min(1).optional().default(6),
  STALE_MIN_AGE_H_CRYPTO_REGULATORY: z.coerce.number().min(1).optional().default(8),
  // Short-resolution crypto binaries (BTC/ETH Up or Down 5m/15m). Held ~24h until
  // the oracle snapshot, flat near 0.5 for most of it. Age is set well past any
  // realistic holding period so Rule A never fires on these; they hold to resolution.
  STALE_MIN_AGE_H_CRYPTO_UPDOWN: z.coerce.number().min(1).optional().default(72),
  STALE_MIN_AGE_H_AI_TECH: z.coerce.number().min(1).optional().default(12),
  STALE_MIN_AGE_H_MACRO: z.coerce.number().min(1).optional().default(18),
  STALE_MIN_AGE_H_US_POLITICS: z.coerce.number().min(1).optional().default(24),
  STALE_MIN_AGE_H_GEOPOLITICAL: z.coerce.number().min(1).optional().default(24),
  STALE_UNDERWATER_EXTRA_H: z.coerce.number().min(0).optional().default(12),
  STALE_VOL_WINDOW_H: z.coerce.number().min(1).optional().default(6),
  STALE_VOL_MAX_PCT: z.coerce.number().min(0).optional().default(1.5),
  STALE_REENTRY_COOLDOWN_H: z.coerce.number().min(0).optional().default(24),

  // Trend exit — exit PM positions on a sustained downward price trend.
  // Uses linear regression over the rolling PnL% sample window (shared with stale exit).
  // Exit fires when: position is sufficiently underwater (MIN_PNL_PCT) AND the regression
  // slope (in %/h) is more negative than the category threshold AND the fit quality (R²)
  // exceeds MIN_R2 (guards against noisy V-shape swings triggering a false trend signal).
  // Category slopes: sports/crypto are wider (more volatile), macro/politics narrower.
  // Ships dark (ENABLED=false). Shadow-log lines appear when criteria are met but flag is off.
  // Re-entry blocked via shared stale:cooldown key for STALE_REENTRY_COOLDOWN_H hours.
  TREND_EXIT_ENABLED: boolFromEnv.optional().default(false),
  TREND_EXIT_WINDOW_H: z.coerce.number().min(1).optional().default(6),
  TREND_EXIT_MIN_PNL_PCT: z.coerce.number().optional().default(-5),
  TREND_EXIT_MIN_AGE_H: z.coerce.number().min(0).optional().default(3),
  TREND_EXIT_MIN_SAMPLES: z.coerce.number().int().min(3).optional().default(10),
  TREND_EXIT_MIN_R2: z.coerce.number().min(0).max(1).optional().default(0.4),
  // Slope thresholds in %/h — must be negative. More negative = steeper decline required.
  // Sports/crypto are volatile so require steeper slope; macro/politics move slowly.
  TREND_EXIT_SLOPE_DEFAULT: z.coerce.number().optional().default(-0.5),
  TREND_EXIT_SLOPE_SPORTS: z.coerce.number().optional().default(-0.8),
  TREND_EXIT_SLOPE_CRYPTO_REGULATORY: z.coerce.number().optional().default(-0.8),
  TREND_EXIT_SLOPE_AI_TECH: z.coerce.number().optional().default(-0.5),
  TREND_EXIT_SLOPE_MACRO: z.coerce.number().optional().default(-0.3),
  TREND_EXIT_SLOPE_US_POLITICS: z.coerce.number().optional().default(-0.3),
  TREND_EXIT_SLOPE_GEOPOLITICAL: z.coerce.number().optional().default(-0.3),

  // Phase 9 — Indicator confluence gate
  CONFLUENCE_GATE_ENABLED: boolFromEnv.optional().default(true),
  CRYPTO_ARB_MIN_CONFLUENCE_SCORE: z.coerce.number().int().min(0).max(3).optional().default(2),
  RSI_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  MACD_FAST: z.coerce.number().int().min(1).optional().default(12),
  MACD_SLOW: z.coerce.number().int().min(1).optional().default(26),
  MACD_SIGNAL: z.coerce.number().int().min(1).optional().default(9),
  STOCHASTIC_K_PERIOD: z.coerce.number().int().min(1).optional().default(14),
  STOCHASTIC_D_PERIOD: z.coerce.number().int().min(1).optional().default(3),

  // Session-aware threshold multipliers (Strategy 6)
  SESSION_THRESHOLD_ENABLED: boolFromEnv.optional().default(false),
  SESSION_MULTIPLIERS: z
    .string()
    .optional()
    .default('1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8'),

  // ── Phase 3: Calibration bias exploitation (Le 2026 recalibration) ──
  // Adjusts market prices by domain-specific θ before edge calculation.
  // p* = p^θ / [p^θ + (1-p)^θ] — corrects systematic over/underconfidence.
  // Ships dark (ENABLED=false). Shadow-logs adjusted prices; flip after review.
  CALIBRATION_BIAS_ENABLED: boolFromEnv.optional().default(false),
  CALIBRATION_BIAS_THETA_POLITICS: z.coerce.number().min(0.1).max(5).optional().default(1.83),
  CALIBRATION_BIAS_THETA_SPORTS_LONG: z.coerce.number().min(0.1).max(5).optional().default(1.74),
  CALIBRATION_BIAS_THETA_SPORTS_SHORT: z.coerce.number().min(0.1).max(5).optional().default(1.20),
  CALIBRATION_BIAS_THETA_WEATHER: z.coerce.number().min(0.1).max(5).optional().default(0.69),
  CALIBRATION_BIAS_THETA_CRYPTO: z.coerce.number().min(0.1).max(5).optional().default(1.0),
  CALIBRATION_BIAS_THETA_ENTERTAINMENT: z.coerce.number().min(0.1).max(5).optional().default(1.50),
  CALIBRATION_BIAS_THETA_DEFAULT: z.coerce.number().min(0.1).max(5).optional().default(1.0),

  // Continuous improvement (Phase 8)
  CALIBRATION_ENABLED: boolFromEnv.optional().default(true),
  MIN_BET_USD: z.coerce.number().min(0).optional().default(5),
  CALIBRATION_MIN_SAMPLES: z.coerce.number().int().positive().optional().default(20),
  OUTCOME_HISTORY_DAYS: z.coerce.number().int().positive().optional().default(180),
  OUTCOME_MAX_PER_CATEGORY: z.coerce.number().int().positive().optional().default(500),
  CONTEXT_INJECTION_ENABLED: boolFromEnv.optional().default(true),
  CONTEXT_INJECTION_LIMIT: z.coerce.number().int().min(1).max(10).optional().default(5),

  // Redeemer guardrails
  REDEEMER_DUPLICATE_WINDOW_S: z.coerce
    .number()
    .int()
    .min(60)
    .optional()
    .default(30 * 24 * 3600),
  REDEEMER_DUST_THRESHOLD_USDC: z.coerce.number().min(0).optional().default(0.25),
  /** Minimum notional (shares * avgPrice) for a reconciled Simmer orphan to be imported. Below this, skip as dust. */
  RECONCILE_IMPORT_MIN_USD: z.coerce.number().min(0).optional().default(1),
  /** Post-exit sweep: after a partial fill, resell the residual up to N times. */
  RESIDUAL_SWEEP_ENABLED: boolFromEnv.optional().default(true),
  RESIDUAL_SWEEP_MAX_ATTEMPTS: z.coerce.number().int().min(0).max(5).optional().default(2),
  /** Residuals below this notional are parked as pendingSettlement instead of resold. */
  RESIDUAL_SWEEP_MIN_NOTIONAL_USD: z.coerce.number().min(0).optional().default(1),
  REDEEMER_FALLBACK_STALE_TTL_S: z.coerce.number().int().min(60).optional().default(21_600),

  // LLM rate reduction caches
  SCORER_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(86400),
  CONSENSUS_CACHE_ENABLED: boolFromEnv.optional().default(true),
  CONSENSUS_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(1800),
  // Per-provider circuit breaker for consensus LLM calls. After
  // CONSENSUS_BREAKER_FAILURE_THRESHOLD failures inside CONSENSUS_BREAKER_WINDOW_S,
  // that provider is skipped for CONSENSUS_BREAKER_COOLDOWN_S. Cooldown acts as
  // the auto-retry interval: when it expires, the next estimate will probe the
  // provider again. Tops-ups / recoveries are picked up automatically.
  //
  // Defaults retuned 2026-04-15 for dead-provider (not burst-failure) regime:
  // billing-expired providers fail at ~2–3/hour, which never accumulated 5
  // failures in a 120s window under the old defaults and so never tripped. 3
  // failures in a 1h window opens the circuit on a steadily-dead provider.
  CONSENSUS_BREAKER_ENABLED: boolFromEnv.optional().default(true),
  CONSENSUS_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().optional().default(3),
  CONSENSUS_BREAKER_WINDOW_S: z.coerce.number().int().positive().optional().default(3600),
  CONSENSUS_BREAKER_COOLDOWN_S: z.coerce.number().int().positive().optional().default(600),
  RELEVANCE_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(3600),
  // Strict top-fit candidate selection: evaluate only the highest fit-score
  // candidate per headline and drop the headline if it's gated — no cascade
  // to weaker fits. Default false: shadow-log only, keep the current
  // liquidity-cascade behavior as the live path.
  STRICT_TOP_FIT_ENABLED: boolFromEnv.optional().default(false),
  // Minimum LLM fit score (0..1) for a candidate to be trade-eligible.
  // Also used by the boolean isMarketRelevant() wrapper.
  RELEVANCE_MIN_FIT_SCORE: z.coerce.number().min(0).max(1).optional().default(0.5),
  // Retrieval layer mode for OSINT → candidate-market matching.
  //   legacy        — local cache, word-boundary token match, ranked by
  //                   (matchScore desc, liquidity desc). Falls back to Gamma
  //                   `/events` on cold cache.
  //   shadow        — return legacy result synchronously, then run /public-search
  //                   in the background (fire-and-forget, 5s timeout) and log
  //                   the diff to shadow_observations (default)
  //   public_search — merge /public-search hits with local cache by id, rank by
  //                   (token_match_count desc, liquidity desc)
  // Default is shadow so we can compare candidate sets for 24–48h before flipping
  // the live path.
  MARKET_RETRIEVAL_MODE: z
    .enum(['legacy', 'shadow', 'public_search'])
    .optional()
    .default('shadow'),
  // Max candidates forwarded from the retriever to the relevance-gate reranker.
  // Raised from the historical hard-coded 10 because production RAG pipelines
  // rerank 30–100 candidates, and the prior cap was evicting correct markets
  // when sports markets dominated the liquidity-sorted top-10 for political
  // headlines (Iran "war" → Warriors substring collisions, 2026-04-15).
  RELEVANCE_CANDIDATE_CAP: z.coerce.number().int().positive().optional().default(30),
  // Per-entity result limit for /public-search. Capped at 50 by Polymarket.
  PUBLIC_SEARCH_LIMIT_PER_ENTITY: z.coerce.number().int().positive().max(50).optional().default(20),
  ENTITY_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(7200),
  SENTIMENT_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(3600),
  DEEPSEEK_PARSE_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(86400),

  // Copytrade signals
  COPYTRADE_ENABLED: boolFromEnv.optional().default(false),
  COPYTRADE_WALLETS: z.string().optional().default(''),
  // Comma-separated category list. Examples: 'all', 'weather', 'weather,geopolitics'
  COPYTRADE_MARKET_SCOPE: z
    .string()
    .optional()
    .default('all')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  COPYTRADE_SIZE_SCALE: z.coerce.number().min(0).optional().default(0.1),
  COPYTRADE_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(25),
  COPYTRADE_MAX_SLIPPAGE_BPS: z.coerce.number().min(0).optional().default(200),
  COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES: z
    .string()
    .optional()
    .default(
      '{"crypto-regulatory": 100, "mentions": 50, "macro": 150, "us-politics": 200, "geopolitical": 200, "sports": 100}',
    )
    .transform((v, ctx) => {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES must be a JSON object',
          });
          return z.NEVER;
        }
        return parsed;
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES must be valid JSON',
        });
        return z.NEVER;
      }
    })
    .pipe(z.record(z.string(), z.coerce.number().min(0).max(10000))),
  COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: z.coerce.number().min(0).optional().default(6),
  COPYTRADE_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(1000),
  // Extreme-price gate: skip entries where the outcome price is in the tails.
  // At ≤0.08 or ≥0.92, stop-loss % is dominated by spread noise and R/R is asymmetric
  // (e.g. buying NO at 0.95 = 5¢ upside vs 95¢ downside). Measured against the price
  // we'd actually pay (currentOutcomePrice), not the whale's fill.
  COPYTRADE_MIN_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.08),
  COPYTRADE_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.92),
  // Directional slippage gate: reject only ADVERSE drift vs. whale fill.
  // Symmetric COPYTRADE_MAX_SLIPPAGE_BPS treats a favorable move (better fill for us)
  // identically to an adverse move (already underwater at entry). This caps adverse
  // drift tightly while leaving favorable drift unrestricted.
  // Example: 0.08 = skip if currentOutcomePrice is >8% worse than trade.price.
  COPYTRADE_MAX_ADVERSE_DRIFT_PCT: z.coerce.number().min(0).max(1).optional().default(0.08),
  COPYTRADE_EXIT_MODE: z.enum(['mirror', 'rules']).optional().default('rules'),
  COPYTRADE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).optional().default(2000),

  // Copytrade shortlist automation
  COPYTRADE_SHORTLIST_TIME_WINDOW: z
    .enum(['DAY', 'WEEK', 'MONTH', 'ALL'])
    .optional()
    .default('WEEK'),
  COPYTRADE_SHORTLIST_TOP_N: z.coerce.number().int().min(1).max(50).optional().default(5),
  COPYTRADE_SHORTLIST_MIN_PNL_USD: z.coerce.number().min(0).optional().default(10000),
  COPYTRADE_SHORTLIST_MIN_VOL_USD: z.coerce.number().min(0).optional().default(100000),
  COPYTRADE_SHORTLIST_AUTO_APPLY: boolFromEnv.optional().default(true),
  // vol/pnl ratio filter: systematic high-frequency traders have high vol relative to PnL.
  // Default 2.0 = must have traded at least 2x their PnL in volume (filters lucky one-offs).
  // Set to 0 to disable.
  COPYTRADE_SHORTLIST_MIN_VOL_PNL_RATIO: z.coerce.number().min(0).optional().default(2),

  // Payout ratio gate: skip BUY entries where potential upside is too small.
  // payoutRatio = (1 - currentOutcomePrice) / currentOutcomePrice
  // Default 0.20 = skip if currentPrice > ~0.83 (only 20% gain headroom).
  COPYTRADE_MIN_PAYOUT_RATIO: z.coerce.number().min(0).optional().default(0.20),
  // Minimum edge magnitude: skip if market has fully repriced from whale's fill.
  // edgeMagnitude = |whale_fill_price - current_price|
  // Default 0.01 = skip if price has moved to within 1¢ of whale's fill.
  COPYTRADE_MIN_EDGE_MAGNITUDE: z.coerce.number().min(0).optional().default(0.01),

  // Mirror-exit near-resolution guard: skip whale-mirror SELLs when our side
  // of the position is already priced above this ceiling. At near-ceiling
  // prices, the bid book is thin or empty — a market sell eats heavy slippage
  // or fails, while `redeemResolvedPositions()` pays out exactly $1/share with
  // zero book interaction. Checked against `currentPrice` for YES holds and
  // `1 - currentPrice` for NO holds, so the semantic is "our claim is ≥ N¢."
  // Default 0.95 = skip mirror if our side is priced at ≥95¢.
  COPYTRADE_MIRROR_EXIT_MAX_PRICE: z.coerce.number().min(0).max(1).optional().default(0.95),

  // Wallet-quality shortlist (Phase 8 Step 1). When enabled the shortlist
  // cron re-ranks leaderboard candidates by a composite quality score derived
  // from the whale's own Polymarket trade history (trade count, avg size,
  // category concentration, round-trip Sharpe, optional WR tiebreaker) and
  // filters anything below `COPYTRADE_WALLET_MIN_SCORE`. Supersedes the old
  // Redis `copytrade:cat_stats:*` specialist gate.
  COPYTRADE_QUALITY_SHORTLIST_ENABLED: boolFromEnv.optional().default(false),
  COPYTRADE_WALLET_MAX_TRADES: z.coerce.number().int().min(1).optional().default(100),
  COPYTRADE_WALLET_MIN_AVG_SIZE_USD: z.coerce.number().min(0).optional().default(10_000),
  COPYTRADE_WALLET_MAX_AVG_SIZE_USD: z.coerce.number().min(0).optional().default(50_000),
  COPYTRADE_WALLET_MIN_CATEGORY_CONCENTRATION: z.coerce.number().min(0).max(1).optional().default(0.5),
  COPYTRADE_WALLET_MIN_SCORE: z.coerce.number().min(0).max(1).optional().default(0.5),
  COPYTRADE_QUALITY_WEIGHT_TRADE_COUNT: z.coerce.number().min(0).optional().default(0.30),
  COPYTRADE_QUALITY_WEIGHT_AVG_SIZE: z.coerce.number().min(0).optional().default(0.20),
  COPYTRADE_QUALITY_WEIGHT_CATEGORY_FOCUS: z.coerce.number().min(0).optional().default(0.30),
  COPYTRADE_QUALITY_WEIGHT_SHARPE: z.coerce.number().min(0).optional().default(0.20),
  COPYTRADE_WIN_RATE_BONUS_MULT: z.coerce.number().min(0).optional().default(1.2),
  COPYTRADE_WIN_RATE_PENALTY_MULT: z.coerce.number().min(0).optional().default(0.8),
  COPYTRADE_WIN_RATE_MIN_RESOLVED: z.coerce.number().int().min(1).optional().default(10),

  // --- NEAR-ZERO ENTRY SCANNER ---
  // Scans for markets priced 3–10¢ where LLM consensus >> market price (structural mispricing).
  // Asymmetry: 5¢ entry → 95¢ exit = 19× payout. Ship dark, shadow-log first.
  NEAR_ZERO_SCANNER_ENABLED: boolFromEnv.optional().default(false),
  NEAR_ZERO_MIN_PRICE: z.coerce.number().min(0).max(1).optional().default(0.03),
  NEAR_ZERO_MAX_PRICE: z.coerce.number().min(0).max(1).optional().default(0.10),
  // LLM consensus threshold to enter. At 3-10¢ entry, even 60% true probability
  // represents massive edge (6x-19x payout). Lower than normal-price threshold.
  NEAR_ZERO_MIN_CONSENSUS: z.coerce.number().min(0).max(1).optional().default(0.60),
  // Conservative stake cap — illiquid tail markets have wide spreads on exit.
  NEAR_ZERO_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(5),
  // Max LLM calls per run (cost control). OSINT-matched candidates first (by urgency desc),
  // then remaining candidates by price desc (higher near-zero = more likely genuine mispricing).
  NEAR_ZERO_MAX_CANDIDATES_PER_RUN: z.coerce.number().int().min(1).optional().default(5),
  NEAR_ZERO_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(500),
  // Minimum hours until resolution — avoid markets resolving before position can compound.
  NEAR_ZERO_MIN_HOURS: z.coerce.number().min(0).optional().default(24),
  // TTL for per-market dedup key after a successful OSINT-matched evaluation.
  // Shorter because a fresh OSINT headline means new info worth re-evaluating.
  NEAR_ZERO_DEDUP_TTL_S: z.coerce.number().int().min(0).optional().default(21600),
  // TTL for per-market dedup after a successful non-OSINT evaluation. Longer
  // because nothing has changed — the market is in the same efficient state.
  NEAR_ZERO_DEDUP_TTL_S_NON_OSINT: z.coerce.number().int().min(0).optional().default(86400),
  // Dead-horse filter: a real mispricing drops INTO the near-zero zone. Markets
  // that have always been cheap (long-tail championship futures, binary polls with
  // many competitors) are efficient at those prices and burn LLM budget for nothing.
  // When enabled, the scanner requires the market to have been ≥ REPRICE_MIN_PEAK at
  // some point in the last REPRICE_LOOKBACK_DAYS days. Markets with no history yet
  // are grandfathered in (first sighting). Price history is captured by the watchlist
  // refresh cron into `near_zero:price_hist:{marketId}:{direction}` ZSETs.
  NEAR_ZERO_REQUIRE_REPRICE: boolFromEnv.optional().default(true),
  NEAR_ZERO_REPRICE_LOOKBACK_DAYS: z.coerce.number().int().min(1).optional().default(7),
  NEAR_ZERO_REPRICE_MIN_PEAK: z.coerce.number().min(0).max(1).optional().default(0.15),
  // Comma-separated question substrings to skip outright (case-insensitive). Catches
  // structurally-efficient long-tail markets where LLM cannot reliably outguess the
  // crowd (a 30-team championship futures market is correctly priced at ~1/30 each).
  // Scoped to the near-zero scanner only — does NOT affect sports-arb worker, OSINT
  // entity matching, or any other path.
  NEAR_ZERO_EXCLUDE_KEYWORDS: z
    .string()
    .optional()
    .default("championship,super bowl,world series,stanley cup,nba finals,mvp,heisman,ballon d'or"),
  // Minimum edge (consensus - marketPrice) to trade. At near-zero prices, even 65%
  // consensus is massive edge — but require at least 50pp gap to filter noise.
  NEAR_ZERO_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.50),
  // Maximum LLM consensus stddev. High stddev (>0.20) means providers strongly
  // disagree — reject as noise. Shadow analysis 2026-04-16 showed ~40% of
  // otherwise-qualifying signals had stddev > 0.25.
  NEAR_ZERO_MAX_STDDEV: z.coerce.number().min(0).max(1).optional().default(0.20),
  // TTL for OSINT signal entries written by the mapping pipeline when a matched
  // market happens to be in the near-zero price range.
  NEAR_ZERO_OSINT_SIGNAL_TTL_S: z.coerce.number().int().min(0).optional().default(172800),
  // Velocity-aware dead-horse filter: minimum peak-to-current price drop as a
  // fraction of peak. Markets that have always been flat near zero are dead horses.
  // A market that peaked at 20¢ and is now 5¢ has a 75% drop — good candidate.
  NEAR_ZERO_MIN_PRICE_DROP_PCT: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Theme concentration cap: max simultaneous open near-zero-arb positions per
  // correlated theme (iran-israel, btc-price-target, etc.). Prevents the scanner
  // from building up a cluster of correlated bets that all move together.
  NEAR_ZERO_MAX_PER_THEME: z.coerce.number().int().min(1).optional().default(1),
  // Global belt-and-suspenders: max total open near-zero-arb positions regardless
  // of theme. Enforced in addition to the per-theme cap.
  NEAR_ZERO_MAX_OPEN_POSITIONS: z.coerce.number().int().min(1).optional().default(4),
  // How often the monitor worker rebuilds near_zero:theme_open:* sets from the
  // live position ledger (heals drift from missed SREM calls).
  NEAR_ZERO_THEME_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(0).optional().default(600_000),

  // --- LONGSHOT BIAS / NO-SIDE SCANNER ---
  // Exploits the favorite-longshot bias documented by Whelan (300K contracts):
  // YES contracts priced 3–15¢ are systematically overpriced due to retail optimism.
  // Buy NO (85–97¢) to bet against the bias. Category-specific optimism gaps:
  //   entertainment/media: ~5pp, sports: ~2pp, politics: ~3pp, finance/crypto: exempt.
  // Ships dark — shadow-log first, review opportunities, then enable.
  LONGSHOT_SCANNER_ENABLED: boolFromEnv.optional().default(false),
  // Minimum edge (optimism gap) to trade. Lower than OSINT because this is structural.
  LONGSHOT_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.03),
  // Maximum fraction of bankroll per longshot trade (conservative — high NO price = low payout).
  LONGSHOT_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.02),
  // YES price range that exhibits longshot bias (below 3¢ is noise, above 15¢ bias weakens).
  LONGSHOT_YES_PRICE_MIN: z.coerce.number().min(0).max(1).optional().default(0.03),
  LONGSHOT_YES_PRICE_MAX: z.coerce.number().min(0).max(1).optional().default(0.15),
  // Minimum market liquidity (USD) to ensure executable depth for NO orders.
  LONGSHOT_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(1000),
  // Dedup TTL — these markets are slower-moving than OSINT signals.
  LONGSHOT_DEDUP_TTL_S: z.coerce.number().int().min(0).optional().default(7200),
  // Maximum markets to evaluate per scan run.
  LONGSHOT_MAX_MARKETS: z.coerce.number().int().min(1).optional().default(30),
  // Comma-separated category IDs exempt from the bias (well-calibrated domains).
  LONGSHOT_EXEMPT_CATEGORIES: z.string().optional().default('crypto-regulatory,macro'),

  // --- CORRELATION ARBITRAGE SCANNER ---
  // Discovers logical constraints between markets (implication, mutual-exclusion)
  // and trades the underpriced side when constraints are violated.
  // Discovery runs every 6h; violation scan runs every 15min.
  // Ships dark — shadow-log first, review logs, then enable.
  CORRELATION_SCANNER_ENABLED: boolFromEnv.optional().default(false),
  // Minimum shared entity tokens for two markets to be paired for LLM analysis.
  CORRELATION_MIN_SHARED_ENTITIES: z.coerce.number().int().min(1).optional().default(2),
  // Maximum pairs to classify per discovery run (LLM cost control).
  CORRELATION_MAX_PAIRS_PER_DISCOVERY: z.coerce.number().int().min(1).optional().default(100),
  // Delay between LLM classification calls (ms) to avoid rate limits.
  CORRELATION_CLASSIFY_DELAY_MS: z.coerce.number().int().min(0).optional().default(200),
  // How long to keep discovered constraints in Redis before re-discovery (seconds).
  CORRELATION_GRAPH_TTL_S: z.coerce.number().int().positive().optional().default(7 * 24 * 3600),
  // Pair-seen dedup TTL — prevents re-classifying the same pair within one discovery cycle.
  CORRELATION_PAIR_DEDUP_TTL_S: z.coerce.number().int().positive().optional().default(86400),
  // LLM classification result cache TTL (seconds).
  CORRELATION_CLASSIFY_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(172800),
  // Minimum constraint violation edge to trigger a trade signal.
  CORRELATION_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Minimum market liquidity (USD) for markets included in the graph.
  CORRELATION_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(1000),
  // Dedup TTL for executed trades — prevents re-entry on the same violation.
  CORRELATION_DEDUP_TTL_S: z.coerce.number().int().positive().optional().default(3600),
  // Maximum trades per scanner run.
  CORRELATION_MAX_TRADES_PER_RUN: z.coerce.number().int().min(1).optional().default(3),
  // Maximum USD stake per correlation-arb trade.
  CORRELATION_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(10),
  // Bankroll fraction for correlation-arb trades.
  CORRELATION_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.02),
  // Maximum markets to consider in the discovery pairing step (liquidity-ranked).
  CORRELATION_MAX_MARKETS_FOR_DISCOVERY: z.coerce.number().int().min(1).optional().default(500),

  // --- REBATE FARMING (passive maker liquidity provision) ---
  // Places resting GTC post-only limit orders on high-volume tight-spread markets
  // to earn maker rebates (Polymarket distributes 100% of taker fees to makers).
  // Filled orders become positions tracked by the monitor with tight TP/SL.
  REBATE_FARMING_ENABLED: boolFromEnv.optional().default(false),
  // Maximum fraction of bankroll deployed to resting rebate orders.
  REBATE_MAX_BANKROLL_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Hard cap on total USD in resting rebate orders.
  REBATE_MAX_TOTAL_USD: z.coerce.number().min(0).optional().default(50),
  // USD per individual resting order.
  REBATE_ORDER_SIZE_USD: z.coerce.number().min(1).optional().default(5),
  // Maximum number of markets to have resting orders on simultaneously.
  REBATE_MAX_MARKETS: z.coerce.number().int().min(1).optional().default(10),
  // Maximum USD exposure per market (prevents doubling up).
  REBATE_MAX_PER_MARKET_USD: z.coerce.number().min(1).optional().default(10),
  // TTL for resting orders before cancel + refresh at new prices (seconds).
  REBATE_ORDER_TTL_S: z.coerce.number().int().min(60).optional().default(300),
  // Minimum spread in basis points — below this, no room to profitably rest as maker.
  REBATE_MIN_SPREAD_BPS: z.coerce.number().min(0).optional().default(50),
  // Minimum 24h volume (USD) for market selection.
  REBATE_MIN_VOLUME: z.coerce.number().min(0).optional().default(50_000),
  // Minimum liquidity (USD) for market selection.
  REBATE_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(10_000),
  // Skip fee-enabled markets (rebate economics differ on fee markets).
  REBATE_SKIP_FEE_MARKETS: boolFromEnv.optional().default(true),
  // Take-profit threshold for rebate-farmed positions (lower than directional trades).
  REBATE_TAKE_PROFIT_PCT: z.coerce.number().min(0).optional().default(3),
  // Stop-loss threshold for rebate-farmed positions (tight since no directional conviction).
  REBATE_STOP_LOSS_PCT: z.coerce.number().min(0).optional().default(5),

  // --- CRYPTO FUTURES (Phase: futures) ---
  FUTURES_ENABLED: boolFromEnv.optional().default(false),
  // When true: log HL orders instead of submitting them. Safe validation path.
  HL_DRY_RUN: boolFromEnv.optional().default(false),
  // Hyperliquid credentials
  HYPERLIQUID_PRIVATE_KEY: z.string().optional(),
  HYPERLIQUID_AGENT_WALLET: z.string().optional(),
  HYPERLIQUID_MAIN_WALLET: z.string().optional(),
  HYPERLIQUID_TESTNET: boolFromEnv.optional().default(false),

  // Risk & Control
  FUTURES_GLOBAL_MAX_MARGIN_USD: z.coerce.number().min(0).optional().default(200),
  FUTURES_MAX_PER_TRADE_USD: z.coerce.number().min(0).optional().default(10),
  FUTURES_DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(50).optional().default(5),
  FUTURES_MAX_HOLD_HOURS: z.coerce.number().int().min(1).optional().default(4),
  // When true, suppress the time-based max-hold exit on positions that are
  // winning AND still trend-aligned: trailing stop armed (HWM crossed TP) AND
  // TA confluence does not signal a reversal. Zombies (trailing not armed)
  // still exit at MAX_HOLD_HOURS. Protects runners without sacrificing the
  // zombie-cleanup purpose of the time cap.
  FUTURES_MAX_HOLD_BYPASS_ON_WINNER: boolFromEnv.optional().default(false),
  // Minimum urgency score (1-10) for news items to trigger a futures signal.
  // Lowered from 8 to 6 to increase signal frequency; combined with stake scaling.
  FUTURES_URGENCY_THRESHOLD: z.coerce.number().int().min(1).max(10).optional().default(6),
  // Notional-based SL/TP thresholds (percentage of margin used, NOT account equity).
  // At 5x leverage a 1.5% notional SL represents a 7.5% equity drawdown.
  // Use values relative to notional, not leverage-adjusted equity.
  FUTURES_STOP_LOSS_PCT: z.coerce
    .number()
    .max(-0.01, 'FUTURES_STOP_LOSS_PCT must be negative')
    .default(-1.5),
  FUTURES_TAKE_PROFIT_PCT: z.coerce
    .number()
    .min(0.01, 'FUTURES_TAKE_PROFIT_PCT must be positive')
    .default(3.0),
  // Trailing stop — activates after position reaches ACTIVATION_PCT, then exits if it drops TRAILING_STOP_PCT from peak.
  FUTURES_TRAILING_STOP_ENABLED: boolFromEnv.optional().default(true),
  FUTURES_TRAILING_STOP_PCT: z.coerce.number().min(0.1).optional().default(1.5),
  FUTURES_EXIT_ON_SIGNAL_FADE: boolFromEnv.optional().default(true),
  // TA confluence gate for futures entries — requires RSI/MACD/Stochastic agreement before opening a position.
  FUTURES_CONFLUENCE_GATE_ENABLED: boolFromEnv.optional().default(true),
  FUTURES_MIN_CONFLUENCE_SCORE: z.coerce.number().int().min(0).max(7).optional().default(2),
  // Minimum absolute spot move (%) to open a futures position. Prevents z-score-only triggers
  // from entering on noise-level wiggles (e.g. 0.05%) that have no directional edge.
  FUTURES_MIN_SPOT_MOVE_PCT: z.coerce.number().min(0).optional().default(0.3),
  // Exit requires stronger reversal evidence than entry — prevents symmetric whipsaw.
  // Default 5 means 5/7 indicators must agree on the opposite direction before exiting.
  FUTURES_EXIT_CONFLUENCE_SCORE: z.coerce.number().int().min(0).max(7).optional().default(5),
  // Post-entry TA re-evaluation interval & minimum position age before re-eval kicks in.
  FUTURES_REEVAL_INTERVAL_S: z.coerce.number().int().min(10).optional().default(60),
  FUTURES_REEVAL_MIN_AGE_S: z.coerce.number().int().min(0).optional().default(600),
  // Max slippage fraction for IoC market orders (e.g. 0.02 = 2%). Conservative default.
  FUTURES_IOC_SLIPPAGE: z.coerce.number().min(0.001).max(0.1).optional().default(0.02),

  // Volatility-adjusted position sizing (Strategy 3)
  FUTURES_VOL_SIZING_ENABLED: boolFromEnv.optional().default(false),
  FUTURES_ATR_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  FUTURES_ATR_BASELINE_PCT: z.coerce.number().min(0.01).optional().default(0.5),

  // ── Phase 1: Kline feed (real OHLCV from Binance) ──
  // Comma-separated list of timeframes to subscribe to. '1m' is required.
  BINANCE_KLINE_TIMEFRAMES: z.string().optional().default('1m,5m'),
  KLINE_RETENTION_1M: z.coerce.number().int().min(10).optional().default(240),
  KLINE_RETENTION_5M: z.coerce.number().int().min(10).optional().default(288),

  // ── Phase 1: ATR-based dynamic SL/TP (default off — ship-then-flip) ──
  FUTURES_ATR_SLTP_ENABLED: boolFromEnv.optional().default(false),
  FUTURES_ATR_SL_MULT: z.coerce.number().min(0.1).optional().default(1.5),
  FUTURES_ATR_TP_MULT: z.coerce.number().min(0.1).optional().default(3.0),
  FUTURES_ATR_SL_MIN_PCT: z.coerce.number().min(0).optional().default(1.0),
  FUTURES_ATR_SL_MAX_PCT: z.coerce.number().min(0).optional().default(5.0),
  FUTURES_ATR_TP_MIN_PCT: z.coerce.number().min(0).optional().default(2.0),
  FUTURES_ATR_TP_MAX_PCT: z.coerce.number().min(0).optional().default(10.0),
  FUTURES_ATR_TRAIL_ACT_MULT: z.coerce.number().min(0.1).optional().default(2.0),
  FUTURES_ATR_TRAIL_STOP_MULT: z.coerce.number().min(0.1).optional().default(1.0),

  // ── Phase 1: Z-score spot momentum trigger ──
  SPOT_TRIGGER_MODE: z.enum(['pct', 'zscore', 'both', 'or']).optional().default('pct'),
  SPOT_ZSCORE_THRESHOLD: z.coerce.number().min(0).optional().default(2.5),
  SPOT_ZSCORE_LOOKBACK_MIN: z.coerce.number().int().min(10).optional().default(60),

  // ── Phase 2: Volume-aware confluence (default off — ship-then-flip) ──
  // Hard volume-spike gate before futures entry (current vol must exceed SMA × MULT).
  VOLUME_SPIKE_GATE_ENABLED: boolFromEnv.optional().default(false),
  VOLUME_SPIKE_PERIOD: z.coerce.number().int().min(2).optional().default(20),
  VOLUME_SPIKE_MULT: z.coerce.number().min(0.1).optional().default(2.0),
  // OBV slope voter
  OBV_SLOPE_LOOKBACK: z.coerce.number().int().min(2).optional().default(10),
  OBV_SLOPE_EPS: z.coerce.number().min(0).optional().default(0),
  // MFI voter
  MFI_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  MFI_OVERSOLD: z.coerce.number().min(0).max(100).optional().default(20),
  MFI_OVERBOUGHT: z.coerce.number().min(0).max(100).optional().default(80),
  // VWAP voter
  VWAP_LOOKBACK_MIN: z.coerce.number().int().min(2).optional().default(60),
  VWAP_BAND: z.coerce.number().min(0).optional().default(0.001),
  // CMF voter
  CMF_PERIOD: z.coerce.number().int().min(2).optional().default(20),
  CMF_THRESHOLD: z.coerce.number().min(0).optional().default(0.05),

  // ── Phase 3: Regime gates (default off — ship-then-flip) ──
  ADX_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  ADX_MIN: z.coerce.number().min(0).optional().default(20),
  ADX_GATE_ENABLED: boolFromEnv.optional().default(false),

  CHOPPINESS_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  CHOPPINESS_MAX: z.coerce.number().min(0).optional().default(61.8),
  CHOPPINESS_GATE_ENABLED: boolFromEnv.optional().default(false),

  BB_PERIOD: z.coerce.number().int().min(2).optional().default(20),
  BB_SIGMA: z.coerce.number().min(0.1).optional().default(2),
  // Bandwidth thresholds for calm/normal/explosive regime classification.
  BB_CALM_BANDWIDTH: z.coerce.number().min(0).optional().default(0.01),
  BB_EXPLOSIVE_BANDWIDTH: z.coerce.number().min(0).optional().default(0.05),
  BB_REGIME_ADAPT_ENABLED: boolFromEnv.optional().default(false),
  FUTURES_MIN_CONFLUENCE_SCORE_CALM: z.coerce.number().int().min(0).max(7).optional().default(3),
  FUTURES_MIN_CONFLUENCE_SCORE_NORMAL: z.coerce.number().int().min(0).max(7).optional().default(3),
  FUTURES_MIN_CONFLUENCE_SCORE_EXPLOSIVE: z.coerce.number().int().min(0).max(7).optional().default(4),

  // ── Phase 3: Sports arb (NBA + NHL) ──
  SPORTS_ARB_ENABLED: boolFromEnv.optional().default(true),
  SPORTS_LEAGUES: z
    .string()
    .optional()
    .default('nba')
    .transform((v) =>
      new Set(
        v
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s): s is 'nba' | 'nhl' => s === 'nba' || s === 'nhl'),
      ),
    ),
  SPORTS_POLL_INTERVAL_S: z.coerce.number().int().min(1).optional().default(8),
  SPORTS_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  SPORTS_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(5),
  SPORTS_MARKET_LOOKAHEAD_H: z.coerce.number().int().min(1).optional().default(48),
  // Purely informational — documents which TELEGRAM_CHANNELS entries are
  // sports-primary. Not used by runtime; channels are added directly to
  // TELEGRAM_CHANNELS and auto-classified by the category classifier.
  SPORTS_TELEGRAM_HANDLES: z.string().optional().default(''),

  // ── Epic #142 — Durable analytics + retrieval layer ─────────────
  // Postgres connection. Optional until #147 cutover; the writer is the
  // only consumer today and fails loud at startup if PG_URL is unset.
  PG_URL: z.string().optional(),
  // Writer batch / poll tuning. Defaults are conservative for the CAX11.
  DB_WRITER_BATCH_SIZE: z.coerce.number().int().min(1).max(2000).optional().default(200),
  DB_WRITER_POLL_MS: z.coerce.number().int().min(50).max(10_000).optional().default(500),
  DB_WRITER_BLOCK_MS: z.coerce.number().int().min(100).max(30_000).optional().default(2_000),
  DB_WRITER_MAX_RETRIES: z.coerce.number().int().min(0).max(50).optional().default(5),
  DB_WRITER_LOCK_TTL_SEC: z.coerce.number().int().min(30).max(600).optional().default(120),
  // Stream / consumer-group identifiers. Stream name is intentionally short
  // and not version-suffixed — Phase 2 schema changes don't change the stream.
  DB_STREAM_KEY: z.string().optional().default('db:writeq'),
  DB_STREAM_GROUP: z.string().optional().default('pga-db-writer'),
  DB_STREAM_CONSUMER: z.string().optional().default('writer-1'),
  DB_STREAM_MAXLEN: z.coerce.number().int().min(1000).optional().default(200_000),
  // Phase 1 canary cadence — writer self-emits a health_pings row every N seconds.
  DB_HEALTH_PING_INTERVAL_MS: z.coerce.number().int().min(1000).max(300_000).optional().default(30_000),
  // Phase 5: semantic memory retrieval — prepend similar past trade cases to LLM prompt.
  // Requires PG_URL and OPENAI_API_KEY. Adds one embeddings call per consensus estimate.
  MEMORY_RETRIEVAL_ENABLED: boolFromEnv.optional().default(false),
  MEMORY_RETRIEVAL_LIMIT: z.coerce.number().int().min(1).max(10).optional().default(3),

  // --- WEATHER MARKET SCANNER ---
  // Compares NOAA (US) + Open-Meteo (global) forecasts against Polymarket
  // negRisk bracket weather markets. Markets are "highest temperature in [city]"
  // events with ~11 brackets each (e.g. "40-41°F", "42-43°F", ...).
  // Ships dark (WEATHER_SCANNER_ENABLED=false). Shadow-log first, review, then enable.
  WEATHER_SCANNER_ENABLED: boolFromEnv.optional().default(false),
  // Minimum edge (model probability - market bid price) to consider a trade.
  // Compares modelProb vs yesPrice for YES, (1-modelProb) vs noPrice for NO.
  // Higher than binary markets because bracket model uncertainty is larger (8-10¢ recommended).
  WEATHER_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  // Maximum bankroll fraction per weather trade — conservative because forecast
  // uncertainty grows with horizon and model error is correlated across brackets.
  WEATHER_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.02),
  // Dedup TTL — one evaluation per event per scan cycle. 4h between re-evaluations
  // to allow for forecast updates.
  WEATHER_DEDUP_TTL_S: z.coerce.number().int().min(1).optional().default(14400),
  // Maximum weather events (not individual brackets) to evaluate per scan cycle.
  WEATHER_MAX_EVENTS: z.coerce.number().int().min(1).optional().default(50),
  // Maximum forecast horizon in days — skip events further out (too uncertain).
  WEATHER_MAX_HORIZON_DAYS: z.coerce.number().int().min(1).optional().default(7),
  // Multiplier applied to forecastStdDev before bracket-probability calc. 1.0 is no-op.
  // Set >1 to widen the model's distribution (lower central-bracket confidence, raise
  // adjacent brackets) when calibration analysis shows modelProb is too tight to forecast
  // point. Set <1 to tighten. Adjusted stddev is what enters estimateBracketProbability;
  // raw forecastStdDev is still logged on the shadow row for comparison.
  WEATHER_STDDEV_MULTIPLIER: z.coerce.number().min(0.1).max(5).optional().default(1.0),
  // --- WEATHER GROUND-TRUTH RECONCILER ---
  // Fills `weather_ground_truth` with observed daily highs for past events, so
  // shadow-scan predictions in `shadow_observations` can be validated against
  // reality. Read-only with respect to trading — always safe to run.
  // Days after target_date to wait before querying the archive. 1 = wait a full
  // UTC day so the archive has the reading. Bump higher if gaps appear.
  WEATHER_RECONCILER_LAG_DAYS: z.coerce.number().int().min(1).optional().default(1),
  // How far back to scan shadow_observations for unresolved events each run.
  // Keeps the query bounded; 30 days is comfortably longer than the daily cron.
  WEATHER_RECONCILER_LOOKBACK_DAYS: z.coerce.number().int().min(1).optional().default(30),
  // Cap archive API calls per run to stay within Open-Meteo fair-use limits.
  WEATHER_RECONCILER_MAX_PER_RUN: z.coerce.number().int().min(1).optional().default(50),
});

export type AppConfig = z.infer<typeof envSchema>;

let _config: AppConfig | null = null;

export function loadConfig(forceReload = false): AppConfig {
  if (_config && !forceReload) return _config;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.errors
      .map((e: z.ZodIssue) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  const cfg = parsed.data;

  // At least one LLM provider must be configured
  if (
    !cfg.OPENAI_API_KEY &&
    !cfg.GEMINI_API_KEY &&
    !cfg.ANTHROPIC_API_KEY &&
    !cfg.DEEPSEEK_API_KEY
  ) {
    throw new Error(
      'At least one LLM API key must be set (OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY)',
    );
  }

  _config = cfg;

  // Cross-validate CLOB-related config.
  // Only enforce wallet-key requirement when CLOB_FALLBACK_ENABLED is explicitly
  // set to true in the environment — the default=true must not block users who
  // have not configured CLOB at all.
  const clobExplicitlyEnabled =
    cfg.CLOB_FALLBACK_ENABLED && process.env.CLOB_FALLBACK_ENABLED !== undefined;
  if (clobExplicitlyEnabled) {
    if (!cfg.POLYGON_WALLET_PRIVATE_KEY) {
      throw new Error('POLYGON_WALLET_PRIVATE_KEY is required when CLOB_FALLBACK_ENABLED=true');
    }
    if (
      (cfg.POLYMARKET_SIGNATURE_TYPE === 1 || cfg.POLYMARKET_SIGNATURE_TYPE === 2) &&
      !cfg.POLYMARKET_FUNDER_ADDRESS
    ) {
      throw new Error(
        'POLYMARKET_FUNDER_ADDRESS is required when POLYMARKET_SIGNATURE_TYPE is 1 (proxy) or 2 (gnosis safe)',
      );
    }
  }

  // Futures: Cross-validate credentials if enabled
  if (cfg.FUTURES_ENABLED) {
    if (!cfg.HYPERLIQUID_PRIVATE_KEY) {
      throw new Error('HYPERLIQUID_PRIVATE_KEY is required when FUTURES_ENABLED=true');
    }
  }

  // Phase 9: Cross-validate MACD periods
  if (cfg.MACD_FAST >= cfg.MACD_SLOW) {
    throw new Error('MACD_FAST must be less than MACD_SLOW');
  }

  return _config;
}
