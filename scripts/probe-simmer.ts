#!/usr/bin/env npx tsx
/**
 * Simmer API Probe Script
 *
 * Validates that the Simmer API is reachable and the API key is valid.
 * Sends a dry-run trade with a probe market ID — no real trade executed.
 *
 * Usage:
 *   cp .env.example .env  # fill in SIMMER_API_KEY, then:
 *   npm run probe:simmer
 */

import 'dotenv/config';
import { probeSimmerSkill } from '../src/shared/simmer.js';

async function main(): Promise<void> {
  console.log('=== Simmer API Probe ===');
  console.log('Target: https://api.simmer.markets/api/sdk/trade');

  const result = await probeSimmerSkill();

  console.log(`Reachable : ${result.reachable}`);
  console.log(`Status    : ${result.statusCode}`);
  console.log('Response  :', JSON.stringify(result.body, null, 2));

  if (!result.reachable) {
    console.error('\n❌ Simmer API is not reachable. Check network connectivity.');
    process.exit(1);
  }

  if (result.statusCode === 401 || result.statusCode === 403) {
    console.error('\n❌ Authentication failed. Check SIMMER_API_KEY.');
    process.exit(1);
  }

  console.log('\n✅ Simmer API is reachable and key is accepted.');
  console.log('   Register/claim your agent at https://simmer.markets to enable real trading.');
}

main().catch((err: unknown) => {
  console.error('Probe script crashed:', err);
  process.exit(1);
});
