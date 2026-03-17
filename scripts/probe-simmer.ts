/**
 * Simmer SDK connectivity probe.
 *
 * Validates that the `polymarket-ai-divergence` Simmer skill is reachable
 * from this project.  Runs standalone — no Redis, no LLM keys needed.
 *
 * Usage:
 *   npm run probe:simmer
 *   # or: npx tsx scripts/probe-simmer.ts
 *
 * Expected outcomes:
 *   ✅  HTTP 400/422 — skill reachable, rejected the probe payload (expected)
 *   ✅  HTTP 200     — skill reachable, accepted the probe payload
 *   ❌  Connection refused / timeout — SIMMER_SKILL_URL is wrong or skill is down
 *   ❌  HTTP 401/403               — SIMMER_API_KEY is missing or invalid
 *
 * The script exits 0 if the skill responded (any HTTP code), 1 if unreachable.
 */

import { probeSimmerSkill } from '../src/shared/simmer.js';

// Load .env if running locally (dotenv is not installed; read manually).
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && val && !process.env[key]) {
      process.env[key] = val;
    }
  }
  console.log('[probe] loaded .env');
}

console.log('[probe] SIMMER_SKILL_URL =', process.env['SIMMER_SKILL_URL'] ?? '(not set)');
console.log('[probe] SIMMER_API_KEY   =', process.env['SIMMER_API_KEY'] ? '***set***' : '(not set)');
console.log('[probe] sending probe payload...\n');

const result = await probeSimmerSkill();

console.log('[probe] result:', JSON.stringify(result, null, 2));

if (!result.reachable) {
  console.error('\n❌ Simmer skill is NOT reachable.');
  console.error('   Check SIMMER_SKILL_URL and ensure the skill server is running.');
  process.exit(1);
}

if (result.statusCode === 401 || result.statusCode === 403) {
  console.error(`\n❌ Auth failure (HTTP ${result.statusCode}).`);
  console.error('   Check SIMMER_API_KEY.');
  process.exit(1);
}

console.log(`\n✅ Simmer skill responded (HTTP ${result.statusCode}).`);
console.log('   Environment is ready for Phase 1 ingestion work.');
process.exit(0);
