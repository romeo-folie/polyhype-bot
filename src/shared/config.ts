/**
 * Environment configuration.
 * Validate and centralise all env reads here.
 * Throws at startup if required variables are missing.
 */

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
  CLOB_FALLBACK_ENABLED: z.string().optional().default('true').transform(v => !['false', '0'].includes(v.trim().toLowerCase())),
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
  // Minimum NET edge (after ~2% per-leg Polymarket fees) to enter an arb trade.
  // Raised from 0.04 to 0.05 to ensure profit after fees.
  ARB_MIN_EDGE: z.coerce.number().min(0).max(1).optional().default(0.05),
  ARB_MAX_STAKE_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.05),
  // Polymarket taker fee rate per trade (~2% default). Configurable for fee tier changes.
  ARB_FEE_RATE: z.coerce.number().min(0).max(1).optional().default(0.02),
});

export type AppConfig = z.infer<typeof envSchema>;

let _config: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (_config) return _config;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.errors.map((e) => `  ${e.path.join('.')}: ${e.message}`).join('\n');
    throw new Error(`Configuration validation failed:\n${errors}`);
  }

  const cfg = parsed.data;

  // At least one LLM provider must be configured
  if (!cfg.OPENAI_API_KEY && !cfg.GEMINI_API_KEY) {
    throw new Error('At least one of OPENAI_API_KEY or GEMINI_API_KEY must be set');
  }

  _config = cfg;

  // Cross-validate CLOB-related config
  if (cfg.CLOB_FALLBACK_ENABLED) {
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

  return _config;
}
