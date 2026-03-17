/**
 * Environment configuration.
 * Validate and centralise all env reads here.
 * Throws at startup if required variables are missing.
 */

import { z } from 'zod';

const envSchema = z.object({
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  SIMMER_SKILL_URL: z.string().url('SIMMER_SKILL_URL must be a valid URL'),
  SIMMER_API_KEY: z.string().min(1, 'SIMMER_API_KEY is required'),

  // LLM — at least one must be set (validated below)
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Wallet
  POLYGON_WALLET_PRIVATE_KEY: z.string().optional(),

  // Tuning knobs (all optional — defaults apply)
  LLM_PROVIDER: z.enum(['openai', 'gemini']).optional().default('openai'),
  URGENCY_THRESHOLD: z.coerce.number().int().min(1).max(10).optional().default(8),
  DIVERGENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.1),
  MAX_BET_FRACTION: z.coerce.number().min(0).max(1).optional().default(0.1),
  TAKE_PROFIT_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.25),
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
  return _config;
}
