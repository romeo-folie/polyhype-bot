#!/usr/bin/env npx tsx
/**
 * Simmer SDK Probe Script
 *
 * Validates that the polymarket-ai-divergence Simmer skill is reachable.
 * Delegates to the shared probeSimmerSkill() function for consistent probe logic.
 *
 * Usage:
 *   cp .env.example .env  # fill in values, then:
 *   npm run probe:simmer
 *   -- OR (with dotenv-cli) --
 *   dotenv -- npx tsx scripts/probe-simmer.ts
 */

import 'dotenv/config';
import { probeSimmerSkill } from '../src/shared/simmer.js';

async function main(): Promise<void> {
  console.log('=== Simmer SDK Probe ===');

  const result = await probeSimmerSkill();

  console.log(`Reachable : ${result.reachable}`);
  console.log(`Status    : ${result.statusCode}`);
  console.log('Response  :', JSON.stringify(result.body, null, 2));

  if (!result.reachable) {
    console.error('\n❌ Simmer skill is not reachable.');
    process.exit(1);
  }

  if (result.statusCode === 401 || result.statusCode === 403) {
    console.error('\n❌ Authentication failed. Check SIMMER_API_KEY.');
    process.exit(1);
  }

  console.log('\n✅ Simmer skill is reachable.');
}

main().catch((err: unknown) => {
  console.error('Probe script crashed:', err);
  process.exit(1);
});
