#!/usr/bin/env npx tsx
/**
 * Simmer SDK Probe Script
 *
 * Validates that the polymarket-ai-divergence Simmer skill is reachable
 * and responds to a health/capabilities check.
 *
 * Usage:
 *   SIMMER_SKILL_URL=http://... SIMMER_API_KEY=... npx tsx scripts/probe-simmer.ts
 *   -- OR --
 *   cp .env.example .env  # fill in values
 *   npm run probe:simmer
 */

// Minimal env load — dotenv not in deps, use process.env directly
const SIMMER_SKILL_URL = process.env['SIMMER_SKILL_URL'];
const SIMMER_API_KEY = process.env['SIMMER_API_KEY'];

async function probe(): Promise<void> {
  console.log('=== Simmer SDK Probe ===');

  if (!SIMMER_SKILL_URL) {
    console.error('❌ SIMMER_SKILL_URL is not set. Copy .env.example to .env and fill in values.');
    process.exit(1);
  }
  if (!SIMMER_API_KEY) {
    console.error('❌ SIMMER_API_KEY is not set. Copy .env.example to .env and fill in values.');
    process.exit(1);
  }

  console.log(`Skill URL : ${SIMMER_SKILL_URL}`);
  console.log('API Key   : [set]');
  console.log('');

  // Attempt 1: GET /health (common Simmer convention)
  const healthUrl = `${SIMMER_SKILL_URL.replace(/\/+$/, '')}/health`;
  console.log(`Probing   : GET ${healthUrl}`);

  try {
    const res = await fetch(healthUrl, {
      headers: {
        Authorization: `Bearer ${SIMMER_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    console.log(`Status    : ${res.status} ${res.statusText}`);

    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      console.log('Response  :', JSON.stringify(body, null, 2));
      console.log('');
      console.log('✅ Simmer skill is reachable and healthy.');
      return;
    }

    console.log('');
    console.log(`⚠️  Skill returned ${res.status}. It may be reachable but not healthy.`);
    console.log('   Check SIMMER_SKILL_URL and ensure the skill is running.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log('');
    console.log(`❌ Could not reach skill: ${msg}`);
    console.log('');
    console.log('   Possible causes:');
    console.log('   1. Skill is not running — start it via the Simmer dashboard');
    console.log('   2. SIMMER_SKILL_URL is incorrect — check your .env');
    console.log('   3. Network connectivity issue');
    process.exit(1);
  }
}

probe().catch((err: unknown) => {
  console.error('Probe script crashed:', err);
  process.exit(1);
});
