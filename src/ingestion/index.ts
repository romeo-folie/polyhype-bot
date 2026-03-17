/**
 * Phase 1 stub: Data Ingestion & Filtering
 *
 * Cron entrypoint for the world-monitor-scraper.
 * Implementation lands in Phase 1. This stub satisfies the build check.
 */

export async function runIngestion(): Promise<void> {
  console.log('[ingestion] Phase 1 stub — not yet implemented');
}

// Entrypoint when run directly (npx tsx src/ingestion/index.ts)
const isMain = process.argv[1]?.endsWith('ingestion/index.ts') ?? false;
if (isMain) {
  runIngestion().catch((err: unknown) => {
    console.error('[ingestion] fatal:', err);
    process.exit(1);
  });
}
