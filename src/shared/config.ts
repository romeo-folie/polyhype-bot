/**
 * Environment configuration.
 * Validate and centralise all env reads here.
 * Throws at startup if required variables are missing.
 */

import 'dotenv/config';
import process from 'node:process';
import { z } from 'zod';

const envSchema = z.object({
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  SIMMER_API_KEY: z.string().min(1, 'SIMMER_API_KEY is required'),

  // LLM — at least one must be set (validated below)
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Wallet / direct CLOB execution
  POLYGON_WALLET_PRIVATE_KEY: z.string().optional(),
  POLYMARKET_FUNDER_ADDRESS: z.string().optional(),
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).optional().default(0),
  CLOB_FALLBACK_ENABLED: z.string().optional().default('true')
    .refine((v: string) => ['true', 'false', '1', '0'].includes(v.trim().toLowerCase()), {
      message: "CLOB_FALLBACK_ENABLED must be 'true', 'false', '1', or '0'",
    })
    .transform((v: string) => !['false', '0'].includes(v.trim().toLowerCase())),
  CLOB_ORDER_TYPE: z.enum(['FOK', 'FAK']).optional().default('FAK'),

  // Model selection (optional — defaults to recommended fast/cheap models)
  OPENAI_MODEL: z.string().optional().default('gpt-4o-mini'),
  GEMINI_MODEL: z.string().optional().default('gemini-2.5-flash'),

  // Tuning knobs (all optional — defaults apply)
  LLM_PROVIDER: z.enum(['openai', 'gemini']).optional().default('openai'),
  URGENCY_THRESHOLD: z.coerce.number().int().min(1).max(10).optional().default(8),
  DIVERGENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.1),
  MAX_BET_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.1),
  TAKE_PROFIT_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.25),
  STOP_LOSS_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.30),
  REEVAL_ENABLED: z.coerce.boolean().optional().default(true),
  REEVAL_EDGE_FLOOR: z.coerce.number().min(0).max(1).optional().default(0.03),

  // WebSocket price feed
  WS_ENABLED: z.coerce.boolean().optional().default(true),

  // Spot price monitor (Phase 5)
  SPOT_MONITOR_ENABLED: z.coerce.boolean().optional().default(false),
  SPOT_MOVE_THRESHOLD: z.coerce.number().min(0).optional().default(3),
  SPOT_LOOKBACK_MINUTES: z.coerce.number().int().min(1).optional().default(5),
  SPOT_COOLDOWN_MINUTES: z.coerce.number().int().min(1).optional().default(30),
  SPOT_DIVERGENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.12),
  SPOT_CRYPTO_ASSETS: z.string().optional().default('bitcoin,ethereum'),
  SPOT_COMMODITY_ASSETS: z.string().optional().default('CL=F,GC=F'),

  // Arbitrage scanner (Phase: arb)
  ARB_ENABLED: z.coerce.boolean().optional().default(true),
  ARB_WORKER_ENABLED: z.coerce.boolean().optional().default(true),

  // Feeds
  BINANCE_WS_ENABLED: z.coerce.boolean().optional().default(true),
  BINANCE_SYMBOLS: z.string().optional().default('btcusdt,ethusdt,solusdt'),
  HELIUS_API_KEY: z.string().optional(),
  // Minimum NET edge (after ~2% per-leg Polymarket fees) to enter an arb trade.
  // Raised from 0.04 to 0.05 to ensure profit after fees.
  ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.05),
  ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Polymarket taker fee rate per trade (~2% default). Configurable for fee tier changes.
  ARB_FEE_RATE: z.coerce.number().min(0).max(1).optional().default(0.02),

  // Copytrade signals
  COPYTRADE_ENABLED: z.coerce.boolean().optional().default(false),
  COPYTRADE_WALLETS: z.string().optional().default(''),
  // Comma-separated category list. Examples: 'all', 'weather', 'weather,geopolitics'
  COPYTRADE_MARKET_SCOPE: z.string().optional().default('all').transform(
    (v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  ),
  COPYTRADE_SIZE_SCALE: z.coerce.number().min(0).optional().default(0.1),
  COPYTRADE_MAX_STAKE_USD: z.coerce.number().min(0).optional().default(25),
  COPYTRADE_MAX_SLIPPAGE_BPS: z.coerce.number().min(0).optional().default(200),
  COPYTRADE_MIN_TIME_TO_RESOLVE_HOURS: z.coerce.number().min(0).optional().default(6),
  COPYTRADE_MIN_LIQUIDITY: z.coerce.number().min(0).optional().default(1000),
  COPYTRADE_EXIT_MODE: z.enum(['mirror', 'rules']).optional().default('rules'),
  COPYTRADE_POLL_INTERVAL_MS: z.coerce.number().int().min(500).optional().default(2000),

  // Copytrade shortlist automation
  COPYTRADE_SHORTLIST_TIME_WINDOW: z.enum(['DAY', 'WEEK', 'MONTH', 'ALL']).optional().default('WEEK'),
  COPYTRADE_SHORTLIST_TOP_N: z.coerce.number().int().min(1).max(50).optional().default(5),
  COPYTRADE_SHORTLIST_MIN_PNL_USD: z.coerce.number().min(0).optional().default(10000),
  COPYTRADE_SHORTLIST_MIN_VOL_USD: z.coerce.number().min(0).optional().default(100000),
  COPYTRADE_SHORTLIST_AUTO_APPLY: z.coerce.boolean().optional().default(true),

  // --- CRYPTO FUTURES (Phase: futures) ---
  FUTURES_ENABLED: z.coerce.boolean().optional().default(false),
  // Hyperliquid credentials
  HYPERLIQUID_PRIVATE_KEY: z.string().optional(),
  HYPERLIQUID_AGENT_WALLET: z.string().optional(),
  HYPERLIQUID_TESTNET: z.coerce.boolean().optional().default(true),

  // Risk & Control
  FUTURES_GLOBAL_MAX_MARGIN_USD: z.coerce.number().min(0).optional().default(50),
  FUTURES_MAX_PER_TRADE_USD: z.coerce.number().min(0).optional().default(10),
  FUTURES_DEFAULT_LEVERAGE: z.coerce.number().int().min(1).max(50).optional().default(5),
  FUTURES_MAX_HOLD_HOURS: z.coerce.number().int().min(1).optional().default(4),
  // Notional-based SL/TP thresholds (percentage of margin used, NOT account equity).
  // At 5x leverage a 1.5% notional SL represents a 7.5% equity drawdown.
  // Use values relative to notional, not leverage-adjusted equity.
  FUTURES_STOP_LOSS_PCT: z.coerce.number().default(-1.5),
  FUTURES_TAKE_PROFIT_PCT: z.coerce.number().default(3.0),
  FUTURES_EXIT_ON_SIGNAL_FADE: z.coerce.boolean().optional().default(true),
  // Max slippage fraction for IoC market orders (e.g. 0.02 = 2%). Conservative default.
  FUTURES_IOC_SLIPPAGE: z.coerce.number().min(0.001).max(0.10).optional().default(0.02),
});

export type AppConfig = z.infer<typeof envSchema>;

let _config: AppConfig | null = null;

export function loadConfig(forceReload = false): AppConfig {
  if (_config && !forceReload) return _config;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.errors.map((e: z.ZodIssue) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  const cfg = parsed.data;

  // At least one LLM provider must be configured
  if (!cfg.OPENAI_API_KEY && !cfg.GEMINI_API_KEY) {
    throw new Error('At least one of OPENAI_API_KEY or GEMINI_API_KEY must be set');
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

  return _config;
}
