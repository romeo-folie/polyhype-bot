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
/** USDC.e (bridged USDC) on Polygon mainnet — legacy pre-V2 collateral/approval token, retained for reference/compatibility. */
export const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/** pUSD (Polymarket USD) on Polygon mainnet — V2 collateral token replacing USDC.e. Backed 1:1 by USDC. */
export const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
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

export const envSchema = z.object({
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),

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
  // Gate for RSS-based batch ingestion (LLM scoring every 5 min).
  // Set false to skip runIngestion() entirely; Telegram path is unaffected.
  OSINT_RSS_INGESTION_ENABLED: boolFromEnv.optional().default(false),
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
  // Global ceiling on any non-futures entry price (outcomePrice). Applied in the executor
  // before any order is placed. Set to 0 to disable. Two sources override this with their
  // own cap: fv-scanner uses FV_MAX_ENTRY_PRICE; weather uses WEATHER_MAX_ENTRY_PRICE.
  // All other sources (oracle-lag, sports, copytrade, etc.) use this value directly.
  MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.55),
  // YYYY-MM-DD. When set, new entries into markets resolving on/after this date are blocked.
  // Use before an API migration cutover to avoid accumulating positions that need post-cutover management.
  API_MIGRATION_CUTOVER_DATE: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'API_MIGRATION_CUTOVER_DATE must be YYYY-MM-DD')
    .refine(
      (v: string) => {
        const date = new Date(`${v}T00:00:00Z`);
        return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === v;
      },
      { message: 'API_MIGRATION_CUTOVER_DATE must be a valid calendar date in YYYY-MM-DD format' }
    )
    .optional(),

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
  // Comma-separated list of categories the OSINT pipeline is allowed to trade.
  // Dedicated scanners (weather, oracle-lag, sports, crypto-arb) own their own paths.
  // Empty string disables the gate (all categories allowed).
  OSINT_ALLOWED_CATEGORIES: z
    .string()
    .optional()
    .default('geopolitical,macro,ai-tech,us-politics')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
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
    .default('oracle-lag,near-zero-arb,fv-scanner')
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
  // When false, skips TP, SL, and divergence-closed evaluation for all PM positions.
  // Near-res gate (0.95 → redeemer), copytrade mirror exits, and stale/trend exits are unaffected.
  // Hyperliquid futures use a separate evaluator and are never affected by this flag.
  POLYMARKET_TP_SL_ENABLED: boolFromEnv.optional().default(true),
  // Trailing stop for PM positions — activation is TAKE_PROFIT_THRESHOLD (not a new knob).
  TRAILING_STOP_ENABLED: boolFromEnv.optional().default(false),
  TRAILING_GIVEBACK_PCT: z.coerce.number().min(0).optional().default(10),
  TRAILING_MIN_EXIT_BID: z.coerce.number().min(0).max(1).optional().default(0.05),
  // When the held outcome's price reaches this level, the market is near settlement.
  // The monitor routes to the redeemer (pendingSettlement) instead of executing a
  // CLOB exit, preventing the trailing-stop peak from being poisoned by a
  // resolution-spike price and then firing when the WS cache TTL expires and stale
  // CLOB prices are returned (burned 2026-04-24: Feldbausch/Tabur NO exit at -6.5%
  // instead of redemption at +59%).
  MONITOR_NEAR_RES_PRICE_THRESHOLD: z.coerce.number().min(0.5).max(1).optional().default(0.95),
  // Seconds the price must continuously stay ≥ MONITOR_NEAR_RES_PRICE_THRESHOLD before
  // pendingSettlement is marked. Prevents thin-book spikes from permanently locking a position.
  // 0 = fire immediately (original behaviour).
  MONITOR_NEAR_RES_PERSIST_S: z.coerce.number().min(0).optional().default(60),
  // For weather positions only: minimum hours remaining until the market's endDate before
  // the near-res gate is allowed to fire. A May 31 market cannot be near-settlement at
  // 08:49 on May 30. 0 = no time gate. Non-weather markets are unaffected.
  MONITOR_NEAR_RES_MIN_HOURS_TO_RES: z.coerce.number().min(0).optional().default(6),
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
  // Live perp entries from spot-move detection. When false the path still evaluates
  // every candidate and writes a shadow_observations row (kind=spot_futures_signal)
  // for what it would have traded — measured Apr–Jun 2026 at 30% WR / −$1.50 gross,
  // it chases the direction of an already-completed spike. Correlated PM-market
  // signals from the same move are unaffected.
  SPOT_FUTURES_ENABLED: boolFromEnv.optional().default(true),
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

  // When true, the ChainlinkFeed (owned by the arb worker) republishes every
  // tick to Redis: SET oracle:last:<symbol> EX 120, ZADD oracle:prices:<symbol>
  // (capped at 600), PUBLISH oracle:price_moved. Lets other workers act on
  // Chainlink ticks without holding their own WS. Off = pure in-process mode
  // (the historical default before the HL momentum work).
  CHAINLINK_REDIS_PUBLISH_ENABLED: boolFromEnv.optional().default(true),

  // Oracle-Lag Scanner (BTC + ETH Up/Down 15m, Chainlink oracle-lag sniper).
  // Ships dark — enable live trading per asset only after shadow-log review
  // (ORACLE_LAG_ENABLED for BTC, ORACLE_LAG_ETH_ENABLED for ETH).
  ORACLE_LAG_ENABLED: boolFromEnv.optional().default(false),
  // Comma-separated assets to shadow-scan. Both BTC and ETH are wired; per-asset
  // live flags (ORACLE_LAG_ENABLED for BTC, ORACLE_LAG_ETH_ENABLED for ETH)
  // control whether trades actually fire.
  ORACLE_LAG_ASSETS: z.string().optional().default('bitcoin,ethereum'),
  // ETH oracle-lag live flag. Ships dark — shadow logs run, no trades fire until
  // flipped. Only meaningful when 'ethereum' is in ORACLE_LAG_ASSETS.
  ORACLE_LAG_ETH_ENABLED: boolFromEnv.optional().default(false),
  // Minimum Chainlink move % over the lookback window to consider entry, shared across all assets (0.07 = 7 bps).
  ORACLE_LAG_MIN_MOVE_PCT: z.coerce.number().min(0).optional().default(0.07),
  // Lookback window in seconds for the Chainlink move computation.
  ORACLE_LAG_MOVE_WINDOW_SEC: z.coerce.number().int().min(1).optional().default(5),
  // Skip entry if time to market resolution is below this many minutes.
  ORACLE_LAG_MIN_TIME_LEFT_MIN: z.coerce.number().min(0).optional().default(5),
  // Skip entry if time to market resolution exceeds this many minutes. Use to restrict entries
  // to the final window where oracle lag still dominates before the market reprices. Default of
  // 999 is effectively unbounded for short-duration (15m) oracle-lag markets and preserves
  // existing BTC behaviour, but is a finite cap — not a true Infinity.
  ORACLE_LAG_MAX_TIME_LEFT_MIN: z.coerce.number().min(0).optional().default(999),
  // Skip entry if market price on the signal side exceeds this (fee math breaks above ~0.62).
  ORACLE_LAG_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.62),
  // Skip entry if market price on the signal side is below this floor. Guards against buying
  // the cheap side of an already-decided / highly-skewed market (e.g. NO at 0.08 when YES is
  // at 0.92). In that state the lag thesis and midpoint maker-post assumptions no longer apply.
  // Symmetric partner to ORACLE_LAG_MAX_ENTRY_PRICE. Must remain strictly below the max.
  ORACLE_LAG_MIN_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.35),
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

  // When an oracle-lag empty-book maker post is rejected (post-only crossing)
  // the REST book snapshot was stale — a seller arrived in the ~100-200ms
  // submission window. Re-fetch the book and retry once at a freshly-capped
  // fair value. Keeps the post-only safety shield intact (no taker fallback)
  // while catching the common "book transitioned from empty to thin" failure
  // mode that 2026-04-17 telemetry showed accounts for 5/11 maker attempts.
  // Scoped to oracle-lag only; OSINT markets have deeper books and far more
  // adverse-fill risk, so adding retries there requires its own analysis.
  ORACLE_LAG_MAKER_RETRY_ON_REJECT: boolFromEnv.optional().default(true),
  // Caps maker wait for oracle-lag inside tryExecuteViaClobMaker. Only reachable
  // for oracle-lag via the empty-book GTC path (MAKER_EMPTY_BOOK_ALLOWED_SOURCES),
  // since real books now route oracle-lag to taker. Must be < MAKER_MAX_WAIT_MS (45s).
  ORACLE_LAG_REAL_BOOK_MAKER_MAX_WAIT_MS: z.coerce.number().int().min(0).optional().default(8_000),

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
  // Only exit via reversal if PM return on the held side >= this (%). 0 = break-even gate:
  // if PM hasn't repriced at all, holding to resolution beats selling into the spread.
  ORACLE_LAG_EXIT_REVERSAL_MIN_RETURN_PCT: z.coerce.number().min(0).optional().default(0),
  // Hard timeout — drop the position after this many seconds regardless of
  // compression progress, since the convergence window is ~55s. ageSec is
  // computed from position.openedAt (the ledger record/import timestamp),
  // NOT state.entryTsMs (scanner-fire time) — so maker-pending fills that
  // only appear in the ledger 3–5 min after the scanner writes the state
  // get a full `maxHoldSec` window from record-time instead of firing
  // immediately on first visibility.
  // Default raised 180 → 300s (2026-04-23) to cushion against borderline
  // cases where the position barely exceeded the old cap on first visibility;
  // 300 gives 5 minutes of runtime for compression/reversal to act after
  // the ledger openedAt / record timestamp.
  // Upper-bounded at 1500s to stay safely inside the 30-minute exit-state
  // Redis TTL (see EXIT_STATE_TTL_SEC in oracleLagExitMonitor.ts) — otherwise
  // the key could expire before the timeout trigger fires.
  ORACLE_LAG_EXIT_MAX_HOLD_SEC: z.coerce.number().int().min(30).max(1500).optional().default(300),
  // Exit-monitor tick cadence.
  ORACLE_LAG_EXIT_TICK_MS: z.coerce.number().int().min(500).optional().default(2000),
  // Near-resolution profit lock: exit when profitable with < N minutes left
  // before market resolution, avoiding last-minute reversals (e.g. Apr-21 ETH
  // pump). Must be below ORACLE_LAG_MIN_TIME_LEFT_MIN so fresh entries aren't
  // immediately exited.
  ORACLE_LAG_EXIT_NEAR_RES_MIN_LEFT_MIN: z.coerce.number().min(0).optional().default(3),
  // Minimum return (%) on the held token before the near-resolution trigger
  // fires. Prevents exiting positions barely above the entry price.
  ORACLE_LAG_EXIT_NEAR_RES_MIN_RETURN_PCT: z.coerce.number().min(0).optional().default(0.5),
  // Exit immediately if PM return on held side drops below -X%. Fires at highest
  // priority — before reversal, near-resolution, and timeout. Limits losses when
  // Chainlink reverses and PM has already repriced hard against us.
  ORACLE_LAG_EXIT_SL_PCT: z.coerce.number().min(0).max(100).optional().default(20),

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
  // When true, sports-copytrade positions disable TP + trailing and hold to
  // resolution.  Binary sports markets resolve at 0 or 1; intermediate prices
  // are in-play noise (a single break of serve can move ±13% in one tick).
  // SL (COPYTRADE_SPORTS_STOP_LOSS) handles downside; the near-res gate
  // (MONITOR_NEAR_RES_PRICE_THRESHOLD, default 0.95) handles winning redemption.
  // Mirrors the FV-scanner hold-to-res pattern.
  COPYTRADE_SPORTS_HOLD_TO_RES: boolFromEnv.optional().default(true),
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
  // Weather brackets resolve in ≤24h; a long stale window would dump most positions
  // before resolution. 6h keeps the exit quick enough to catch decayed entries but
  // past the first few forecast-refresh ticks.
  STALE_MIN_AGE_H_WEATHER: z.coerce.number().min(1).optional().default(6),
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
  CALIBRATION_MIN_BUCKET_SAMPLES: z.coerce.number().int().positive().optional().default(10),
  OUTCOME_HISTORY_DAYS: z.coerce.number().int().positive().optional().default(180),
  OUTCOME_MAX_PER_CATEGORY: z.coerce.number().int().positive().optional().default(500),
  CONTEXT_INJECTION_ENABLED: boolFromEnv.optional().default(true),
  CONTEXT_INJECTION_LIMIT: z.coerce.number().int().min(1).max(10).optional().default(5),

  // Multi-signal conviction multiplier
  CONVICTION_MULTIPLIER_ENABLED: boolFromEnv.optional().default(false),
  CONVICTION_BONUS_PER_SOURCE: z.coerce.number().min(0).max(1).optional().default(0.25),
  CONVICTION_MAX_MULTIPLIER: z.coerce.number().min(1).max(3).optional().default(1.5),
  CONVICTION_SIGNAL_TTL_S: z.coerce.number().int().positive().optional().default(1800),

  // Position size-up (pyramid) — add to an existing open position when fresh edge still exists.
  SIZE_UP_ENABLED: boolFromEnv.optional().default(false),
  // Shadow mode: when true (and SIZE_UP_ENABLED is false), the weather scanner still
  // emits a size-up evaluation for held resolution-day positions, but evaluateSizeUp
  // returns feature_disabled so NOTHING executes — it only writes `would_size_up`
  // shadow rows (would-fire + conviction-gate blocks) for calibration. Without this
  // the scanner skips held events entirely when SIZE_UP_ENABLED is false, so no shadow
  // data is produced. Ignored when SIZE_UP_ENABLED is true (already evaluating live).
  SIZE_UP_SHADOW_ENABLED: boolFromEnv.optional().default(false),
  // Comma-separated signal sources eligible for position size-up.
  SIZE_UP_ELIGIBLE_SOURCES: z.string().optional().default('weather'),
  // Maximum number of size-up top-ups allowed per open position.
  SIZE_UP_MAX_TOPUPS: z.coerce.number().int().min(1).optional().default(1),
  // Minimum edge required for a size-up (defaults to 0 = use source edge floor).
  SIZE_UP_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0),
  // Max allowed drift between original entry price and current price for a size-up (0 = disabled).
  SIZE_UP_MAX_ENTRY_DRIFT: z.coerce.number().min(0).max(1).optional().default(0),
  // Size-up headroom: bankroll fraction cap for the TOTAL position after top-ups.
  // Entries are Kelly-sized up to WEATHER_MAX_STAKE_FRACTION, so a max-size entry
  // leaves zero top-up room under the same cap by construction. A larger size-up
  // fraction gives thesis-confirmed positions their own room to grow while staying
  // risk-proportional to current bankroll (shrinks automatically in drawdowns).
  // 0 = legacy behavior (reuse WEATHER_MAX_STAKE_FRACTION).
  SIZE_UP_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0),
  // Hard USD ceiling on the total position after top-ups (applied after the
  // fraction cap, mirroring WEATHER_MAX_STAKE_USD). Without this, the larger
  // size-up fraction is re-strangled by WEATHER_MAX_STAKE_USD at high bankroll.
  // 0 = legacy behavior (reuse WEATHER_MAX_STAKE_USD).
  SIZE_UP_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(0),
  // Minimum RISE in the model's held-side probability since entry required to size
  // up. Encodes "add only on extra model conviction": a top-up fires only when the
  // (resolution-day) forecast has firmed in our favour relative to the entry
  // estimate — not merely because the market price moved. The entry estimate is the
  // position's stored consensusProbability; the current estimate is the size-up
  // signal's. Fails closed (no top-up) when the entry baseline is missing/degenerate
  // (healed/orphan rows). 0 = disabled.
  SIZE_UP_MIN_CONFIDENCE_RISE: z.coerce.number().min(0).max(1).optional().default(0),
  // Max the current price may sit BELOW the original entry price before a size-up is
  // refused. Blocks averaging DOWN into a position the market has moved against — the
  // "it got cheaper, add more" tilt. Pairs with SIZE_UP_MAX_ENTRY_DRIFT (the upper
  // bound) to form a two-sided confirming-drift band. 0 = disabled.
  SIZE_UP_MAX_ADVERSE_DRIFT: z.coerce.number().min(0).max(1).optional().default(0),
  // When true, a size-up requires a two-sided (real) book and never posts above the
  // side mid. Refuses to ADD into a one-sided ghost book at a discounted-fair-value
  // price the thin quote won't honour (the empty-book adverse-fill case observed
  // 2026-06-05). Fresh entries are unaffected.
  SIZE_UP_REQUIRE_REAL_BOOK: boolFromEnv.optional().default(true),

  // OSINT sibling fan-out
  OSINT_SIBLING_FANOUT_ENABLED: boolFromEnv.optional().default(false),
  OSINT_SIBLING_MIN_FIT_SCORE: z.coerce.number().min(0).max(1).optional().default(0.6),
  OSINT_SIBLING_MAX_PER_EVENT: z.coerce.number().int().min(1).max(10).optional().default(3),

  // Redeemer guardrails
  REDEEMER_DUPLICATE_WINDOW_S: z.coerce
    .number()
    .int()
    .min(60)
    .optional()
    .default(30 * 24 * 3600),
  REDEEMER_DUST_THRESHOLD_USDC: z.coerce.number().min(0).optional().default(0.25),
  /** Minimum notional (shares * avgPrice) for a reconciled CLOB orphan to be imported. Below this, skip as dust. */
  RECONCILE_IMPORT_MIN_USD: z.coerce.number().min(0).optional().default(1),
  /**
   * Observability guard: when a single reconciliation cycle ghost-closes at
   * least this many positions, emit an alert. Mass ghosting usually signals a
   * systemic data fault (API/RPC), not that many positions genuinely vanished.
   * The reconciler already refuses to ghost on an inconclusive venue check, so
   * this only ALERTS — it never blocks legitimate cleanup.
   */
  RECONCILE_GHOST_ALERT_THRESHOLD: z.coerce.number().int().min(1).optional().default(5),
  /**
   * False-zero heal guard. When the venue reports FEWER than this many shares
   * for a ledger position that itself holds at least this many, the reconciler
   * treats it as a suspected transient/false-zero read and SUPPRESSES the
   * downward heal (which would otherwise wipe a live position's recorded stake
   * down to dust). Observed 2026-06-13: a 9.08-share weather winner was healed
   * to 0.0089 sh and its genuine +$4 resolution win was recorded as +$0.00.
   * Partial down-heals to a still-meaningful size and upward (size-up) heals are
   * unaffected; the guard only blocks a wipe-to-dust and alerts for manual review.
   */
  RECONCILE_MIN_HEAL_SHARES: z.coerce.number().min(0).optional().default(1),
  /**
   * Wipe-to-dust suppression is logged/paged only once it PERSISTS this many
   * consecutive reconcile cycles. A single suppression is almost always a
   * transient venue read and not worth an alert — only a divergence that
   * survives N cycles (a genuinely stale ledger row vs a real on-chain ~0
   * balance) escalates to error + page; before that it stays debug-only, and
   * after the one escalation it goes quiet again to avoid per-cycle spam.
   */
  RECONCILE_WIPE_SUPPRESS_ALERT_RUNS: z.coerce.number().int().min(1).optional().default(3),
  /** TTL (s) on the per-(market,direction) suppression-streak counter. If no
   *  suppression recurs within this window the streak resets, so a fresh
   *  transient starts the count over rather than inheriting a stale streak. */
  RECONCILE_WIPE_SUPPRESS_TTL_S: z.coerce.number().int().min(60).optional().default(21_600),
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
  COPYTRADE_SCOPE_TAG_FALLBACK: boolFromEnv.optional().default(true),
  COPYTRADE_SIZE_SCALE: z.coerce.number().min(0).optional().default(0.1),
  COPYTRADE_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(25),
  COPYTRADE_MAX_BET_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.1),
  COPYTRADE_MAX_SLIPPAGE_BPS: z.coerce.number().min(0).optional().default(200),
  COPYTRADE_MAX_SLIPPAGE_BPS_CATEGORIES: z
    .string()
    .optional()
    .default(
      '{"crypto-regulatory": 150, "mentions": 50, "macro": 150, "us-politics": 200, "geopolitical": 200, "sports": 100}',
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
  // Recency guard: drop any wallet-activity trade older than N minutes before
  // the candidate pipeline runs. Protects against stale `copytrade:last_ts`
  // cursors (silent wallet resumes, wiped keys) flooding the pipeline with
  // resolved-market zombies.
  COPYTRADE_MAX_TRADE_AGE_MIN: z.coerce.number().min(1).optional().default(30),
  // Extreme-price gate: skip entries where the outcome price is in the tails.
  // At ≤0.08 or ≥0.92, stop-loss % is dominated by spread noise and R/R is asymmetric
  // (e.g. buying NO at 0.95 = 5¢ upside vs 95¢ downside). Measured against the price
  // we'd actually pay (currentOutcomePrice), not the whale's fill.
  COPYTRADE_MIN_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.08),
  COPYTRADE_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.92),
  // Per-category notify-only list. Copytrade signals whose inferred category is
  // in this list fire a Telegram alert but are NOT executed. Default ships
  // 'sports-soccer' only — other sports categories (tennis, F1, MMA, etc.) are
  // executed as normal. Set to empty string to execute all categories.
  COPYTRADE_NOTIFY_ONLY_CATEGORIES: z
    .string()
    .optional()
    .default('sports-soccer')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  // Notify-only Telegram dedup window: suppress repeated pings for the same
  // (wallet, market, direction) tuple within this window. Whales often slice a
  // single intent into N rapid transactions; without this, each transaction
  // produced its own Telegram fire. Must be ≥1 — Redis SET … EX 0 is invalid
  // and would cause the notify-only path to silently drop every alert.
  COPYTRADE_NOTIFY_DEDUP_TTL_SEC: z.coerce.number().int().min(1).optional().default(1800),
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

  // ── Copytrade hedge scanner ─────────────────────────────────────────────────
  // Monitors open copytrade positions on binary markets and buys the opposite
  // side when the math supports it. Two tiers:
  //   Tier 1 (arb): entry_price + hedge_ask < 0.985 → guaranteed profit both ways.
  //   Tier 2 (damage control): hedge_ask < q_max → caps loss at max_loss_fraction.
  // Ships dark. Set true to execute live; false shadow-logs only.
  COPYTRADE_HEDGE_ENABLED: boolFromEnv.optional().default(false),
  // Tier 2: target maximum loss fraction of stake when the hedge wins.
  // 0.40 = lose at most 40% of original stake instead of 100%.
  COPYTRADE_HEDGE_MAX_LOSS_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.40),
  // Cap additional hedge stake at this multiple of the original position stake.
  COPYTRADE_HEDGE_MAX_STAKE_MULTIPLIER: z.coerce.number().min(0).optional().default(1.5),
  // How often the hedge scanner runs inside the monitor loop (ms).
  COPYTRADE_HEDGE_INTERVAL_MS: z.coerce.number().int().min(5_000).optional().default(60_000),

  // Payout ratio gate: skip BUY entries where potential upside is too small.
  // payoutRatio = (1 - currentOutcomePrice) / currentOutcomePrice
  // Default 0.20 = skip if currentPrice > ~0.83 (only 20% gain headroom).
  COPYTRADE_MIN_PAYOUT_RATIO: z.coerce.number().min(0).optional().default(0.20),
  // Minimum edge magnitude: skip if market has fully repriced from whale's fill.
  // edgeMagnitude = |whale_fill_price - current_price|
  // Default 0.015 = skip if residual edge < 1.5¢ (historical bad trades were all <2%).
  COPYTRADE_MIN_EDGE_MAGNITUDE: z.coerce.number().min(0).optional().default(0.015),

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
  NEAR_ZERO_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(1500),
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
  // Patient real-book entry: GTC posted this many bps below side-ask on real
  // books; falls back to taker after MAKER_MAX_WAIT_MS if not filled. 0 = use
  // the global MAKER_PRICE_EDGE_BPS logic (post near the bid) instead.
  NEAR_ZERO_REAL_BOOK_DISCOUNT_BPS: z.coerce.number().min(0).max(5000).optional().default(200),
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
  NEAR_ZERO_THEME_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1).optional().default(600_000),
  // Require a matching OSINT signal before the scanner will evaluate a candidate.
  // When true, candidates without an entry in near_zero:osint_signals are blocked.
  // Set false to restore pure-LLM mode (useful for testing).
  NEAR_ZERO_REQUIRE_OSINT: boolFromEnv.optional().default(true),
  // Enable the NO-side OSINT injector cron (nearZeroOsintInjector.ts).
  NEAR_ZERO_INJECTOR_ENABLED: boolFromEnv.optional().default(true),
  // Minimum LLM relevance score (0–10) for a headline→market pair to be
  // injected as a NO-side OSINT signal.
  NEAR_ZERO_INJECTOR_MIN_NO_SCORE: z.coerce.number().int().min(0).max(10).optional().default(6),
  // Max LLM calls per injector run (cost guard).
  NEAR_ZERO_INJECTOR_MAX_LLM_PER_RUN: z.coerce.number().int().min(1).optional().default(10),
  // Minimum number of keyword tokens that must overlap between an OSINT item
  // and a market question before spending an LLM call on the pair.
  NEAR_ZERO_INJECTOR_MIN_ENTITY_OVERLAP: z.coerce.number().int().min(1).optional().default(2),
  // Maximum price impact (bps) allowed when simulating the stake fill against
  // the live CLOB ask ladder. Prevents entering when the book is too thin to
  // absorb the stake without significant slippage. 200 bps = 2% price impact.
  NEAR_ZERO_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).optional().default(200),
  // After a near-zero-arb position closes, block re-entry on the same market
  // and direction for this many seconds. Prevents immediately re-entering a
  // market that just stopped out or resolved (24h default).
  NEAR_ZERO_REENTRY_COOLDOWN_S: z.coerce.number().int().min(0).optional().default(86400),

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
  // Places resting GTC post-only limit orders on fee-enabled markets with real
  // recent taker flow to earn maker rebates. Rebates are paid ONLY on filled
  // maker liquidity (resting orders earn nothing) from a per-market daily pool
  // funded by taker fees: crypto 20%, most other fee categories (sports,
  // politics, weather, …) 25%; geopolitics is fee-free → no rebate. Payout is
  // daily in pUSD, $1 minimum accrual. Per-fill accrual estimate:
  //   fee_equivalent = shares × feeRate × p × (1−p);  rebate ≈ fee_equivalent × share
  // (actual payout is pool/share based per market). See
  // docs/issues/maker-rebates-not-earning-2026-06-05.md for the audit that
  // shaped these knobs. Filled orders become positions tracked by the monitor
  // with tight TP/SL.
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
  // Age (seconds) past which a resting order CLOB can no longer find is assumed
  // genuinely gone (the !clobOrder "assume gone" heuristic uses 2× this). No
  // longer drives a per-cycle age-cancel of LIVE orders — that churn forfeited
  // CLOB time-priority and crushed fill rate; live orders are now HELD and only
  // cancelled by the reprice pass, a partial fill, resolution, or the lifetime
  // backstop below (queue-priority fix mirroring weather PR #465).
  REBATE_ORDER_TTL_S: z.coerce.number().int().min(60).optional().default(300),
  // Backstop only: cancel a still-LIVE resting order older than this purely as
  // a stuck-order safety net (seconds). Resting orders are otherwise HELD to
  // preserve CLOB time-priority. 24h lets an order actually accrue queue
  // position instead of being recycled every 5-min cycle at the old 300s TTL.
  REBATE_MAX_ORDER_LIFETIME_S: z.coerce.number().int().min(300).optional().default(86_400),
  // Minimum spread in basis points — below this, no room to improve the bid.
  REBATE_MIN_SPREAD_BPS: z.coerce.number().min(0).optional().default(50),
  // Minimum volume (USD) — cheap prefilter before book/flow fetches. Applied
  // to trailing-24h volume when the Gamma universe provides it (primary path),
  // lifetime volume on the watchlist-cache fallback.
  REBATE_MIN_VOLUME: z.coerce.number().min(0).optional().default(50_000),
  // Minimum liquidity (USD) for market selection.
  REBATE_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(10_000),
  // Only quote fee-enabled markets (feesEnabled=true). Maker rebates exist ONLY
  // on fee markets, so disabling this turns the farmer into unpaid liquidity.
  // Replaces the backwards REBATE_SKIP_FEE_MARKETS (default true) that pointed
  // the farmer exclusively at markets that can never pay a rebate.
  REBATE_REQUIRE_FEE_MARKETS: boolFromEnv.optional().default(true),
  // Take-profit / stop-loss for rebate-farmed inventory. 0 = DISABLED (the
  // default): hold to resolution — the near-res gate (→ redeemer) is the only
  // exit. Early exits are wrong for this book: pair legs must never be
  // TP/SL'd apart (selling one leg of a YES+NO pair converts its locked
  // profit back into a directional bet), and singles realize spread/noise.
  REBATE_TAKE_PROFIT_PCT: z.coerce.number().min(0).optional().default(0),
  REBATE_STOP_LOSS_PCT: z.coerce.number().min(0).optional().default(0),
  // -- selection v2: quote where takers actually trade (audit finding 4) --
  // Lookback window for recent-taker-flow estimation from the public data-api.
  REBATE_FLOW_LOOKBACK_HOURS: z.coerce.number().min(0.5).optional().default(6),
  // Minimum recent taker notional per hour (USD) — below this a resting quote
  // realistically never fills, it just churns stale-cancels.
  REBATE_MIN_FLOW_USD_PER_HOUR: z.coerce.number().min(0).optional().default(50),
  // Taker fee rate (bps) used for fee-equivalent estimates. CLOB fee markets
  // currently report taker_base_fee=1000; per-market override is intentionally
  // not fetched (1 extra API call/market) while rates are uniform.
  REBATE_FEE_RATE_BPS: z.coerce.number().min(0).optional().default(1000),
  // Maximum absolute YES-book spread (bestAsk − bestBid). Wider = ghost book;
  // quoting bestBid+1tick on those is how we ended up bidding NO at 0.02 on a
  // market trading NO at 0.85.
  REBATE_MAX_SPREAD_ABS: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Maximum |YES-book mid − recent trade VWAP| — rejects books whose visible
  // quotes have detached from where trades actually print.
  REBATE_MAX_MID_VWAP_DIVERGENCE: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Distance below effective mid for our resting bid (absolute price units).
  REBATE_QUOTE_EDGE: z.coerce.number().min(0).max(0.5).optional().default(0.01),
  // -- two-sided quoting --
  // Quote BOTH tokens (YES bid + NO bid). A NO bid at q is economically an ask
  // on YES at 1−q, so this is two-sided liquidity without holding inventory;
  // both sides filling = riskless pair (cost < $1, redeems $1) + two rebates.
  REBATE_TWO_SIDED: boolFromEnv.optional().default(true),
  // Required combined-price headroom: yesBid + noBid ≤ 1 − this. Guarantees a
  // both-sides fill nets at least this much per share before rebates. Also the
  // pair-cost ceiling for pair-COMPLETING legs across cycles (orderManager):
  // a leg pairing against held inventory / a resting opposite order is skipped
  // when quote + partner cost would exceed 1 − this (8 of the first 12 live
  // pairs combined above $1.00 by chasing moved markets — locked losses).
  REBATE_MIN_COMBINED_EDGE: z.coerce.number().min(0).max(0.5).optional().default(0.02),
  // Skip sports markets whose gameStartTime has passed (in-play). Live games
  // are where taker flow is most informed — resting bids get hit exactly when
  // the game turns (first-day naked legs ran 4W/10L). Pre-game books only.
  // MASTER SWITCH for the whole sports-timing gate: false also disables the
  // no-gameStartTime fail-close AND the REBATE_MIN_HOURS_TO_GAME_START buffer.
  REBATE_EXCLUDE_LIVE_GAMES: boolFromEnv.optional().default(true),
  // Sports-typed markets (feeType sports_*) with NO parseable future
  // gameStartTime are ineligible (fail closed: missing metadata on a
  // near-term event reads as in-play risk) UNLESS endDate is more than this
  // many days out — long-dated outrights (World Cup winner etc.) legitimately
  // have no single game time.
  REBATE_SPORTS_OUTRIGHT_MIN_DAYS: z.coerce.number().min(0).optional().default(2),
  // Pre-game buffer: sports markets whose game starts within this many hours
  // are ineligible ('starting_soon'). Quoting up to the whistle leaves
  // resting pairs carrying into the live game until the order TTL clears
  // them (shadow caught an NHL pair planned 5 minutes before puck drop), and
  // late pre-game flow is the most informed. 0 disables the buffer.
  REBATE_MIN_HOURS_TO_GAME_START: z.coerce.number().min(0).optional().default(1),
  // Shadow mode: with REBATE_FARMING_ENABLED=true, run reconciliation (real)
  // plus selection and the full atomic-pair preflight, but LOG the would-be
  // placements ([rebate-shadow]) instead of sending orders. No governor
  // consumption, no order tracking writes. Go-live validation knob.
  REBATE_SHADOW_MODE: boolFromEnv.optional().default(false),
  // Reprice trigger: when a market re-selects and the fresh target price has
  // drifted from a resting order's price by more than this, cancel + repost.
  REBATE_REPRICE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.02),
  // -- resting-order price revalidation (Phase 2) --
  // The reprice pass only re-prices markets RE-SELECTED this cycle. A resting
  // order on a market that fell out of the top-N is never re-priced — on a
  // trending market its bid is left stranded below the market, never fills, and
  // ties up budget until resolution. When enabled, re-check each DE-selected
  // resting order's price against the live book and CANCEL the stranded ones
  // (frees budget for currently-selected markets). Within-threshold and
  // about-to-fill orders are held (queue priority preserved).
  REBATE_REVALIDATE_RESTING_ENABLED: boolFromEnv.optional().default(false),
  // Stranded-cancel band: cancel a de-selected resting BUY when the fresh maker
  // target has risen ABOVE its resting price by more than this (won't fill).
  // Wider than REBATE_REPRICE_THRESHOLD on purpose — cancelling forfeits queue
  // priority, so only cut clearly-dead bids, not routine 1-3¢ noise.
  REBATE_STALE_DRIFT_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Complete HELD naked legs on DE-SELECTED markets: when one leg of a pair
  // filled but its market then dropped out of the top-N (flow faded near
  // resolution), the Phase-4 loop never re-plans the missing side and the leg
  // sits naked. When true, rebuild a completion candidate for it each cycle so
  // the pair gets closed regardless of flow ranking. Risk-reducing (closes
  // exposure); gated by the same pair-cost ceiling + CLOB minimum as any leg.
  REBATE_COMPLETE_NAKED_LEGS_ENABLED: boolFromEnv.optional().default(true),
  // -- rebate verification --
  // Maker address for the public rebates API (defaults to POLYMARKET_FUNDER_ADDRESS
  // — order placement stamps the funder/proxy wallet as `maker`).
  REBATE_MAKER_ADDRESS: z.string().optional(),
  // Telegram + log daily summary comparing estimated vs API-reported rebates.
  REBATE_DAILY_SUMMARY_ENABLED: boolFromEnv.optional().default(true),
  // Per-fill Telegram notification when a rebate maker leg fills, including its
  // pairing status — PAIRED (opposite leg held = hedged), pair-pending (opposite
  // still resting), or naked single leg (directional exposure). Lets the operator
  // see when a "pair" is actually a one-sided directional bet (e.g. the opposite
  // leg never filled / went INVALID).
  REBATE_FILL_NOTIFY_ENABLED: boolFromEnv.optional().default(true),

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
  // When true, suppress the time-based max-hold exit on positions currently
  // underwater (priceChangePct < 0). Losers stay open until SL (ATR), TP,
  // trailing, or TA-fade fires — max-hold only enforces the time cap on
  // breakeven-or-better positions. If the position climbs ≥0% after the cap,
  // a subsequent tick fires max-hold normally. Prevents the observed pattern
  // of closing losers at -2% after 24h when a recovery was plausible.
  FUTURES_MAX_HOLD_BLOCK_ON_LOSER: boolFromEnv.optional().default(true),
  // Minimum urgency score (1-10) for news items to trigger a futures signal.
  // Lowered from 8 to 6 to increase signal frequency; combined with stake scaling.
  FUTURES_URGENCY_THRESHOLD: z.coerce.number().int().min(1).max(10).optional().default(6),
  // Minimum transfer value (USD millions) for a whale alert to generate a futures signal.
  WHALE_ALERT_MIN_USD_M: z.coerce.number().min(1).optional().default(20),
  // Notional-based SL/TP thresholds (percentage of margin used, NOT account equity).
  // Values are in ROE % (pnl / margin, leverage-scaled) — matches the HL UI.
  // ATR-mode positions use notional % internally; these fixed-pct defaults apply
  // only to the non-ATR path.
  FUTURES_STOP_LOSS_PCT: z.coerce
    .number()
    .max(-0.01, 'FUTURES_STOP_LOSS_PCT must be negative')
    .default(-7.5),
  FUTURES_TAKE_PROFIT_PCT: z.coerce
    .number()
    .min(0.01, 'FUTURES_TAKE_PROFIT_PCT must be positive')
    .default(15),
  // ROE-denominated max-loss backstop — leverage-invariant safety net that fires
  // on top of any path-derived SL (fixed-pct, meme-ATR, global-ATR). Expressed
  // in ROE % (matches HL UI). Set to 0 to disable. When enabled, exits when
  // roePct <= -FUTURES_MAX_LOSS_ROE_PCT regardless of which path computed the
  // notional/ROE SL. Survives leverage changes by construction: −25% ROE means
  // −25% ROE whether running at 5x or 20x.
  FUTURES_MAX_LOSS_ROE_PCT: z.coerce.number().min(0).optional().default(0),
  // Trailing stop — activates after position reaches ACTIVATION_PCT, then exits if it drops TRAILING_STOP_PCT from peak.
  FUTURES_TRAILING_STOP_ENABLED: boolFromEnv.optional().default(true),
  FUTURES_TRAILING_STOP_PCT: z.coerce.number().min(0.1).optional().default(7.5),
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
  BINANCE_KLINE_TIMEFRAMES: z.string().optional().default('1m,5m,15m,1h,4h'),
  KLINE_RETENTION_1M: z.coerce.number().int().min(10).optional().default(240),
  KLINE_RETENTION_5M: z.coerce.number().int().min(10).optional().default(288),
  KLINE_RETENTION_15M: z.coerce.number().int().min(10).optional().default(216),
  KLINE_RETENTION_1H: z.coerce.number().int().min(10).optional().default(96),
  KLINE_RETENTION_4H: z.coerce.number().int().min(10).optional().default(120),

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
  // Applied to HL-momentum path. Spot and news paths have independent overrides below.
  VOLUME_SPIKE_GATE_ENABLED: boolFromEnv.optional().default(false),
  // Spot-path override: volume spike gate for CEX-impulse triggered entries.
  // Defaults false — the CEX price move itself is the volume confirmation.
  SPOT_VOLUME_SPIKE_GATE_ENABLED: boolFromEnv.optional().default(false),
  // News-path override: when false, all three regime gates (volume/ADX/choppiness)
  // are bypassed for OSINT-triggered futures entries. Breaking news causes regime
  // changes rather than occurring within them, so gating on regime state is
  // backward causal. Defaults false.
  NEWS_FUTURES_REGIME_GATES_ENABLED: boolFromEnv.optional().default(false),
  // Live perp entries from news headlines (mapNewsToFutures). When false the path
  // still evaluates every candidate and writes a shadow_observations row
  // (kind=news_futures_signal) for what it would have traded — measured Apr–Jun 2026
  // at 17–32% WR / −$4.51 gross across the news+osint labels.
  NEWS_FUTURES_ENABLED: boolFromEnv.optional().default(true),
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

  // ── HL Momentum Scanner (Binance spot-triggered perp entries) ──
  // Ships dark. Flip to true after ≥48h shadow review shows credible signals.
  HL_MOMENTUM_ENABLED: boolFromEnv.optional().default(false),
  // Fraction of NON-TRADE signal_decisions rows the HL momentum + funding
  // scanners persist. They evaluate every symbol every tick and log a row per
  // evaluation, flooding signal_decisions with routine early-gate skips
  // (~280k rows/day, the dominant DB grower). Trades (has_trade=true) are ALWAYS
  // persisted; skip rows are sampled at this rate to bound the write rate.
  // 1 = persist all (legacy), 0 = persist no skips. Reweight aggregate skip
  // counts by 1 / this rate. Applies to hl-momentum + hl-funding only.
  HL_DECISION_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional().default(0.1),
  // Comma-separated Binance USDT pairs to watch (symbols must match the <sym> portion of
  // spot:klines:<sym>:<timeframe> keys, e.g. spot:klines:ethusdt:1m).
  HL_MOMENTUM_SYMBOLS: z.string().optional().default('btcusdt,ethusdt,solusdt,xrpusdt,dogeusdt,bnbusdt,suiusdt,avaxusdt,linkusdt,tonusdt,aptusdt,pepeusdt,wifusdt,bonkusdt,penguusdt'),
  // Minimum trend-scorer confluence score (|upVotes - downVotes|) to open a position. Range [0,8] (up to 8 voters when both HL-native voters active).
  HL_MOMENTUM_MIN_SCORE: z.coerce.number().int().min(0).max(8).optional().default(6),
  // Minimum ADX to require a trending regime before acting on the direction vote.
  HL_MOMENTUM_MIN_ADX: z.coerce.number().min(0).optional().default(20),
  // Block momentum-direction LONG entries (trend-chasing longs). Contrarian LONGs
  // (RSI-exhaustion bounce buys) are exempt. Measured Apr–Jun 2026: momentum LONGs
  // −4.7 cumulative price-% vs SHORTs +24.2; post-gate contrarian LONGs 66% WR.
  HL_MOMENTUM_BLOCK_MOMENTUM_LONGS: boolFromEnv.optional().default(false),
  // Post-only (ALO) maker entries for hl-momentum: post at the touch, wait for a
  // fill, cancel on timeout — never fall back to taker. Cuts the entry fee from
  // 0.045% to 0.015% (fees were 2/3 of the all-time HL loss; all 827 fills taker).
  HL_MAKER_ENTRIES_ENABLED: boolFromEnv.optional().default(false),
  // How long a maker entry rests before being cancelled (signal is stale past this).
  HL_MAKER_WAIT_SEC: z.coerce.number().int().min(5).optional().default(90),
  // Poll cadence for the resting order's fill status.
  HL_MAKER_POLL_INTERVAL_SEC: z.coerce.number().int().min(1).optional().default(5),
  // ATR-scaled SL/TP for NON-meme hl-momentum positions (2026-06-12 review): frozen
  // at entry like the meme path and stored in the same ledger fields
  // (memeAtrSlPct/memeAtrTpPct = "frozen ATR SL/TP", meme or not). Replaces the fixed
  // ROE stop, which at 10x leverage sat 0.85% price from entry — inside ordinary 15m
  // noise (107 of 256 hl-momentum exits were stop-losses).
  HL_MOMENTUM_ATR_SLTP_ENABLED: boolFromEnv.optional().default(false),
  // SL = clamp(15m ATR% × mult, floor, ceil), price terms.
  HL_MOMENTUM_SL_ATR_MULT: z.coerce.number().min(0.5).optional().default(2.75),
  HL_MOMENTUM_SL_FLOOR_PCT: z.coerce.number().min(0).optional().default(1.5),
  HL_MOMENTUM_SL_CEIL_PCT: z.coerce.number().min(0).optional().default(6),
  // Trailing-arm threshold = 15m ATR% × mult, price terms (unclamped — trailing
  // manages the upside beyond it).
  HL_MOMENTUM_TP_ATR_MULT: z.coerce.number().min(0.5).optional().default(3.0),
  // Trailing giveback = entry 15m ATR% × mult, price terms. Replaces the fixed ROE
  // giveback (0.5% price at 10x) that scratched winners on the first wiggle.
  HL_MOMENTUM_TRAIL_ATR_MULT: z.coerce.number().min(0.1).optional().default(1.0),
  // Pure-time-exit shadow experiment: for every hl-momentum entry, record what a
  // no-SL/no-trail exit after HL_TIME_EXIT_SHADOW_HOURS would have returned
  // (shadow_observations kind=hl_time_exit_shadow). Separates "signal is dead" from
  // "geometry kills a real edge". Logging only — no trading behaviour.
  HL_TIME_EXIT_SHADOW_ENABLED: boolFromEnv.optional().default(true),
  HL_TIME_EXIT_SHADOW_HOURS: z.coerce.number().min(1).optional().default(8),
  // Contrarian mode: validate the momentum setup as usual, then execute the opposite side.
  HL_MOMENTUM_CONTRARIAN_ENABLED: boolFromEnv.optional().default(false),
  // When ADX is at or above this ceiling, momentum is genuinely trending and contrarian is
  // suppressed per-signal even when CONTRARIAN_ENABLED=true. Data shows ADX 40-50 bucket
  // has 60% WR / 25% SL rate trading with momentum vs ~47% WR trading against it.
  HL_MOMENTUM_CONTRARIAN_ADX_CEILING: z.coerce.number().min(20).optional().default(40),
  // RSI exhaustion gates for contrarian entries. Contrarian LONG requires RSI ≤ oversold
  // (momentum genuinely exhausted down); contrarian SHORT requires RSI ≥ overbought.
  // All 10 historical contrarian losses had RSI 30–40/60–70 — never in true exhaustion zone.
  // Bounds capped at 45/55 to guarantee a ≥10-point gap and prevent the gate from
  // becoming a no-op if both thresholds are set to neutral (50).
  HL_MOMENTUM_CONTRARIAN_RSI_OVERSOLD: z.coerce.number().min(0).max(45).optional().default(30),
  HL_MOMENTUM_CONTRARIAN_RSI_OVERBOUGHT: z.coerce.number().min(55).max(100).optional().default(70),
  // When contrarian mode is on, arm the trailing stop earlier (mean-reversion snap-back is
  // front-loaded; waiting for the standard TP arm leaves too much on the table).
  HL_MOMENTUM_CONTRARIAN_TAKE_PROFIT_PCT: z.coerce.number().min(0).optional().default(10),
  // Wider SL for contrarian positions. Mean-reversion entries need room for the initial
  // momentum continuation before the snap-back; 8.5% (0.85% spot at 10x) was too tight.
  // 15% = 1.5% spot at 10x. Meme positions using ATR-derived SL are unaffected.
  HL_MOMENTUM_CONTRARIAN_STOP_LOSS_PCT: z.coerce.number().min(0).optional().default(15),
  // Per-side cooldown in seconds after a momentum entry (prevents rapid re-entry on same side).
  HL_MOMENTUM_COOLDOWN_SEC: z.coerce.number().int().min(60).optional().default(600),
  // Short cooldown for transient executor skips (stake_below_hl_minimum) — price fluctuation
  // can push order size above the HL minimum, so 60s is enough to allow a retry.
  HL_MOMENTUM_MIN_SKIP_COOLDOWN_SEC: z.coerce.number().int().min(10).optional().default(60),
  // Per-side cooldown after a TP/non-SL exit from an hl-momentum position. Prevents
  // re-entering the same thesis immediately after a profitable close.
  HL_MOMENTUM_POST_TP_COOLDOWN_SEC: z.coerce.number().int().min(60).optional().default(1800),
  // Lookback windows for each scoring timeframe.
  // 15m primary: 54h (194,400,000ms) → ~216 bars (covers MACD 35-bar warmup with room to spare).
  HL_MOMENTUM_PRIMARY_LOOKBACK_MS: z.coerce.number().int().min(60_000).optional().default(194_400_000),
  // 1h MACD gate: 50h → ~50 bars (MACD 12/26/9 needs 35 closes).
  HL_MOMENTUM_1H_LOOKBACK_MS: z.coerce.number().int().min(60_000).optional().default(180_000_000),
  // 4h EMA gate: 10d → ~60 bars (EMA50 needs 50 closes).
  HL_MOMENTUM_4H_LOOKBACK_MS: z.coerce.number().int().min(60_000).optional().default(864_000_000),
  // Enable the MTF bias gates.
  HL_MOMENTUM_MTF_4H_GATE_ENABLED: boolFromEnv.optional().default(true),
  HL_MOMENTUM_MTF_1H_GATE_ENABLED: boolFromEnv.optional().default(true),
  // EMA periods used for the 4h trend-bias gate.
  HL_MOMENTUM_4H_EMA_FAST: z.coerce.number().int().min(2).optional().default(20),
  HL_MOMENTUM_4H_EMA_SLOW: z.coerce.number().int().min(2).optional().default(50),
  // USD stake per momentum entry. Capped to FUTURES_MAX_PER_TRADE_USD at runtime.
  HL_MOMENTUM_STAKE_USD: z.coerce.number().min(1).optional().default(10),
  // Per-source SL/TP overrides for the futures monitor. 15m swing signals need wider
  // thresholds than 1m-tuned arb defaults to avoid being stopped out by normal chop.
  HL_MOMENTUM_STOP_LOSS_PCT: z.coerce.number().min(0).optional().default(15),
  HL_MOMENTUM_TAKE_PROFIT_PCT: z.coerce.number().min(0).optional().default(30),
  // Longs have been the weak side of the book. When enabled, a LONG only passes if at
  // least one present HL-native voter (funding contra / OI divergence) actively confirms UP.
  // Missing HL-native data is not treated as a veto; the gate only acts on present votes.
  HL_MOMENTUM_LONG_REQUIRE_HL_CONFIRMATION: boolFromEnv.optional().default(true),
  // MTF scoring mode. 'hard' = AND-stack (current — both MTF gates must pass);
  // 'weighted' = each MTF signal becomes a score boost, trade if total ≥ MIN_TOTAL_SCORE.
  // Ships with 'hard' default → zero behavior change at merge.
  HL_MOMENTUM_MTF_SCORING_MODE: z.enum(['hard', 'weighted']).optional().default('hard'),
  // Weighted mode only: 4h EMA spread (% of slow EMA) below this counts as neutral
  // (0 pts, no penalty). Above: aligned = +2, opposed = -2.
  HL_MOMENTUM_4H_NEUTRAL_BAND_PCT: z.coerce.number().min(0).optional().default(0.5),
  // Weighted mode only: minimum integer total score (15m absScore + MTF bonuses) required to trade.
  // Range: capped at 11 (8 voters + 2 for 4h aligned + 1 for 1h aligned; 8 is the max when both
  // HL-native voters — funding contra + OI divergence — are active). Default 5 is conservative.
  HL_MOMENTUM_MIN_TOTAL_SCORE: z.coerce.number().int().min(0).max(11).optional().default(5),
  // ── Meme-perp ATR-scaled SL/TP (issue #264) ──
  // Replaces the fixed HL_MOMENTUM_STOP_LOSS_PCT / _TAKE_PROFIT_PCT for meme symbols whose
  // 15m ATR is too wide for the 5%/12% defaults (typical meme ATR 8-15%). Computes SL/TP at
  // entry using 15m ATR × multiplier, frozen on the position. TP is unbounded — trailing stop
  // rides the upside. Ships dark; flip per-symbol after shadow review.
  HL_MOMENTUM_MEME_ATR_SLTP_ENABLED: boolFromEnv.optional().default(false),
  HL_MOMENTUM_MEME_SYMBOLS: z.string().optional().default('wifusdt,bonkusdt,penguusdt'),
  HL_MOMENTUM_MEME_SL_ATR_MULT: z.coerce.number().min(0).optional().default(1.5),
  HL_MOMENTUM_MEME_TP_ATR_MULT: z.coerce.number().min(0).optional().default(3.0),
  // Floor + ceiling on the SL magnitude — protects against pathological ATR readings.
  // No corresponding cap on TP: user wants the trailing stop to manage the upside.
  HL_MOMENTUM_MEME_SL_FLOOR_PCT: z.coerce.number().min(0).optional().default(8),
  HL_MOMENTUM_MEME_SL_CEIL_PCT: z.coerce.number().min(0).optional().default(20),

  // Anti-chase stretch gate — blocks entries when the primary-TF RSI is overheated/
  // washed-out or when price is too far from VWAP, reducing exhaustion-peak entries.
  HL_MOMENTUM_ANTI_CHASE_ENABLED: boolFromEnv.optional().default(true),
  HL_MOMENTUM_RSI_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  HL_MOMENTUM_RSI_OVERBOUGHT: z.coerce.number().min(50).max(100).optional().default(70),
  HL_MOMENTUM_RSI_OVERSOLD: z.coerce.number().min(0).max(50).optional().default(30),
  // Maximum allowed % distance of price from VWAP in the trade direction before blocking.
  HL_MOMENTUM_VWAP_MAX_DIST_PCT: z.coerce.number().min(0).optional().default(3.0),
  // Soft confirmation layer for borderline stretched setups. Clean entries still fire
  // immediately; only setups near the anti-chase thresholds must persist for one more
  // closed 15m bar before the scanner returns a live signal.
  HL_MOMENTUM_SOFT_CONFIRM_ENABLED: boolFromEnv.optional().default(true),
  HL_MOMENTUM_SOFT_CONFIRM_TTL_SEC: z.coerce.number().int().min(60).optional().default(7200),
  // Borderline VWAP stretch threshold that triggers a one-bar persistence check. Must
  // remain below HL_MOMENTUM_VWAP_MAX_DIST_PCT to avoid collapsing into the hard veto.
  HL_MOMENTUM_SOFT_CONFIRM_VWAP_DIST_PCT: z.coerce.number().min(0).optional().default(2.0),
  // Distance in RSI points below the hard overbought / above the hard oversold level
  // that enters the soft-confirm band. Example with defaults: LONG needs confirmation
  // at RSI >= 64, but is hard-blocked only at RSI >= 70.
  HL_MOMENTUM_SOFT_CONFIRM_RSI_BUFFER: z.coerce.number().min(0).max(25).optional().default(6),

  // ── Breakout-retest-hold gate ──
  // Requires a visible breakout → retest → hold pattern in recent 15m candles before
  // allowing entry. Ships dark (false) — flip after shadow review.
  HL_MOMENTUM_REQUIRE_BREAKOUT_RETEST: boolFromEnv.optional().default(false),
  // Number of closed 15m bars before the breakout bar used to compute the swing high/low.
  HL_MOMENTUM_BREAKOUT_LOOKBACK_BARS: z.coerce.number().int().min(3).optional().default(12),
  // Maximum age of the breakout bar in bars (relative to the current hold bar).
  // Breakouts older than this are considered stale and ignored.
  HL_MOMENTUM_BREAKOUT_FRESH_BARS: z.coerce.number().int().min(1).optional().default(6),
  // Retest tolerance as % of the broken level (floor when ATR is available).
  HL_MOMENTUM_RETEST_TOL_PCT: z.coerce.number().min(0).optional().default(0.3),
  // Retest tolerance as an ATR multiple (primary; takes precedence over pct when larger).
  HL_MOMENTUM_RETEST_TOL_ATR_MULT: z.coerce.number().min(0).optional().default(0.5),

  // ── HL-native signals (issue #265) ──
  // Sub-PR 1: Funding-rate contra voter. HL settles perp funding hourly at
  // 1/8 of the computed 8h rate, so APR = hourlyFundingRate × 24 × 365.
  // Extreme APR → crowded positioning → contra vote. Within ±threshold band
  // the voter stays neutral and doesn't affect the existing 6-voter score.
  HL_FUNDING_CONTRA_ENABLED: boolFromEnv.optional().default(false),
  // Symmetric APR threshold (percent). Default 100 = ±100% APR ≈ ±0.0114%/hr.
  HL_FUNDING_CONTRA_APR_THRESHOLD: z.coerce.number().min(0).optional().default(100),
  // Per-symbol Redis cache TTL for hl:asset-ctx:<symbol>. Shared across all
  // HL-native voters (Sub-PRs 1 + 2) to keep info-endpoint load flat.
  HL_FUNDING_CONTRA_CACHE_TTL_SEC: z.coerce.number().int().min(5).optional().default(60),

  // Sub-PR 2: OI divergence voter. Compares current OI vs a rolling Redis
  // baseline to detect whether a price move is backed by new positioning or
  // is just forced covering/liquidation.
  HL_OI_DIVERGENCE_ENABLED: boolFromEnv.optional().default(false),
  // Minimum |OI % change| vs baseline to trigger a non-neutral vote.
  HL_OI_DIVERGENCE_THRESHOLD_PCT: z.coerce.number().min(0).optional().default(5),
  // TTL for hl:oi-baseline:<symbol> — defines the OI measurement window.
  // At expiry the key is refreshed (one neutral tick per cycle).
  HL_OI_BASELINE_TTL_SEC: z.coerce.number().int().min(30).optional().default(900),

  // ── HL Funding-Rate Mean-Reversion Scanner ──
  // Standalone signal path: when |fundingAPR| > ENTRY_APR_THRESHOLD on any perp,
  // open a contra position (SHORT if APR>0, LONG if APR<0). Two return streams:
  // price mean-reversion + funding carry collected while holding.
  // Ships dark: flip HL_FUNDING_SCANNER_ENABLED=true after ≥48h shadow review.
  HL_FUNDING_SCANNER_ENABLED: boolFromEnv.optional().default(false),
  // Poll cadence in seconds. Funding settles hourly so 5min is ample.
  HL_FUNDING_SCANNER_POLL_INTERVAL_SEC: z.coerce.number().int().min(60).optional().default(300),
  // TTL for the hl:asset-ctx:all bulk Redis cache. Must be ≤ POLL_INTERVAL_SEC.
  HL_FUNDING_SCANNER_BULK_CTX_TTL_SEC: z.coerce.number().int().min(10).optional().default(120),
  // Enter contra when |APR| exceeds this threshold (percent, annualized).
  HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD: z.coerce.number().min(0).optional().default(100),
  // Exit when |APR| drops below this threshold (funding normalized). Must be < ENTRY.
  HL_FUNDING_SCANNER_EXIT_APR_THRESHOLD: z.coerce.number().min(0).optional().default(20),
  // USD per entry; capped to FUTURES_MAX_PER_TRADE_USD.
  HL_FUNDING_SCANNER_STAKE_USD: z.coerce.number().min(1).optional().default(15),
  // Stop-loss magnitude as ROE %. Wider than hl-momentum (8.5%) because we fade momentum.
  HL_FUNDING_SCANNER_STOP_LOSS_PCT: z.coerce.number().min(0).optional().default(15),
  // Take-profit magnitude as ROE %.
  HL_FUNDING_SCANNER_TAKE_PROFIT_PCT: z.coerce.number().min(0).optional().default(20),
  // Hard time cap per position in hours. Funding squeezes rarely persist beyond 48h.
  HL_FUNDING_SCANNER_MAX_HOLD_HOURS: z.coerce.number().min(0).optional().default(48),
  // Per-(symbol, side) cooldown after a successful entry. 1h prevents back-to-back
  // re-entry while funding stays extreme but position is still open.
  HL_FUNDING_SCANNER_COOLDOWN_SEC: z.coerce.number().int().min(60).optional().default(3600),
  // Short cooldown for stake_below_hl_minimum skips (transient, price-dependent).
  HL_FUNDING_SCANNER_MIN_SKIP_COOLDOWN_SEC: z.coerce.number().int().min(10).optional().default(60),
  // Comma-separated HL tickers to never enter via the funding scanner (escape hatch).
  HL_FUNDING_SCANNER_SYMBOL_DENYLIST: z.string().optional().default(''),
  // Minimum open interest in USD (markPrice × OI contracts) to qualify for entry.
  // Filters out low-liquidity tokens (VINE, TURBO, kLUNC) whose funding extremes
  // are often structural/manipulation-driven rather than mean-reverting.
  HL_FUNDING_SCANNER_MIN_OI_USD: z.coerce.number().min(0).optional().default(5_000_000),
  // Maximum number of concurrently open funding-scanner positions. Hard cap to
  // prevent a single scan from opening many positions when a funding spike is broad.
  HL_FUNDING_SCANNER_MAX_POSITIONS: z.coerce.number().int().min(1).optional().default(3),

  // ── Chainlink → PM crypto-arb trigger ──
  // When true, oracle:price_moved ticks also fan into the PM crypto-arb scanner
  // alongside the Binance spot:price_moved path. Edge = Chainlink oracle lead over
  // Binance: changePercent is ((oraclePrice − lastBinancePrice) / lastBinancePrice) * 100.
  // Requires CHAINLINK_REDIS_PUBLISH_ENABLED=true. Ships dark.
  CHAINLINK_CRYPTO_ARB_ENABLED: boolFromEnv.optional().default(false),

  // ── OSINT → Polymarket market trading ──
  // When false, ingestion still runs (Telegram monitor + mapNewsToFutures remain active)
  // but runMapping (PM market entry from news) is suppressed. 2026-05-11: disabled after
  // 234 trades at 11% WR / -55% avg return — probable category-attribution noise in early
  // data but P&L is negative regardless.
  OSINT_PM_TRADING_ENABLED: boolFromEnv.optional().default(false),

  // ── FV scanner (Black-Scholes fair-value vs book mid on 15m BTC/ETH Up/Down) ──
  // Ships dark: FV_SCANNER_ENABLED=false. Empirical data (n=14,134, 87.6% WR) from
  // sister bot confirms FV is the correct signal family; OL on 15m is 21.1% WR.
  FV_SCANNER_ENABLED: boolFromEnv.optional().default(false),
  FV_ASSETS: z.string().optional().default('bitcoin,ethereum'),
  // τ gate: don't trade below this many seconds to expiry.
  // Gaussian log-normal overconfidence bites at τ < 120s on 15m markets.
  FV_TAU_MIN_S: z.coerce.number().int().min(30).optional().default(120),
  // p_model gates (asymmetric — both sides can't trigger simultaneously)
  FV_YES_P_MODEL_MIN: z.coerce.number().min(0).max(1).optional().default(0.80),
  FV_YES_P_MODEL_MAX: z.coerce.number().min(0).max(1).optional().default(0.95),
  FV_NO_P_MODEL_MAX: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Edge thresholds: YES edge = pYes − yesMid; NO edge = pNo − noMid. Both must be positive.
  // NO minimum is wider than YES due to σ-floor distortion inflating pNo.
  // Per-source entry price cap — overrides MAX_ENTRY_PRICE for fv-scanner signals only.
  // FV scanner intentionally enters high-probability outcomes (YES 0.80–0.95, NO token
  // 0.88–0.99), so the global cap would block all valid signals. Set to 0 to disable.
  FV_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.98),
  FV_YES_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.10),
  FV_NO_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  FV_NO_MAX_EDGE: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Momentum suppression: signed log-return threshold over the last N seconds.
  // Prevents buying against the oracle direction on fast-moving ticks.
  FV_MOMENTUM_LOOKBACK_S: z.coerce.number().int().min(1).optional().default(10),
  FV_MOMENTUM_SUPPRESS_BPS: z.coerce.number().min(0).optional().default(10),
  // Kelly sizing — fractional Kelly; 0.25 = quarter-Kelly (25% of full Kelly).
  FV_KELLY_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.25),
  FV_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(10),
  FV_MAX_TRADES_PER_HOUR: z.coerce.number().int().min(1).optional().default(20),
  // Patient real-book entry: GTC posted this many bps below side-ask on real
  // books; falls back to taker after MAKER_MAX_WAIT_MS if not filled. 0 = use
  // the global MAKER_PRICE_EDGE_BPS logic (post near the bid) instead.
  FV_REAL_BOOK_DISCOUNT_BPS: z.coerce.number().min(0).max(5000).optional().default(200),
  // σ calibrator knobs (match sister bot's implementation exactly)
  FV_SIGMA_ROLLING_WINDOW_MS: z.coerce.number().int().min(60_000).optional().default(3_600_000),
  FV_SIGMA_EWMA_HALF_LIFE_S: z.coerce.number().positive().optional().default(300),
  FV_SIGMA_EWMA_SPIKE_MULT: z.coerce.number().min(1).optional().default(1.5),
  FV_SIGMA_MIN: z.coerce.number().min(0).optional().default(0.20),
  FV_SIGMA_MAX: z.coerce.number().min(0).optional().default(5.00),
  FV_SIGMA_WARMUP_TICKS: z.coerce.number().int().min(1).optional().default(180),
  // Wall-clock warmup floor: no signals until this many ms have elapsed since
  // the first tick, regardless of tick count. Prevents fast-restart drift.
  FV_SIGMA_WARMUP_MIN_S: z.coerce.number().int().min(0).optional().default(180),
  // Strike resolution: max seconds between window_start_ts and closest RTDS tick.
  FV_STRIKE_TOLERANCE_S: z.coerce.number().int().min(1).optional().default(60),

  // ── Phase 3: Sports arb (NBA + NHL + MLB) ──
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
          .filter((s): s is 'nba' | 'nhl' | 'mlb' => s === 'nba' || s === 'nhl' || s === 'mlb'),
      ),
    ),
  SPORTS_POLL_INTERVAL_S: z.coerce.number().int().min(1).optional().default(8),
  SPORTS_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  SPORTS_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(5),
  SPORTS_MARKET_LOOKAHEAD_H: z.coerce.number().int().min(1).optional().default(200),
  // Tolerance (hours) for matching a live ESPN game to a Polymarket market by
  // endDate. Expected endDate = game scheduledStart + per-league offset
  // (NBA/NHL: 0h, MLB: +168h). A live game matches only markets whose endDate
  // falls within ±this many hours of the expected value. Disambiguates
  // back-to-back-day series (same two teams, different games) where nickname
  // matching alone fires an in-play signal against the next day's pregame
  // market — e.g., the 2026-04-22 White Sox/Diamondbacks incident.
  SPORTS_LIVE_MATCH_TOLERANCE_H: z.coerce.number().min(1).optional().default(6),
  // Only generate MLB signals from this inning onwards. Early innings have high
  // variance (a 2-run lead in the 3rd easily reverses), which causes stop-losses
  // to fire before the model's edge can materialise. Default 6 targets the back
  // half of the game where outcomes are more predictable.
  SPORTS_MLB_MIN_INNING: z.coerce.number().int().min(1).optional().default(6),
  // In empty-book mode, sports signals post their maker order at the current
  // market price + this premium instead of the logistic model probability. The
  // model price can be 10-20% above the stale Polymarket mid (pre-game odds),
  // causing an immediate paper loss that triggers the stop-loss on the next
  // monitor tick. Near-market anchoring eliminates adverse selection while
  // keeping the model probability for divergence-closed exit checks.
  SPORTS_MAKER_PREMIUM_PCT: z.coerce.number().min(0).max(0.5).optional().default(0.02),
  // Block sports signals on ghost books (bid≈0.01/ask≈0.99). Sports arb is a
  // mid-game price-discovery play — divergence-close and TP both require an active
  // book to fire before resolution. On ghost books the only exit is resolution,
  // converting the arb into a pure outcome bet on a trailing team.
  SPORTS_REQUIRE_REAL_BOOK: boolFromEnv.optional().default(true),
  // TTL (seconds) for Redis live-prob keys written by the scanner on every poll tick.
  // 10 minutes: scanner refreshes every ~8s, so 600s survives ~75 missed polls before
  // the key expires. Short enough that keys don't linger hours after a game ends or
  // the scanner goes down — monitor falls back to entry-time consensus on expiry.
  SPORTS_LIVE_PROB_TTL_S: z.coerce.number().int().min(60).optional().default(600),
  // Purely informational — documents which TELEGRAM_CHANNELS entries are
  // sports-primary. Not used by runtime; channels are added directly to
  // TELEGRAM_CHANNELS and auto-classified by the category classifier.
  SPORTS_TELEGRAM_HANDLES: z.string().optional().default(''),

  // ── Epic #142 — Durable analytics + retrieval layer ─────────────
  // Postgres connection. Optional until #147 cutover; the writer is the
  // only consumer today and fails loud at startup if PG_URL is unset.
  PG_URL: z.string().optional(),
  // Passwordless connection URL for host-side read-only scripts (e.g. shadow analysis).
  // Uses .pgpass for authentication. Containers always use PG_URL (with password).
  PG_URL_NOPASS: z.string().optional(),
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
  // Lowest-temperature markets ("Lowest temperature in [city] on [date]?",
  // Gamma tag_slug=lowest-temperature). Same bracket structure as the highest
  // markets but resolves against the day's MINIMUM temperature, so it uses the
  // forecast low, an inverted conditional oracle, and a min climo "fall" table.
  // Two-stage rollout mirrors the rest of the weather stack:
  //   Stage 1 (shadow): WEATHER_LOWEST_TEMP_SHADOW_ENABLED=true (default) logs
  //     would-trade lowest-temp opportunities to shadow_observations, never executes.
  //   Stage 2 (live):   WEATHER_LOWEST_TEMP_ENABLED=true routes them through the
  //     normal execution path (still subject to WEATHER_EXECUTION_ENABLED).
  // Both default-off-for-live / on-for-shadow so the feature ships dark.
  WEATHER_LOWEST_TEMP_ENABLED: boolFromEnv.optional().default(false),
  WEATHER_LOWEST_TEMP_SHADOW_ENABLED: boolFromEnv.optional().default(true),
  // Telegram + log once-per-UTC-day digest of weather performance (bets placed,
  // fills, entry prices, realized PnL, wins/losses, best/worst). Fires from the
  // weather cron entrypoint; gated by a Redis NX key so it sends at most once/day.
  WEATHER_DAILY_SUMMARY_ENABLED: boolFromEnv.optional().default(true),
  // Defer the daily weather digest until at least this UTC hour so the PREVIOUS
  // weather-day's Western-hemisphere markets — which resolve at city-local
  // midnight ≈ early-UTC the next day — have all settled before we report.
  // Sent at 00:00–08:00 UTC, a "yesterday" report would miss those wins (e.g.
  // Panama City resolved 05:24 UTC) and skew the day negative. 12 clears even
  // UTC-10 cities. The digest groups resolutions by city-local resolution day.
  WEATHER_DAILY_SUMMARY_MIN_UTC_HOUR: z.coerce.number().int().min(0).max(23).optional().default(12),
  // Restricts which bracket sides the scanner will treat as tradable. Default 'BOTH'
  // preserves legacy behavior. 'NO' is the 2026-04-19 post-analysis config: 186-outcome
  // reconciliation showed NO side at 73.7% vs YES at 11.5% — gate out YES until the
  // structural YES bias is understood. Shadow obs still log both sides with an
  // `allowedByConfig` flag so the YES path keeps accruing validation data.
  WEATHER_TRADE_SIDES: z.enum(['YES', 'NO', 'BOTH']).optional().default('BOTH'),
  // Minimum edge (model probability - market bid price) to consider a trade.
  // Compares modelProb vs yesPrice for YES, (1-modelProb) vs noPrice for NO.
  // Higher than binary markets because bracket model uncertainty is larger (8-10¢ recommended).
  WEATHER_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  // Maximum bankroll fraction per weather trade — conservative because forecast
  // uncertainty grows with horizon and model error is correlated across brackets.
  WEATHER_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.02),
  // Hard USD ceiling per weather trade (applied after fraction cap). 0 = disabled.
  // Use to prevent large bankrolls from sizing into outsized weather positions.
  WEATHER_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(0),
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
  // Minimum ratio of ensemble stddev to the climatology-default stddev. Prevents a
  // tight ensemble from collapsing the bracket distribution (observed in tropical cities
  // where ensemble stddev < 0.3°C causes 5-8σ misses against ground truth).
  // 0.7 = ensemble stddev may not be tighter than 70% of the seasonal default.
  WEATHER_STDDEV_MIN_FRACTION: z.coerce.number().min(0.1).max(1).optional().default(0.7),
  // Minimum sum of all model bracket probabilities in an event. Below this threshold
  // the event is skipped — late-day bracket thinning (11 → 4 brackets) leaves the
  // surviving brackets with artificially high probability mass and trips the edge gate
  // on a math artifact. 0.95 allows small tail leakage at outermost brackets.
  WEATHER_MIN_MODEL_COVERAGE: z.coerce.number().min(0).max(1).optional().default(0.95),
  // Use ECMWF IFS 0.25° 51-member ensemble instead of GFS 31-member for stddev estimation.
  // ECMWF has ~0.2-0.5°C lower Tmax MAE at 1-day lead globally. Ships dark.
  WEATHER_MODEL_ECMWF_ENABLED: boolFromEnv.optional().default(false),
  // Shadow both ensemble models on each scan: keep one primary model for live
  // trading, but also fetch the alternate ensemble and log its implied bracket
  // probabilities/edges alongside the primary path for calibration comparison.
  WEATHER_DUAL_ENSEMBLE_SHADOW_ENABLED: boolFromEnv.optional().default(true),
  // Mutual-veto gate: when the shadow ensemble sees no edge (shadowEdge ≤ 0) on a
  // bracket the primary model wants to trade, block it. Both models must agree on
  // the same side before a trade fires. Shadow is ECMWF when WEATHER_MODEL_ECMWF_ENABLED
  // =false (GFS primary), and GFS when =true. Ships dark.
  WEATHER_DUAL_ENSEMBLE_VETO_ENABLED: boolFromEnv.optional().default(false),
  // Allow fresh entries on resolution day when enough local time remains before the
  // daily high is observed. Entry requires positive ensemble agreement (shadowEdge > 0);
  // null shadowEdge (no ECMWF data) also blocks — fail closed.
  WEATHER_RES_DAY_EARLY_ENTRY_ENABLED: boolFromEnv.optional().default(false),
  // Hours until local city midnight that must remain for a resolution-day fresh entry
  // to be considered. 15h ≈ before 09:00 local — no temperature readings exist yet.
  WEATHER_RES_DAY_MIN_HOURS_REMAINING: z.coerce.number().min(0).max(24).optional().default(15),
  // Use HRRR (3km, hourly-updating, radar-assimilated) as 3rd voter for US cities at daysOut≤1.
  // HRRR is the highest-accuracy US model at 0–18h lead. Ships dark.
  WEATHER_HRRR_ENABLED: boolFromEnv.optional().default(false),
  // Maximum raw spread (°F) across NOAA/OM/HRRR before the forecast is rejected.
  // Protects against a single-source API glitch contaminating the ensemble mean.
  // At daysOut=1 normal US spread is 2–8°F; 15°F rejects only clear outliers.
  WEATHER_HRRR_MAX_CROSS_SOURCE_SPREAD: z.coerce.number().min(1).optional().default(15),
  // Apply per-city mean-bias subtraction and empirical σ overlay. Requires Redis cache
  // to be populated by the reconciler (runs automatically, no extra cron needed). Ships dark.
  WEATHER_BIAS_CORRECTION_ENABLED: boolFromEnv.optional().default(false),
  // Minimum paired (forecast, observed) samples required before bias metadata is trusted
  // at all. Below this, cities pass through fully uncorrected (safe default).
  WEATHER_BIAS_MIN_SAMPLES: z.coerce.number().int().min(1).optional().default(14),
  // Sample count at which we trust mean-bias correction enough to shift the forecast.
  // Between WEATHER_BIAS_MIN_SAMPLES and this, the scanner enters a "weak band":
  // it does NOT subtract cityMeanBias from the forecast, but widens effective σ
  // via WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER. At or above this threshold, full
  // correction (mean shift + empirical σ overlay) applies. Keeping the default
  // equal to WEATHER_BIAS_MIN_SAMPLES means prod opens the weak band by lowering
  // min in .env, so code-default behavior stays conservative.
  WEATHER_BIAS_TRUSTED_SAMPLES: z.coerce.number().int().min(1).optional().default(14),
  // Stddev inflator applied inside the weak band (min ≤ n < trusted). Reflects
  // that thin-sample bias estimates are genuine evidence of forecast noise but
  // not reliable enough to shift the mean — so we respond by widening the
  // distribution instead. 1.2 = +20% effective σ in the weak band.
  WEATHER_WEAK_BIAS_STDDEV_MULTIPLIER: z.coerce.number().min(1).max(3).optional().default(1.2),
  // Comma-separated city names to exclude from trade execution while their bias
  // is recalibrating. Shadow observations and ground-truth collection continue
  // unaffected so the bias converges in the background. Remove a city from this
  // list (and restart pga-cron) once its residual error stabilises. Example:
  // WEATHER_EXCLUDED_CITIES=los angeles,miami,amsterdam,london
  WEATHER_EXCLUDED_CITIES: z.string().optional().default(''),
  // Only feed (forecast, observed) pairs observed at/after this ISO timestamp
  // into the per-city bias EWMA. Set this to the deploy time whenever forecast
  // coordinates or resolution stations change: older samples were measured
  // against a different thermometer and would poison the mean shift (e.g. LA's
  // downtown-coords bias applied to KLAX-coords forecasts would inject an
  // ~11°F error). Cities fall back to uncorrected/weak-band behaviour until
  // enough post-cutover samples accumulate. Empty = no cutoff.
  WEATHER_BIAS_SAMPLES_SINCE: z.string().optional().default(''),
  // Daily audit (runs with the weather reconciler): parse every active weather
  // market's description for its resolution station and alert on any city
  // whose station/source disagrees with CITY_COORDINATES. Catches silent
  // station switches like LTBA→LTFM before they cost positions.
  WEATHER_STATION_AUDIT_ENABLED: boolFromEnv.optional().default(true),
  // --- WEATHER EXECUTION ---
  // Killswitch separate from the scanner flag. Scanner may be ENABLED=true (shadow +
  // `would execute trade` logs) without actually placing orders. Flipping
  // WEATHER_EXECUTION_ENABLED=true routes allowed opportunities through
  // executeAndRecordSignal. Ship dark; flip once caps + monitor exits are validated.
  WEATHER_EXECUTION_ENABLED: boolFromEnv.optional().default(false),
  // Max real-trade entries per scan cycle (6h). Hard cap irrespective of bankroll —
  // brackets are correlated per-city and edge-sorted opps from a single event can
  // all point to the same forecast error. Start at 3 for first live run.
  WEATHER_MAX_POSITIONS_PER_SCAN: z.coerce.number().int().min(0).optional().default(3),
  // Max real-trade entries per city per scan. City-level correlation is near-1
  // across brackets of the same event; stacking two brackets on Chicago doubles
  // the exposure to one forecast error. 1 keeps risk diverse across cities.
  WEATHER_MAX_PER_CITY: z.coerce.number().int().min(0).optional().default(1),
  // Total USD committed across all weather entries in one scan. Safety net if Kelly
  // sizing + count cap ever misbehave. Opp iteration stops once cumulative stake
  // would exceed this.
  WEATHER_MAX_SCAN_EXPOSURE_USD: z.coerce.number().min(0).optional().default(30),
  // Half-Kelly fraction for weather stake sizing. Kept independent of the OSINT
  // default because bracket model uncertainty is structurally larger and the side
  // bias (YES 11.5% vs NO 73.7%) argues for lighter sizing.
  WEATHER_KELLY_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.25),
  // Shrink the model win-prob toward the market price before Kelly sizing:
  //   sizingProb = w·modelProb + (1−w)·marketPrice.
  // Closed-bet calibration shows the weather model is overconfident (model ~0.65 →
  // realized ~0.52) and only ties the market as a forecaster, so Half-Kelly on the
  // raw model prob oversizes ~2×. Shrinking toward the (better-calibrated) market
  // price right-sizes the edge. Sign-invariant — never flips an entry to a skip,
  // only reduces stake. w=1.0 → no shrink (legacy); w=0.5 → halfway to market.
  // Range is (0,1]: w=0 would shrink fully to the market price (Kelly edge → 0 →
  // every entry skipped), which breaks the sign-invariance contract and is not a
  // sizing config — disable weather via WEATHER_SCANNER_ENABLED instead. Hence .gt(0).
  WEATHER_KELLY_SHRINK_WEIGHT: z.coerce.number().gt(0).max(1).optional().default(0.5),
  // --- WEATHER ENTRY PRICE OPTIMIZATION ---
  // Post-only GTC vs plain GTC for weather empty-book entries.
  //   true  → strict post-only; rejections drop straight to no_clob_book. Safer
  //           against overpay but yielded 0 fills for 13h on 2026-04-23 when the
  //           real book had resting orders the YES-book read didn't surface.
  //   false → plain GTC; crossing limits taker-fill at the existing ask (capped
  //           by our limit), residual rests as maker. Paired with WEATHER_MAX_ENTRY_PRICE
  //           this is strictly ≤ our cap, so "overpay" is bounded by that knob.
  WEATHER_MAKER_POST_ONLY: boolFromEnv.optional().default(false),
  // Aggressive price improvement: post at bestAsk * (1 - BPS/10000) so the maker
  // only fills when someone crosses *into* us at a meaningfully better price.
  // Still capped by fair value (modelProb) so we never post above what we think
  // the side is worth. Fill rate drops as this increases — 500 (5%) is a moderate
  // starting point; tune upward once fill rate on current ask minus 40bps is known.
  WEATHER_MAKER_DISCOUNT_BPS: z.coerce.number().min(0).max(5000).optional().default(500),
  // Absolute ceiling on weather empty-book post price. Binds independently of
  // fairValue (modelProb) and discountedAnchor (sideAsk*discount) — a high-conviction
  // NO bracket with modelProb=0.87 could otherwise post at ~0.85 and taker-fill at
  // whatever the resting ask is. With postOnly:false the limit IS the worst price
  // we pay, so this caps entry cost directly and lets us skip expensive entries
  // that will likely reprice lower within hours. 0 disables the cap. Values below
  // the book's tick size (typ 0.01) are unsupported — the tick-floor in
  // resolveMakerPrice would otherwise lift the post price above the cap; the
  // executor refuses to post in that case (maker_price_above_cap).
  WEATHER_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.65),
  // Conviction-proportional discount for weather entries on an EMPTY/ghost book.
  // Ghost books carry no real liquidity (only far-off rebate-farmer orders) and we
  // can't exit them, so we rest only at a value discount below the model fair value.
  // The discount scales WITH conviction: post price = modelFairValue * (1 - BPS/10000),
  // then ceiling'd by WEATHER_MAX_ENTRY_PRICE (and the pre-resolution-day early cap).
  // A NO the model values at 0.85 rests near the WEATHER_MAX_ENTRY_PRICE ceiling; a
  // NO worth 0.55 rests proportionally lower. This SUPERSEDES the legacy market-anchored
  // caps (WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE flat floor + WEATHER_MAX_SIGNAL_PRICE_DRIFT)
  // which pinned EVERY empty-book entry to roughly the same price regardless of
  // conviction, starving fills (high-conviction NO bets rested ~0.40 below fair value
  // and never filled). Set to 0 to disable conviction pricing and fall back to the
  // legacy flat-cap + signal-drift behaviour.
  WEATHER_EMPTY_BOOK_DISCOUNT_BPS: z.coerce.number().min(0).max(9000).optional().default(2000),
  // LEGACY empty-book ceiling. Active ONLY when WEATHER_EMPTY_BOOK_DISCOUNT_BPS=0
  // (conviction pricing disabled). A flat absolute cap on the empty-book post price:
  // binds on TOP of WEATHER_MAX_ENTRY_PRICE, caps the post (does not skip). It is
  // conviction-blind — the reason it was replaced by WEATHER_EMPTY_BOOK_DISCOUNT_BPS.
  // 0 disables.
  WEATHER_EMPTY_BOOK_MAX_ENTRY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.45),
  // Stricter entry-price ceiling for weather entries placed BEFORE the resolution day.
  // On resolution day the forecast is effectively locked in, so the normal
  // WEATHER_MAX_ENTRY_PRICE applies. For earlier entries the forecast can still drift
  // significantly (flip risk). Applies at the pre-execution skip gate (outcomePrice >
  // cap → entry_price_above_cap) and to the maker fairValue clamp. 0 disables.
  WEATHER_EARLY_ENTRY_MAX_PRICE: z.coerce.number().min(0).max(1).optional().default(0.50),
  // Conviction TAKER entry for weather (additive; OFF by default). The maker path
  // rests a discounted bid that adverse-selects: it fills only when sellers hit it
  // (price falling = losers), and high-conviction winners drift away from the bid
  // before it fills. When this gate is ON and a REAL-book weather bracket shows
  // (modelWin − ourSideAsk) ≥ WEATHER_TAKER_ENTRY_MIN_EDGE with ourSideAsk ≤
  // WEATHER_TAKER_ENTRY_MAX_PRICE, the executor CROSSES the spread (postOnly:false,
  // limit = min(MAX_PRICE, modelWin − MIN_EDGE)) to TAKE at the ask instead of
  // resting. Empty/ghost books (nothing to take) and bracket-opposite legs (maker
  // liquidity) are excluded → the maker path is byte-for-byte unchanged when the
  // gate is off or unmet. Backtest (779 brackets, 06-06→06-13): edge≥0.15 take →
  // 77% win, +11% net ROI; 0 divergence vs PM settlement on 24 held-to-resolution.
  WEATHER_TAKER_ENTRY_ENABLED: boolFromEnv.optional().default(false),
  // Minimum model edge (modelWin − ourSideAsk) required to take. The limit price is
  // floored at modelWin − this, so a fill always keeps at least this much edge.
  WEATHER_TAKER_ENTRY_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.15),
  // Hard price ceiling for taker entries — never pay above this for a share, even
  // with huge edge (no buying near-certainties for crumbs; bounds per-share loss).
  WEATHER_TAKER_ENTRY_MAX_PRICE: z.coerce.number().min(0).max(1).optional().default(0.80),
  // Daily circuit breaker (USD): total taker-entry stake reserved per UTC day. Once
  // hit, the gate falls back to the maker path. Bounds the blast radius of an
  // execution bug while the strategy is monitored live. 0 disables the breaker
  // (taker entries unbounded — NOT recommended).
  WEATHER_TAKER_ENTRY_MAX_DAILY_USD: z.coerce.number().min(0).optional().default(25),
  // LEGACY relative-to-quote ceiling for weather maker entries. Active ONLY when
  // WEATHER_EMPTY_BOOK_DISCOUNT_BPS=0 (conviction pricing disabled). It bounds the
  // post to within this much of the scanner's observed side quote (e.g. quote=0.44,
  // post≤0.52). That directly contradicts conviction pricing — the whole edge is
  // that the model disagrees with the stale ghost quote — so it is bypassed when
  // the conviction discount is active. 0 disables the guard. Default 0.08 means:
  // never post more than 8 cents above the side-relative price that generated the signal.
  WEATHER_MAX_SIGNAL_PRICE_DRIFT: z.coerce.number().min(0).max(1).optional().default(0.08),
  // Patient real-book entry: on markets with a live order book, post a GTC
  // limit order this many bps below the current side-ask instead of buying at
  // the ask. The order rests indefinitely (no taker fallback); re-posts on the
  // next scan cycle with a refreshed side-ask anchor if not yet filled.
  // 0 = use the global MAKER_PRICE_EDGE_BPS logic instead.
  WEATHER_REAL_BOOK_DISCOUNT_BPS: z.coerce.number().min(0).max(5000).optional().default(300),
  // Rest-above-cap: treat the weather entry-price caps as price CLAMPS instead of
  // participation filters. When enabled, a fresh weather entry whose market price
  // (signal.outcomePrice) exceeds the effective cap is NOT skipped with
  // entry_price_above_cap — the maker path posts a resting GTC clamped to the cap
  // instead (the posted price still never exceeds the cap; only eligibility
  // changes). Size-up top-ups keep the legacy skip. The market price being above
  // the cap is often noise on ghost books (0.99 rebate-asks) and on real books a
  // resting bid below market is free optionality — PROVIDED the revalidation pass
  // below cancels it when the model edge disappears (otherwise the bid fills
  // exactly when the forecast moves against the thesis).
  WEATHER_REST_ABOVE_CAP_ENABLED: boolFromEnv.optional().default(false),
  // Aggregate notional ceiling (USD) for the rest-above-cap resting pool: the sum
  // of price*size across unfilled restAboveCap maker orders. Resting orders deduct
  // nothing from bankroll and per-scan caps reset every scan, so without this cap
  // out-of-range bids accumulate unboundedly and can over-subscribe the bankroll
  // with CORRELATED fills (one regime shift collapses several city markets at
  // once). Bounds ONLY the out-of-range pool — in-range posts are not gated, so a
  // full lottery-ticket pool can never block normal entries. 0 = fail closed (no
  // rest-above-cap posts while the feature is enabled).
  WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD: z.coerce.number().min(0).optional().default(0),
  // Each scan, re-validate unfilled resting weather PRIMARY maker orders against
  // the fresh model fair value and cancel any whose side-FV has dropped below the
  // posted price (the bid is now value-negative at our own price). Bracket legs
  // are exempt — they intentionally rest value-negative as the pairing leg.
  // Closes the gap that forecast invalidation only covers HELD positions, which
  // becomes the dominant risk once rest-above-cap widens the resting pool.
  // ALSO arms the post-resolution sweep: primaries whose city-local target day
  // has ended (isWeatherOrderPastResolution — daily high locked, can no longer
  // fill) are confirm-cancelled and their key deleted, regardless of whether
  // the market is still in the current scan universe, even on zero-opportunity
  // scans (Gamma outage). Time-expiry no longer cancels a weather maker: it is
  // held resting to preserve CLOB queue priority. Consequence: a restAboveCap
  // post consumes WEATHER_REST_ABOVE_CAP_MAX_NOTIONAL_USD pool notional until
  // resolution (the full day), not the old ~MAKER_EMPTY_BOOK_MAX_WAIT_MS window
  // — raise the cap if a heavy day starves new posts.
  WEATHER_RESTING_REVALIDATION_ENABLED: boolFromEnv.optional().default(false),
  // Bracket-maker strategy: when enabled, each primary weather GTC maker order is
  // paired with a simultaneous GTC on the opposite side at a wider discount. Both
  // orders rest until one fills; the other expires worthless at resolution. If both
  // fill the position is a guaranteed $1 payout (free arb). Off by default; dark.
  WEATHER_BRACKET_ENABLED: boolFromEnv.optional().default(false),
  // Discount (bps) applied to the opposite-side ask when posting the bracket leg.
  // Wider than WEATHER_REAL_BOOK_DISCOUNT_BPS since the bracket leg has no model
  // edge — we demand a bigger cushion to compensate.
  WEATHER_BRACKET_OPPOSITE_DISCOUNT_BPS: z.coerce.number().min(0).max(5000).optional().default(800),
  // Cancel unfilled bracket-opposite legs once their reversal path is gone.
  // A resting leg bid only fills when its side trades DOWN through it, and the
  // fill only loses when no reversal follows. While the day's temperature is
  // still being realized, a dip-through-then-reverse fill is a cheap win — and
  // with a held primary, ANY fill at price b with primaryCost+b < 1 locks a
  // guaranteed 1−primaryCost−b pair profit (the same trade weatherLockIn makes
  // deliberately). The fills worth preventing are the LATE ones: daily highs
  // are monotonic, so once the day's max is in, the outcome can no longer
  // reverse toward the leg and any further fill is near-pure overpay.
  WEATHER_BRACKET_CANCEL_ENABLED: boolFromEnv.optional().default(false),
  // Late-res-day arm: on the market's resolution day, cancel the leg once the
  // city-local hour reaches this (daily high effectively realized; default 18
  // = 6pm local). Legs stay live through the swingy part of the day — whipsaw
  // dips that fill the bid and reverse remain capturable. 0 cancels from the
  // start of res-day; 24 disables the arm.
  WEATHER_BRACKET_CANCEL_LOCAL_HOUR: z.coerce.number().int().min(0).max(24).optional().default(18),
  // Early-certainty arm: pre-res-day, cancel the leg when the PRIMARY side's
  // Gamma price ≥ this (outcome essentially settled a day early). Uses the
  // primary side, not the leg's own price — bracket legs rest on structurally
  // cheap tails, so the leg side is "cheap" from the moment it posts; the
  // primary side starts ≤ the entry cap and only reaches this threshold on a
  // genuine repricing. Note the residual trade-off: by this point an unfilled
  // bid sits below the collapsed side and a reversal moves price AWAY from it,
  // so keeping it mostly risks penny-overpay drift fills — but cancelling does
  // forfeit the rare deep dip-through-then-reverse ticket. 0 disables the arm.
  WEATHER_BRACKET_CANCEL_PRIMARY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.95),
  // Gate: skip NO bets on tail brackets ("or higher" / "or below") when the model's
  // own P(YES) exceeds this threshold. Prevents betting against the model's directional
  // call — edgeNo can be spuriously positive even when modelProb is 0.80+ for YES.
  WEATHER_THRESHOLD_NO_BET_MAX_PROB: z.coerce.number().min(0).max(1).optional().default(0.35),
  // Base-rate guard for tail NO bets: block when recent WU actuals show the YES
  // outcome has occurred at least WEATHER_BASE_RATE_NO_BLOCK_THRESHOLD fraction of
  // the last WEATHER_BASE_RATE_LOOKBACK_DAYS days. Requires at least
  // WEATHER_BASE_RATE_MIN_SAMPLES valid actuals rows to fire; gate is skipped
  // (fail open) below that threshold. Actuals are cached by the reconciler cron
  // with a 36h TTL; scanner reads Redis — no DB access at scan time.
  WEATHER_BASE_RATE_LOOKBACK_DAYS: z.coerce.number().int().min(1).optional().default(14),
  WEATHER_BASE_RATE_MIN_SAMPLES: z.coerce.number().int().min(1).optional().default(7),
  WEATHER_BASE_RATE_NO_BLOCK_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.70),
  // ── YES-bet quality gates (NO bets are unaffected) ────────────────────────
  // Interior brackets (e.g. "24°C", "74-75°F") require the temperature to land
  // in a 1-2° band. The market incorporates intraday data we can't access, so
  // interior YES bets win only 4-14% historically. Allow only tail brackets by
  // default. Set true to re-enable (for shadow analysis only).
  WEATHER_YES_ALLOW_INTERIOR_BRACKETS: boolFromEnv.optional().default(false),
  // Minimum market price for YES entries. Below 0.30 the market is pricing us
  // out with information we don't have; win rates collapse to <5%.
  WEATHER_YES_MIN_MARKET_PRICE: z.coerce.number().min(0).max(0.99).optional().default(0.30),
  // Minimum model probability for YES entries. Ensures directional confidence.
  WEATHER_YES_MIN_MODEL_PROB: z.coerce.number().min(0).max(1).optional().default(0.50),
  // ── NO-bet model-safety gates (2026-06-19: weather NO-bias calibration) ──────
  // The Gaussian bracket model systematically underpredicts YES for narrow
  // brackets, which inflates NO edge (see
  // docs/issues/weather-bracket-model-overconfidence-2026-06-19.md). These gates
  // curb the worst NO failure modes while the learned calibrator (PR2, shadow)
  // is built.
  //
  // YES→NO fallback: when a YES candidate is blocked by a YES quality gate but
  // the model preferred YES (edgeYes ≥ edgeNo > 0), the old code fell back to
  // betting NO — i.e. against the model's own preferred side. Default OFF: a
  // gated YES no longer becomes a NO bet; it is shadow-logged, not traded.
  WEATHER_YES_GATE_NO_FALLBACK_ENABLED: boolFromEnv.optional().default(false),
  // Source-specific σ inflation. Open-Meteo (international highs) is materially
  // underdispersed (realized MAE/σ ≈ 1.0 vs ≈ 0.80 for a calibrated normal), so
  // its bracket probabilities are over-confident. Multiply the Open-Meteo
  // forecast σ by this factor at ENTRY only (exit/invalidation σ unchanged).
  // 1.0 disables; HRRR-combined/NOAA are always left at 1.0.
  WEATHER_OPEN_METEO_STDDEV_MULTIPLIER: z.coerce.number().min(0.5).max(3).optional().default(1.25),
  // Interior-NO forecast margin (market-unit degrees). Block an interior/range
  // NO bet when the rounded corrected forecast lands within this many degrees of
  // the bracket (0 = only when it rounds into the bracket; 1 = also the
  // immediately-adjacent degree). Tail brackets keep using the base-rate gate.
  WEATHER_INTERIOR_NO_FORECAST_MARGIN: z.coerce.number().int().min(0).max(5).optional().default(1),
  // Ensemble modal-mass NO veto. For bounded-bracket NO candidates, fetch the
  // ensemble member distribution and block NO when the YES mass over the bracket
  // (widened by WEATHER_INTERIOR_NO_FORECAST_MARGIN) is at least this fraction.
  // Costs one extra ensemble-hourly fetch per event that has a surviving bounded
  // NO candidate. Set _ENABLED=false to skip the fetch entirely.
  WEATHER_MODAL_MASS_VETO_ENABLED: boolFromEnv.optional().default(true),
  WEATHER_INTERIOR_NO_MODAL_MASS_VETO: z.coerce.number().min(0).max(1).optional().default(0.50),
  // Restrict the modal-mass veto to resolution-day events only. Open-Meteo
  // heavily rate-limits the ensemble-hourly endpoint (429s), and live NO entries
  // concentrate on resolution day (taker path); res-day is also where member data
  // is most informative. Default true keeps the extra fetches few and the veto
  // functional where it matters. Set false to evaluate it on every horizon.
  WEATHER_MODAL_MASS_VETO_RES_DAY_ONLY: boolFromEnv.optional().default(true),
  // Calibration SHADOW pass (PR2a). When true, the scanner maps the raw model
  // P(YES) through the fitted reliability map (src/weather/data/calibrationParams.json)
  // and logs modelProbCalibrated/edgeCalibrated/tradeSideCalibrated alongside the
  // live raw decision. SHADOW-ONLY — it never changes the traded side/edge; acting
  // on the calibrated probability is a separate gate (PR2b). See
  // docs/issues/weather-bracket-model-overconfidence-2026-06-19.md.
  WEATHER_CALIBRATION_SHADOW_ENABLED: boolFromEnv.optional().default(true),
  // Calibration LIVE (PR2b). When true, brackets whose (shape|source) cohort is in
  // WEATHER_CALIBRATION_LIVE_COHORTS use the CALIBRATED probability for live side
  // selection + edge, and may take interior YES (subject to
  // WEATHER_CALIBRATION_YES_MIN_PRICE, default 0.15 — replaces the raw 0.30/0.50
  // gates; the cohort allow-list is the real guard). All other cohorts keep the
  // raw model + existing YES gates UNCHANGED.
  // Scoped per-cohort on purpose: backtests show calibration helps range/hrrr but
  // HURTS exact/open-meteo (over-lifts deep-confidence NO into losing YES), so it
  // must never drive decisions globally. Default false = no behavioural change.
  WEATHER_CALIBRATION_LIVE_ENABLED: boolFromEnv.optional().default(false),
  // Comma-separated `shape|source` cohorts allowed to act on calibration (and take
  // YES) when WEATHER_CALIBRATION_LIVE_ENABLED=true. shape ∈ exact|range|high_tail|
  // low_tail; source as logged (open-meteo|hrrr-combined|combined|noaa). Only the
  // cohorts validated +EV out-of-sample belong here.
  WEATHER_CALIBRATION_LIVE_COHORTS: z.string().optional().default('range|hrrr-combined'),
  // Market-price floor for calibrated YES on live cohorts. The raw YES gate's 0.30
  // floor would block the +EV calibrated YES (which sit ~0.15–0.30); the cohort
  // allow-list is the real protection against cheap-longshot YES, so live cohorts
  // use this lower floor + the calibrated-edge floor (WEATHER_MIN_EDGE) instead of
  // the raw 0.30 / 0.50-model-prob gates. Below this, books are too thin / the
  // market's intraday info dominates.
  WEATHER_CALIBRATION_YES_MIN_PRICE: z.coerce.number().min(0).max(0.99).optional().default(0.15),
  // --- WEATHER EXIT RULES (monitor) ---
  // Weather brackets resolve at end-of-day of their target date; realized hold
  // times run ~17–26h when entering 0–1 day out. Stale-exit (STALE_MIN_AGE_H_WEATHER=6h)
  // and divergence_closed are the primary exits. SL is a backstop for genuinely
  // wrong forecasts only — must be wide enough to survive bid-ask spread noise
  // (typ 3–5 cents on 0.5–0.7 priced outcomes) and forecast-update reprices.
  WEATHER_TAKE_PROFIT: z.coerce.number().min(0).optional().default(0.05),
  WEATHER_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.40),
  // Near-resolution loss-cut: exit a losing weather position when within
  // WEATHER_NEAR_RES_HOURS of endDate. By that point the actual temperature is
  // effectively known and the position will not recover.
  WEATHER_NEAR_RES_ENABLED: boolFromEnv.optional().default(false),
  WEATHER_NEAR_RES_HOURS: z.coerce.number().min(0).optional().default(3),
  // Minimum loss percentage required before the near-res gate fires (avoids
  // cutting near break-even positions on spread noise).
  WEATHER_NEAR_RES_MIN_LOSS_PCT: z.coerce.number().min(0).optional().default(10),
  // Max-lookahead gate: block weather entries into markets resolving more than
  // WEATHER_MAX_LOOKAHEAD_HOURS from now. Forecasts beyond 28h carry significantly
  // more uncertainty; 1-day-out bets only. Set to 0 to disable.
  WEATHER_MAX_LOOKAHEAD_HOURS: z.coerce.number().min(0).optional().default(28),
  // Near-resolution entry gate: block new weather entries when the market resolves
  // within WEATHER_NEAR_RES_ENTRY_HOURS. By that point the overnight GFS forecast
  // is stale — intraday temperature tracking has already priced it in.
  // Ships enabled=true (pure entry guard; no position closures).
  WEATHER_NEAR_RES_ENTRY_ENABLED: boolFromEnv.optional().default(true),
  WEATHER_NEAR_RES_ENTRY_HOURS: z.coerce.number().min(0).optional().default(10),
  // Market-disagreement gate: when the side price moves materially against the
  // weather thesis across scans but the model's win probability barely improves,
  // treat the "extra edge" as likely model error instead of free value.
  WEATHER_MARKET_DISAGREEMENT_ENABLED: boolFromEnv.optional().default(true),
  WEATHER_MARKET_DISAGREEMENT_MIN_ADVERSE_MOVE: z.coerce.number().min(0).max(1).optional().default(0.10),
  WEATHER_MARKET_DISAGREEMENT_MAX_WINPROB_IMPROVEMENT: z.coerce.number().min(0).max(1).optional().default(0.03),
  WEATHER_MARKET_DISAGREEMENT_TTL_S: z.coerce.number().int().min(60).optional().default(48 * 60 * 60),
  // ── PM-activity reconciler (src/cron/polymarketActivityReconciler.ts) ──
  // Every-15min cron that catches auto-redeemed wins our local redeemer missed:
  //   (a) positions closed via SL/TP leaving residual shares that auto-redeemed
  //       afterward (partial-fill pattern — PR #309 can't catch these because
  //       an outcome row already exists, marking the position closed-as-lost)
  //   (b) positions stuck at pending_settlement=true with no outcome row
  // Reads Polymarket's public /activity?type=REDEEM endpoint and reconciles
  // against the positions table by condition_id.
  PM_RECONCILER_ENABLED: boolFromEnv.optional().default(true),
  PM_RECONCILER_LIMIT: z.coerce.number().int().min(10).max(1000).optional().default(500),
  // Sports in-play arb SL/TP. Live game prices swing ±15–30% on single scoring
  // plays — the default 16% SL fires within one 5s monitor tick on normal
  // variance. 0.45 requires the position to be down 45% before cutting, which
  // only happens when the game situation has definitively turned against us.
  SPORTS_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.25),
  SPORTS_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.45),
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

  // ── Weather lock-in scanner ────────────────────────────────────────────────
  // Buys YES on open weather NO positions when YES drops to cheap (near-zero)
  // levels, guaranteeing a profit regardless of outcome. Bypasses the executor's
  // opposite-side gate since this is intentionally a hedge.
  // Ships dark. Set true to execute; false shadow-logs only.
  WEATHER_LOCK_IN_ENABLED: boolFromEnv.optional().default(false),
  // Maximum YES price at which to lock in. At 0.10 we buy YES ≤ 10¢/share.
  WEATHER_LOCK_IN_MAX_YES_PRICE: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Total cost ceiling: entry_no_price + yes_ask must be ≤ this to lock in.
  // At 0.92 we guarantee at least 8¢/share profit before fees.
  WEATHER_LOCK_IN_COST_CEILING: z.coerce.number().min(0).max(1).optional().default(0.92),

  // ── Weather forecast invalidation ─────────────────────────────────────────
  // Revalidates open weather positions against the latest forecast. Ships dark.
  // Phase 2: shadow logging (WEATHER_FORECAST_INVALIDATION_SHADOW_ENABLED=true).
  // Phase 3: size-up blocking (WEATHER_FORECAST_INVALIDATION_ENABLED=true).
  // Phase 4: live hedge (WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED=true).
  WEATHER_FORECAST_INVALIDATION_ENABLED: boolFromEnv.optional().default(false),
  WEATHER_FORECAST_INVALIDATION_SHADOW_ENABLED: boolFromEnv.optional().default(true),
  // Modal-inversion trigger: invalidate when the corrected forecast's central
  // estimate crosses the rounding boundary into (NO holds) or out of (YES holds)
  // our bracket — the same predicate the entry scanner uses to refuse interior-NO
  // bets. Catches inversions the held-prob drop misses when a wide stddev keeps the
  // continuous held-prob high while the modal outcome flips against us. OR'd with
  // the drop rule; only applies to bounded brackets (tails have an open side).
  WEATHER_FORECAST_INVALIDATION_MODAL_ENABLED: boolFromEnv.optional().default(true),
  // Debounce: modal inversion must persist this many consecutive scans before it
  // counts, so a forecast straddling a half-degree rounding boundary can't flap the
  // trigger on/off run-to-run. 1 = fire immediately (no debounce).
  WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS: z.coerce.number().int().min(1).optional().default(2),
  // Modal-inversion held-prob ceiling (guard A). A modal flip only counts as an
  // invalidation when the continuous held-prob has ALSO fallen to/below this. A wide
  // stddev can keep the held-prob high (e.g. 0.69) while the rounded central estimate
  // straddles a bracket boundary — a 0.1°C wobble flips 18.4↔18.6 — so a bare modal
  // flip there is noise, not a real inversion. Above this ceiling the model still
  // favours our side, so we ride. (Amsterdam 19°C NO, 2026-06-03: modal flipped at
  // held-prob 0.686 and NO still won at $1.) Set to 1 to disable the ceiling.
  WEATHER_FORECAST_INVALIDATION_MODAL_MAX_HELD_PROB: z.coerce.number().min(0).max(1).optional().default(0.55),
  // Held-side probability must fall by at least this much from entry to mark invalidated.
  WEATHER_FORECAST_INVALIDATION_MIN_DROP: z.coerce.number().min(0).max(1).optional().default(0.20),
  // Only mark invalidated when current held-side probability is below this (severity filter).
  WEATHER_FORECAST_INVALIDATION_MIN_CURRENT_HELD_PROB: z.coerce.number().min(0).max(1).optional().default(0.50),
  // TTL (seconds) for the Redis invalidation key that blocks size-ups (6 hours).
  WEATHER_FORECAST_INVALIDATION_TTL_S: z.coerce.number().int().min(1).optional().default(21600),
  // Hedge: buy opposite token when the position is invalidated and opposite is cheap.
  WEATHER_FORECAST_INVALIDATION_HEDGE_ENABLED: boolFromEnv.optional().default(false),
  // Maximum price to pay for the opposite (hedge) token.
  WEATHER_FORECAST_INVALIDATION_MAX_HEDGE_PRICE: z.coerce.number().min(0).max(1).optional().default(0.25),
  // entry_price + opposite_ask must be ≤ this to hedge.
  WEATHER_FORECAST_INVALIDATION_MAX_TOTAL_COST: z.coerce.number().min(0).max(2).optional().default(1.05),
  // Minimum fill ratio for hedge order — below this, no marker set and will retry.
  WEATHER_FORECAST_INVALIDATION_MIN_FILL_RATIO: z.coerce.number().min(0).max(1).optional().default(0.90),
  // Phase 5: live exit. On resolution day, when a position is invalidated and the
  // opposite (hedge) book is unavailable/too expensive, sell the held side at the
  // bid instead of only notifying. Gated to resolution day (event.targetDate ===
  // cityLocalDate(tz)) so a pre-resolution invalidation still lets the position
  // ride in case the forecast swings back before the day is reached. Ships dark.
  WEATHER_FORECAST_INVALIDATION_EXIT_ENABLED: boolFromEnv.optional().default(false),
  // Absolute floor on the held-side best bid: never market-sell into an air-pocket
  // book below this price (e.g. a $0.01 liquidity-artifact bid on a weather token).
  WEATHER_FORECAST_INVALIDATION_MIN_EXIT_PRICE: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Max slippage below current model fair value tolerated on the exit: require
  // bestBid ≥ currentHeldProb − this. Caps how far below the model's held-side
  // value we'll dump; if the bid is worse, fall back to the manual-action notify.
  WEATHER_FORECAST_INVALIDATION_MAX_EXIT_SLIPPAGE: z.coerce.number().min(0).max(1).optional().default(0.15),
  // Floor anchoring for modal-inversion exits. The continuous held-prob is the number
  // the modal signal flags as untrustworthy — closed-bet calibration shows the model's
  // ~0.67 hold-prob realizes ~0.33 (σ wider than the 1°C bracket → overconfident NO).
  // When true, modal-only invalidation exits skip the held-prob slippage floor and use
  // just the absolute MIN_EXIT_PRICE floor (market-anchored — sell at the best bid).
  WEATHER_FORECAST_INVALIDATION_MODAL_MARKET_FLOOR: boolFromEnv.optional().default(true),
  // Same, for held_prob_drop / both invalidations. The drop can land the model at a
  // "low" held-prob (e.g. 0.37) while the market prices the side far lower (e.g. a 0.01
  // bid) — they do NOT always agree, so a slippage floor anchored to the model blocks
  // exiting at the better-calibrated market price. When true, drop/both exits also use
  // just the absolute MIN_EXIT_PRICE floor. (Market beats model as a forecaster — see
  // the calibration finding — so anchoring exits to the model is the wrong default.)
  WEATHER_FORECAST_INVALIDATION_DROP_MARKET_FLOOR: boolFromEnv.optional().default(true),

  // ── Weather forecast resilience ────────────────────────────────────────────
  // Retries on transient Open-Meteo failures (5xx / network abort) per fetch.
  // 0 = single attempt. 429 is NEVER retried (already rate-limited). Threaded
  // through fetchForecast to the deterministic, ensemble, and HRRR fetchers.
  WEATHER_FORECAST_RETRY_COUNT: z.coerce.number().int().min(0).max(5).optional().default(2),
  // TTL for the Redis last-good forecast cache (weather:forecast_cache:<city>:<date>).
  // Written by the scanner and invalidation evaluator on every successful fetch;
  // read ONLY by the invalidation evaluator as a last resort when live fetches
  // fail — on a 30-min cadence a ≤3h-stale forecast beats a blind skip
  // (2026-06-04 Open-Meteo outage blinded the entire invalidation sweep).
  WEATHER_FORECAST_CACHE_TTL_S: z.coerce.number().int().min(60).optional().default(10_800),
  // One loud Telegram alert when a scan's forecast failure rate is high, instead
  // of silent noForecast inflation in the scan summary.
  WEATHER_OUTAGE_ALERT_ENABLED: boolFromEnv.optional().default(true),
  // Alert when noForecast / attempted exceeds this fraction (attempted ≥ 5).
  WEATHER_OUTAGE_FAIL_RATE: z.coerce.number().min(0).max(1).optional().default(0.5),
  // Suppress repeat outage alerts within this window (SET NX EX dedupe).
  WEATHER_OUTAGE_ALERT_DEDUP_TTL_S: z.coerce.number().int().min(60).optional().default(14_400),

  // ── Weather oracle scanner ─────────────────────────────────────────────────
  // After the reconciler writes WU actuals for yesterday, scans active weather
  // markets for brackets whose outcome is now known but price hasn't fully
  // adjusted. Buys the winning side. Ships dark.
  WEATHER_ORACLE_ENABLED: boolFromEnv.optional().default(false),
  // Maximum price to pay for the winning-side token. Above this, the discount
  // is too small to overcome spread + fees (1 - price < MIN_DISCOUNT).
  WEATHER_ORACLE_MAX_BUY_PRICE: z.coerce.number().min(0).max(1).optional().default(0.93),
  // Minimum required discount from $1 payout. Skip if (1 - winningAsk) < this.
  WEATHER_ORACLE_MIN_DISCOUNT: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Hard stake cap per oracle trade (USD).
  WEATHER_ORACLE_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(20),

  // ── Weather drift strategy ─────────────────────────────────────────────────
  // Shadow-log thesis drift states for open weather positions each scan cycle.
  // Ships dark. Flip true to start collecting shadow data before enabling actions.
  WEATHER_DRIFT_SHADOW_ENABLED: boolFromEnv.optional().default(false),
  // Held-prob drop threshold to classify a position as 'watch' — earliest warning.
  // Does not block entries or cancel orders on its own.
  WEATHER_DRIFT_WATCH_DROP: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Held-prob drop threshold to classify a position as 'thesis_weakened'.
  // Matches WEATHER_FORECAST_INVALIDATION_MIN_DROP so positions reach
  // 'thesis_weakened' before the hard invalidation trigger fires.
  WEATHER_DRIFT_THESIS_WEAKENED_DROP: z.coerce.number().min(0).max(1).optional().default(0.20),
  // Enable exact-bracket modal classification. When true, interior brackets
  // (low !== null && high !== null) are classified as 'modal_against' when the
  // corrected forecast rounds against the held side. Default true because
  // exact-bracket modal rounding is the primary missing signal for this scanner.
  WEATHER_DRIFT_EXACT_ENABLED: boolFromEnv.optional().default(true),
  // Half-degree buffer around bracket rounding boundaries for early 'watch'
  // escalation. Promotes 'stable' to 'watch' when the corrected forecast is
  // within this many degrees of a rounding threshold — catches positions on the
  // verge of modal inversion before it happens.
  WEATHER_DRIFT_EXACT_BOUNDARY_BUFFER: z.coerce.number().min(0).max(2).optional().default(0.35),
  // Number of consecutive modal-against scans required before classifying a
  // position as actionable for cancellation/notification (modal_against gate).
  WEATHER_DRIFT_EXACT_MODAL_MIN_RUNS: z.coerce.number().int().min(1).optional().default(1),
  // Number of consecutive modal-against scans required before a modal_against
  // EXIT (or flip) fires. This is the SOLE modal-exit gate: a modal_against exit
  // fires only when the corrected forecast has rounded against the held thesis on
  // this many consecutive scans — there is NO held-prob / steep-drop fast-track.
  // A still-high-conviction position straddling a rounding boundary (a 0.1° wobble
  // from flipping back) is therefore never dumped on a single scan (2026-06-13
  // London 5084: sold at modal streak 1 on an 8.6% drop at 76.9% held).
  // Notifications/cancels still fire at streak 1 (the notification gate is
  // WEATHER_FORECAST_INVALIDATION_MODAL_MIN_RUNS); only the EXIT waits for N runs.
  WEATHER_DRIFT_EXACT_EXIT_MODAL_MIN_RUNS: z.coerce.number().int().min(1).optional().default(2),

  // ── Held-prob "fresh decline below floor" exit ──────────────────────────────
  // Resolution-day exit for a position whose model held-prob — having once been at
  // or above WEATHER_DRIFT_HELD_PROB_EXIT_FLOOR ("peaked") — makes a genuine
  // scan-over-scan decline (≥ WEATHER_DRIFT_FRESH_DECLINE_MIN_DELTA vs the prior
  // scan) that takes it BELOW the floor. Replaces the old single-scan severe-drop
  // exit: a still-confident (≥ floor) position is never sold on a drop alone, and
  // a static/stale drop never re-fires (only an actively-falling position exits).
  // A position ENTERED below the floor never qualifies (never peaked), so
  // low-conviction entries aren't dumped on the first downtick. Gated to
  // resolution day, like the other forecast exits.
  WEATHER_DRIFT_HELD_PROB_EXIT_ENABLED: boolFromEnv.optional().default(true),
  WEATHER_DRIFT_HELD_PROB_EXIT_FLOOR: z.coerce.number().min(0).max(1).optional().default(0.75),
  WEATHER_DRIFT_FRESH_DECLINE_MIN_DELTA: z.coerce.number().min(0).max(1).optional().default(0.02),

  // ── Weather drift live actions (Phase 3+4) ──────────────────────────────
  // Master live gate. Shadow logging (WEATHER_DRIFT_SHADOW_ENABLED) is
  // independent — both can be on simultaneously. When this is false all live
  // actions are suppressed but notifications still fire so the user stays
  // informed.
  WEATHER_DRIFT_ENABLED: boolFromEnv.optional().default(false),
  // Write the forecast_invalidated key (size-up blocker shared with the
  // invalidation scanner) when drift classifies a position as actionable.
  WEATHER_DRIFT_BLOCK_SIZE_UP_ENABLED: boolFromEnv.optional().default(false),
  // Cancel a resting maker order for a modal_against position with streak
  // satisfied. One-time per position (idempotency marker).
  WEATHER_DRIFT_CANCEL_RESTING_ENABLED: boolFromEnv.optional().default(false),
  // Attempt a resolution-day market-floor sell for actionable positions.
  WEATHER_DRIFT_EXIT_ENABLED: boolFromEnv.optional().default(false),
  // Held-prob drop at which a thesis_weakened position is considered actionable.
  // Deliberately higher than WEATHER_DRIFT_THESIS_WEAKENED_DROP so only severe
  // drift triggers live actions — recovery is unlikely beyond this point.
  WEATHER_DRIFT_SEVERE_DROP: z.coerce.number().min(0).max(1).optional().default(0.30),
  // Minimum best-bid required to proceed with a drift exit sell.
  WEATHER_DRIFT_EXIT_MIN_BID: z.coerce.number().min(0).max(1).optional().default(0.10),
  // Maximum slippage allowed relative to currentHeldProb when not in market-floor
  // mode. Drift exits always use market-floor mode; kept for future path variants.
  WEATHER_DRIFT_EXIT_MAX_SLIPPAGE: z.coerce.number().min(0).max(1).optional().default(0.15),
  // Fraction of sharesHeld that must be covered by bids at/above the exit floor.
  // 0.90 = exit when 90% of the position can fill without sweeping below floor.
  // Invalidation exits always require 1.0 (full coverage); this knob tunes drift only.
  WEATHER_DRIFT_EXIT_MIN_DEPTH_RATIO: z.coerce.number().min(0).max(1).optional().default(0.90),
  // Cooldown after a failed exit sell to prevent rapid retry storms.
  WEATHER_DRIFT_EXIT_COOLDOWN_S: z.coerce.number().int().min(0).optional().default(1800),
  // Dedup window for the actionable-state Telegram notification. Same state on
  // the same position will not re-notify within this window; state escalations
  // (e.g. thesis_weakened → modal_against) use different keys and re-notify.
  WEATHER_DRIFT_NOTIFY_DEDUP_S: z.coerce.number().int().min(0).optional().default(3600),

  // Market-adverse detection for open weather positions.
  // Fires when the CLOB bid for the held side has moved strongly against us,
  // even when the ensemble forecast hasn't shifted (the "model right, market wrong"
  // or "model wrong throughout" case).
  //
  // Tier 1 (exit, resolution-day only): marketDrop ≥ DROP_EXIT + model drop ≥ SEVERE_DROP.
  // Tier 2 (notify + optional res-day exit): marketDrop ≥ DROP_NOTIFY + modelMarketGap ≥ DIVERGENCE.
  //
  // marketDrop = (entryPrice − currentHeldBid) / entryPrice
  // modelMarketGap = currentHeldProb − currentHeldBid
  //
  // DROP_EXIT must be ≤ DROP_NOTIFY to avoid a gap where neither tier fires.
  WEATHER_DRIFT_MARKET_ADVERSE_DROP_EXIT: z.coerce.number().min(0).max(1).optional().default(0.20),
  WEATHER_DRIFT_MARKET_ADVERSE_DROP_NOTIFY: z.coerce.number().min(0).max(1).optional().default(0.25),
  WEATHER_DRIFT_MARKET_DIVERGENCE_NOTIFY: z.coerce.number().min(0).max(1).optional().default(0.55),
  // When true, Tier 2 also triggers an exit on resolution day (not just a notification).
  // On resolution day the model cannot reprice intraday, so the market divergence signal
  // is treated as authoritative even without model-drop confirmation.
  WEATHER_DRIFT_TIER2_EXIT_ON_RES_DAY: boolFromEnv.optional().default(false),

  // Bid velocity exit: if the held-side bid drops by more than BID_VELOCITY_THRESHOLD
  // (relative) in a single 30-min scan cycle on resolution day, exit immediately.
  // Catches rapid single-scan collapses that reach Tier thresholds too late.
  WEATHER_DRIFT_BID_VELOCITY_EXIT_ENABLED: boolFromEnv.optional().default(false),
  WEATHER_DRIFT_BID_VELOCITY_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.40),
  // Accuracy gate for market-PRICE exits (market_against / bid_velocity): the
  // auto-exit only fires once the held-side best bid has collapsed to/below this
  // near-dead floor. In the moderate whipsaw zone (bid ~0.2–0.4) the CLOB bid is
  // efficiently priced — realized win-rate ≈ bid — so exiting captures ~fair value
  // in EV but repeatedly sold positions that bounced back to win. 10-day backtest
  // (2026-06-15): bid ≤0.15 was 100% losers (salvage real), while bid 0.20–0.36
  // held all 4 false-positive winners (Paris/Houston etc.). Model/oracle conviction
  // is NOT used as the gate — both proved miscalibrated. Notifications still fire on
  // moderate moves; ONLY the auto-exit is gated. Does not affect modal_against,
  // thesis_weakened, oracle_impossible, or oracle_likely_against exits.
  WEATHER_DRIFT_MARKET_EXIT_MAX_BID: z.coerce.number().min(0).max(1).optional().default(0.15),

  // ── Weather drift Phase 5: live observation + contradiction audit ───────────
  // Master gate for fetching live intraday observations for open weather
  // positions. Shadow rows are always written when a fetch succeeds; live oracle
  // state transitions (oracle_impossible / oracle_confirmed) also require
  // WEATHER_DRIFT_ENABLED.
  WEATHER_DRIFT_LIVE_OBS_ENABLED: boolFromEnv.optional().default(false),
  // Per-source live observation enable flags. All three require
  // WEATHER_DRIFT_LIVE_OBS_ENABLED to be true.
  WEATHER_DRIFT_WU_LIVE_ENABLED: boolFromEnv.optional().default(false),
  WEATHER_DRIFT_METAR_LIVE_ENABLED: boolFromEnv.optional().default(false),
  WEATHER_DRIFT_HKO_LIVE_ENABLED: boolFromEnv.optional().default(false),
  // Maximum age (minutes) of a cached live observation before re-fetching.
  WEATHER_DRIFT_LIVE_OBS_MAX_AGE_MIN: z.coerce.number().int().min(1).optional().default(30),
  // Enable market/oracle contradiction audit rows. Shadow-only; no live action.
  WEATHER_DRIFT_CONTRADICTION_AUDIT_ENABLED: boolFromEnv.optional().default(true),
  // Minimum model-market gap for a market_contradicts_model row.
  // currentHeldProb − currentHeldBid must exceed this to qualify.
  WEATHER_DRIFT_CONTRADICTION_MIN_MODEL_MARKET_GAP: z.coerce.number().min(0).max(1).optional().default(0.55),
  // Held-side bid at or below which the position is treated as effectively dead
  // for contradiction and flip classification. Below this, currentHeldBid ≈ 0.
  WEATHER_DRIFT_MARKET_DEAD_BID: z.coerce.number().min(0).max(1).optional().default(0.05),

  // ── Weather drift Phase 6: flip strategy ─────────────────────────────────
  // Enable live flip execution (exit held side + taker buy opposite). Ships dark.
  // Requires WEATHER_DRIFT_ENABLED. Only confirmed_flip and (when
  // WEATHER_DRIFT_FLIP_CONFIRMED_ONLY=false) market_oracle_flip are eligible.
  // audit_only and forecast_flip never auto-execute.
  WEATHER_DRIFT_FLIP_ENABLED: boolFromEnv.optional().default(false),
  // When true, only confirmed_flip (live oracle proves winner/loser) is eligible.
  // When false, market_oracle_flip is also eligible. Default true for safety.
  WEATHER_DRIFT_FLIP_CONFIRMED_ONLY: boolFromEnv.optional().default(true),
  // Minimum edge (basis points) required: oppositeModelFairValue − oppositeAsk ≥ bps/10000.
  WEATHER_DRIFT_FLIP_MIN_EDGE_BPS: z.coerce.number().int().min(0).optional().default(500),
  // Maximum ask price for the opposite side to consider a flip buy.
  WEATHER_DRIFT_FLIP_MAX_OPPOSITE_PRICE: z.coerce.number().min(0).max(1).optional().default(0.95),
  // Maximum total notional (USD) of flip buys for a single city in one scan cycle.
  WEATHER_DRIFT_FLIP_MAX_CITY_NOTIONAL: z.coerce.number().min(0).optional().default(25),
  // Maximum total notional (USD) across all flip buys in one scan cycle.
  WEATHER_DRIFT_FLIP_MAX_SCAN_NOTIONAL: z.coerce.number().min(0).optional().default(50),

  // ── Conditional weather oracle (Phases A-C) ───────────────────────────────
  // Phase A: compute conditionalHeldProbability + shadow-log only. No actions.
  WEATHER_COND_ORACLE_ENABLED: boolFromEnv.optional().default(false),
  // Phase B: enable bid-vs-fair-value soft exit rule.
  WEATHER_COND_ORACLE_SOFT_EXIT_ENABLED: boolFromEnv.optional().default(false),
  // Phase B: cancel resting makers when fresh conditionalSideProb fails posted price.
  WEATHER_COND_ORACLE_RESTING_CANCEL_ENABLED: boolFromEnv.optional().default(false),
  // Phase B: suppress market-only exits when conditionalP - bid ≥ gap (hold guard).
  WEATHER_COND_ORACLE_HOLD_GUARD_ENABLED: boolFromEnv.optional().default(false),
  // Gap (in probability) between conditionalP and bid required to veto a market-only exit.
  WEATHER_COND_ORACLE_HOLD_GUARD_GAP: z.coerce.number().min(0).max(1).optional().default(0.30),
  // Exit fires when bestBid > conditionalHeldProb + this buffer (covers fees + estimator noise).
  WEATHER_COND_ORACLE_EXIT_COST_BUFFER: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Maximum observation age (minutes) for a conditional estimate to be action-eligible.
  WEATHER_COND_ORACLE_MAX_OBS_AGE_MIN: z.coerce.number().int().min(1).optional().default(90),
  // Spread inflation multiplier for ensemble member trajectories (>1 = wider spread).
  WEATHER_COND_ORACLE_SPREAD_INFLATION: z.coerce.number().min(0.5).max(5).optional().default(1.0),
  // Minimum ensemble members required to use the ensemble estimator (fall back to climo below).
  WEATHER_COND_ORACLE_MIN_MEMBERS: z.coerce.number().int().min(1).optional().default(10),
  // Enable the climatological exceedance table as fallback/clamp for the ensemble estimator.
  WEATHER_COND_ORACLE_CLIMO_FALLBACK_ENABLED: boolFromEnv.optional().default(true),
  // If ensemble and climo estimators disagree by more than this, use the conservative value.
  WEATHER_COND_ORACLE_ESTIMATOR_MAX_GAP: z.coerce.number().min(0).max(1).optional().default(0.25),
  // Phase C: replace static flip fair value with 1 - conditionalHeldProb for non-confirmed flips.
  WEATHER_COND_ORACLE_FLIP_FAIR_VALUE_ENABLED: boolFromEnv.optional().default(false),
  // Phase C: write weather_nowcast_entry shadow rows (live execution dark until explicitly enabled).
  WEATHER_COND_ORACLE_NOWCAST_ENTRY_ENABLED: boolFromEnv.optional().default(false),
  // Minimum edge (probability) for a nowcast signal to set meetsEdge=true. Shadow
  // rows are written for EVERY evaluated res-day opportunity regardless; this knob
  // only marks which would qualify as entries. Edge is measured vs the executable
  // CLOB ask when a resting ask exists (edgeBasis='ask'), else vs Gamma outcomePrice.
  WEATHER_COND_ORACLE_NOWCAST_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
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

  // HL momentum: 4h EMA fast period must be shorter than slow period
  if (cfg.HL_MOMENTUM_4H_EMA_FAST >= cfg.HL_MOMENTUM_4H_EMA_SLOW) {
    throw new Error('HL_MOMENTUM_4H_EMA_FAST must be less than HL_MOMENTUM_4H_EMA_SLOW');
  }

  // HL momentum meme ATR: floor must be ≤ ceiling so the clamp interval is non-empty.
  if (cfg.HL_MOMENTUM_MEME_SL_FLOOR_PCT > cfg.HL_MOMENTUM_MEME_SL_CEIL_PCT) {
    throw new Error('HL_MOMENTUM_MEME_SL_FLOOR_PCT must be ≤ HL_MOMENTUM_MEME_SL_CEIL_PCT');
  }

  // HL momentum non-meme ATR: same non-empty clamp interval requirement.
  if (cfg.HL_MOMENTUM_SL_FLOOR_PCT > cfg.HL_MOMENTUM_SL_CEIL_PCT) {
    throw new Error('HL_MOMENTUM_SL_FLOOR_PCT must be ≤ HL_MOMENTUM_SL_CEIL_PCT');
  }

  // HL funding scanner: exit APR must be below entry APR (or the exit condition fires immediately).
  if (cfg.HL_FUNDING_SCANNER_EXIT_APR_THRESHOLD >= cfg.HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD) {
    throw new Error('HL_FUNDING_SCANNER_EXIT_APR_THRESHOLD must be less than HL_FUNDING_SCANNER_ENTRY_APR_THRESHOLD');
  }
  // Bulk cache TTL must be ≤ poll interval (cache refreshes at least once per scan).
  if (cfg.HL_FUNDING_SCANNER_BULK_CTX_TTL_SEC > cfg.HL_FUNDING_SCANNER_POLL_INTERVAL_SEC) {
    throw new Error('HL_FUNDING_SCANNER_BULK_CTX_TTL_SEC must be ≤ HL_FUNDING_SCANNER_POLL_INTERVAL_SEC');
  }

  // Oracle-lag price band must be non-inverted.
  if (cfg.ORACLE_LAG_MIN_ENTRY_PRICE >= cfg.ORACLE_LAG_MAX_ENTRY_PRICE) {
    throw new Error('ORACLE_LAG_MIN_ENTRY_PRICE must be less than ORACLE_LAG_MAX_ENTRY_PRICE');
  }

  // Oracle-lag time window must be non-inverted (min <= max).
  if (cfg.ORACLE_LAG_MIN_TIME_LEFT_MIN > cfg.ORACLE_LAG_MAX_TIME_LEFT_MIN) {
    throw new Error('ORACLE_LAG_MAX_TIME_LEFT_MIN must be >= ORACLE_LAG_MIN_TIME_LEFT_MIN');
  }

  // Near-resolution exit threshold must be strictly below the entry floor so
  // a freshly entered position isn't immediately triggered for exit.
  if (cfg.ORACLE_LAG_EXIT_NEAR_RES_MIN_LEFT_MIN >= cfg.ORACLE_LAG_MIN_TIME_LEFT_MIN) {
    throw new Error(
      'ORACLE_LAG_EXIT_NEAR_RES_MIN_LEFT_MIN must be < ORACLE_LAG_MIN_TIME_LEFT_MIN ' +
        `(currently ${cfg.ORACLE_LAG_EXIT_NEAR_RES_MIN_LEFT_MIN} >= ${cfg.ORACLE_LAG_MIN_TIME_LEFT_MIN})`,
    );
  }

  // Weather bias trust tiers must be non-inverted: full correction (trusted)
  // kicks in at n ≥ trusted, weak-band at min ≤ n < trusted. If trusted < min
  // the weak band collapses and 'full' can apply on smaller samples than 'weak'
  // would have — defeating the de-risking goal.
  if (cfg.WEATHER_BIAS_TRUSTED_SAMPLES < cfg.WEATHER_BIAS_MIN_SAMPLES) {
    throw new Error(
      'WEATHER_BIAS_TRUSTED_SAMPLES must be >= WEATHER_BIAS_MIN_SAMPLES ' +
        `(currently ${cfg.WEATHER_BIAS_TRUSTED_SAMPLES} < ${cfg.WEATHER_BIAS_MIN_SAMPLES})`,
    );
  }

  // All cross-validations passed — cache only a valid config.
  _config = cfg;
  return _config;
}
