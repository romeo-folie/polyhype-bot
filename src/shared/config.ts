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

const envSchema = z.object({
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  SIMMER_API_KEY: z.string().min(1, 'SIMMER_API_KEY is required'),

  // Simmer — auto-redeem
  SIMMER_AUTO_REDEEM_ENABLED: z
    .string()
    .optional()
    .default('true')
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
  TELEGRAM_MONITOR_ENABLED: z.coerce.boolean().optional().default(false),
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

  // Execution microstructure controls
  EXECUTION_MODE: z.enum(['hybrid', 'maker', 'taker']).optional().default('hybrid'),
  MAKER_MAX_WAIT_MS: z.coerce.number().int().min(0).optional().default(20_000),
  MAKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).optional().default(1000),
  MAKER_PRICE_EDGE_BPS: z.coerce.number().min(0).optional().default(5),
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
  TAIL_TAKER_BLOCK: z.coerce.boolean().optional().default(true),
  TAIL_PRICE_THRESHOLD: z.coerce.number().min(0).max(0.5).optional().default(0.2),
  TAIL_TAKER_OVERRIDE_EDGE: z.coerce.number().min(0).max(1).optional().default(0.2),

  TAKE_PROFIT_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.25),
  STOP_LOSS_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.3),
  REEVAL_ENABLED: z.coerce.boolean().optional().default(true),
  REEVAL_EDGE_FLOOR: z.coerce.number().min(0).max(1).optional().default(0.03),
  REEVAL_ITM_SKIP_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.90),

  // WebSocket price feed
  WS_ENABLED: z.coerce.boolean().optional().default(true),

  // Spot price monitor (Phase 5)
  SPOT_MONITOR_ENABLED: z.coerce.boolean().optional().default(false),
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
  SPOT_COMMODITY_ASSETS: z.string().optional().default('CL=F,GC=F'),

  // Arbitrage scanner (Phase: arb)
  ARB_ENABLED: z.coerce.boolean().optional().default(true),
  ARB_WORKER_ENABLED: z.coerce.boolean().optional().default(true),
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
  BINANCE_WS_ENABLED: z.coerce.boolean().optional().default(true),
  BINANCE_SYMBOLS: z.string().optional().default('btcusdt,ethusdt,solusdt'),
  HELIUS_API_KEY: z.string().optional(),
  // Minimum NET edge (after ~2% per-leg Polymarket fees) to enter an arb trade.
  // Raised from 0.04 to 0.05 to ensure profit after fees.
  ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.05),
  ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Polymarket taker fee rate per trade (~2% default). Configurable for fee tier changes.
  ARB_FEE_RATE: z.coerce.number().min(0).max(1).optional().default(0.02),

  // Crypto latency arbitrage (Phase 7)
  CRYPTO_ARB_ENABLED: z.coerce.boolean().optional().default(true),
  CRYPTO_ARB_VOLATILITY_GATE_ENABLED: z.coerce.boolean().optional().default(true),
  // Mean absolute % price change per tick. Below floor = flat market, above ceiling = too spiky.
  // Defaults tuned for 1-min BTC ticks: floor 0.0003 (~0.03%), ceiling 0.008 (~0.8%)
  CRYPTO_ARB_MIN_VOLATILITY: z.coerce.number().min(0).optional().default(0.0003),
  CRYPTO_ARB_MAX_VOLATILITY: z.coerce.number().min(0).optional().default(0.008),
  CRYPTO_ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  CRYPTO_ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.03),
  CRYPTO_ARB_DEDUP_TTL_S: z.coerce.number().int().positive().optional().default(180),
  CRYPTO_ARB_MARKET_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(3600),

  // Up/Down Bitcoin market trading
  UPDOWN_ENABLED: z.coerce.boolean().optional().default(false),
  UPDOWN_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.08),
  // Minimum edge to allow entry on fee-enabled markets (executor fee gate).
  // Defaults to 0.04 (4%) — must exceed this to justify the ~2% taker fee.
  FEE_MARKET_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.04),

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
  SHORT_DURATION_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.10),
  SHORT_DURATION_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.15),
  COPYTRADE_STOP_LOSS: z.coerce.number().min(0).max(1).optional().default(0.40),
  COPYTRADE_TAKE_PROFIT: z.coerce.number().min(0).max(1).optional().default(0.50),
  MONITOR_HEAVY_INTERVAL_MIN: z.coerce.number().int().min(1).optional().default(5),

  // Phase 9 — Indicator confluence gate
  CONFLUENCE_GATE_ENABLED: z.coerce.boolean().optional().default(true),
  CRYPTO_ARB_MIN_CONFLUENCE_SCORE: z.coerce.number().int().min(0).max(3).optional().default(2),
  RSI_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  MACD_FAST: z.coerce.number().int().min(1).optional().default(12),
  MACD_SLOW: z.coerce.number().int().min(1).optional().default(26),
  MACD_SIGNAL: z.coerce.number().int().min(1).optional().default(9),
  STOCHASTIC_K_PERIOD: z.coerce.number().int().min(1).optional().default(14),
  STOCHASTIC_D_PERIOD: z.coerce.number().int().min(1).optional().default(3),

  // Session-aware threshold multipliers (Strategy 6)
  SESSION_THRESHOLD_ENABLED: z.coerce.boolean().optional().default(false),
  SESSION_MULTIPLIERS: z
    .string()
    .optional()
    .default('1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.0,1.3,1.3,1.3,1.3,1.3,1.5,1.5,1.5,1.5,1.2,1.2,1.2,1.2,0.8,0.8,0.8'),

  // Continuous improvement (Phase 8)
  CALIBRATION_ENABLED: z.coerce.boolean().optional().default(true),
  MIN_BET_USD: z.coerce.number().min(0).optional().default(5),
  CALIBRATION_MIN_SAMPLES: z.coerce.number().int().positive().optional().default(20),
  OUTCOME_HISTORY_DAYS: z.coerce.number().int().positive().optional().default(180),
  OUTCOME_MAX_PER_CATEGORY: z.coerce.number().int().positive().optional().default(500),
  CONTEXT_INJECTION_ENABLED: z.coerce.boolean().optional().default(true),
  CONTEXT_INJECTION_LIMIT: z.coerce.number().int().min(1).max(10).optional().default(5),

  // Redeemer guardrails
  REDEEMER_DUPLICATE_WINDOW_S: z.coerce
    .number()
    .int()
    .min(60)
    .optional()
    .default(30 * 24 * 3600),
  REDEEMER_DUST_THRESHOLD_USDC: z.coerce.number().min(0).optional().default(0.25),
  REDEEMER_FALLBACK_STALE_TTL_S: z.coerce.number().int().min(60).optional().default(21_600),

  // LLM rate reduction caches
  SCORER_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(86400),
  CONSENSUS_CACHE_ENABLED: z.coerce.boolean().optional().default(true),
  CONSENSUS_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(1800),
  RELEVANCE_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(3600),
  ENTITY_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(7200),
  SENTIMENT_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(3600),
  DEEPSEEK_PARSE_CACHE_TTL_S: z.coerce.number().int().positive().optional().default(86400),

  // Copytrade signals
  COPYTRADE_ENABLED: z.coerce.boolean().optional().default(false),
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
  COPYTRADE_SHORTLIST_AUTO_APPLY: z.coerce.boolean().optional().default(true),
  // vol/pnl ratio filter: systematic high-frequency traders have high vol relative to PnL.
  // Default 2.0 = must have traded at least 2x their PnL in volume (filters lucky one-offs).
  // Set to 0 to disable.
  COPYTRADE_SHORTLIST_MIN_VOL_PNL_RATIO: z.coerce.number().min(0).optional().default(2),

  // --- CRYPTO FUTURES (Phase: futures) ---
  FUTURES_ENABLED: z.coerce.boolean().optional().default(false),
  // When true: log HL orders instead of submitting them. Safe validation path.
  HL_DRY_RUN: z.coerce.boolean().optional().default(false),
  // Hyperliquid credentials
  HYPERLIQUID_PRIVATE_KEY: z.string().optional(),
  HYPERLIQUID_AGENT_WALLET: z.string().optional(),
  HYPERLIQUID_MAIN_WALLET: z.string().optional(),
  HYPERLIQUID_TESTNET: z.coerce.boolean().optional().default(false),

  // Risk & Control
  FUTURES_GLOBAL_MAX_MARGIN_USD: z.coerce.number().min(0).optional().default(200),
  FUTURES_MAX_PER_TRADE_USD: z.coerce.number().min(0).optional().default(10),
  FUTURES_DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(50).optional().default(5),
  FUTURES_MAX_HOLD_HOURS: z.coerce.number().int().min(1).optional().default(4),
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
  FUTURES_TRAILING_STOP_ENABLED: z.coerce.boolean().optional().default(true),
  FUTURES_TRAILING_ACTIVATION_PCT: z.coerce.number().min(0.1).optional().default(3.5),
  FUTURES_TRAILING_STOP_PCT: z.coerce.number().min(0.1).optional().default(1.5),
  FUTURES_EXIT_ON_SIGNAL_FADE: z.coerce.boolean().optional().default(true),
  // TA confluence gate for futures entries — requires RSI/MACD/Stochastic agreement before opening a position.
  FUTURES_CONFLUENCE_GATE_ENABLED: z.coerce.boolean().optional().default(true),
  FUTURES_MIN_CONFLUENCE_SCORE: z.coerce.number().int().min(0).max(3).optional().default(2),
  // Post-entry TA re-evaluation interval & minimum position age before re-eval kicks in.
  FUTURES_REEVAL_INTERVAL_S: z.coerce.number().int().min(10).optional().default(60),
  FUTURES_REEVAL_MIN_AGE_S: z.coerce.number().int().min(0).optional().default(120),
  // Max slippage fraction for IoC market orders (e.g. 0.02 = 2%). Conservative default.
  FUTURES_IOC_SLIPPAGE: z.coerce.number().min(0.001).max(0.1).optional().default(0.02),

  // Volatility-adjusted position sizing (Strategy 3)
  FUTURES_VOL_SIZING_ENABLED: z.coerce.boolean().optional().default(false),
  FUTURES_ATR_PERIOD: z.coerce.number().int().min(2).optional().default(14),
  FUTURES_ATR_BASELINE_PCT: z.coerce.number().min(0.01).optional().default(0.5),
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
