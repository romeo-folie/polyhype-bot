/**
 * Environment variable validation.
 * Call `validateEnv()` at the start of each entry point to fail fast with
 * a descriptive message if a required variable is missing or invalid.
 */

/** Required vars shared across all entry points. */
const SHARED_REQUIRED = ['REDIS_URL'] as const;

/** Required vars for the ingestion / scoring path. */
const INGEST_REQUIRED = ['SIMMER_SKILL_URL'] as const;

/** Required vars for trade execution. */
const EXECUTION_REQUIRED = [
  'SIMMER_SKILL_URL',
  'SIMMER_API_KEY',
  'POLYGON_WALLET_PRIVATE_KEY',
] as const;

/** Required vars for Telegram notifications. */
const NOTIFY_REQUIRED = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'] as const;

type EnvKey =
  | (typeof SHARED_REQUIRED)[number]
  | (typeof INGEST_REQUIRED)[number]
  | (typeof EXECUTION_REQUIRED)[number]
  | (typeof NOTIFY_REQUIRED)[number]
  | 'OPENAI_API_KEY'
  | 'GEMINI_API_KEY';

/**
 * Validates that all listed environment variables are set and non-empty.
 * Throws with a human-readable message listing every missing variable.
 */
export function validateEnv(required: readonly string[]): void {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n${missing.map((k) => `  - ${k}`).join('\n')}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }
}

/** Validates shared + ingestion env vars. */
export function validateIngestEnv(): void {
  validateEnv([...SHARED_REQUIRED, ...INGEST_REQUIRED]);
  // At least one LLM key must be present.
  if (!process.env['OPENAI_API_KEY'] && !process.env['GEMINI_API_KEY']) {
    throw new Error('At least one of OPENAI_API_KEY or GEMINI_API_KEY must be set.');
  }
}

/** Validates shared + execution + notify env vars. */
export function validateExecutionEnv(): void {
  validateEnv([...SHARED_REQUIRED, ...EXECUTION_REQUIRED, ...NOTIFY_REQUIRED]);
}

/** Validates shared env vars only (e.g. for the position monitor). */
export function validateMonitorEnv(): void {
  validateEnv([...SHARED_REQUIRED, ...EXECUTION_REQUIRED]);
}

/**
 * Returns the value of an environment variable, throwing if absent.
 * Prefer explicit `validateEnv` calls at startup; use this for inline access.
 */
export function requireEnv(key: EnvKey): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Environment variable ${key} is not set.`);
  }
  return val;
}
