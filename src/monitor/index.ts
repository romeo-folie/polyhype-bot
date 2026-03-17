/**
 * Phase 4 stub: Position Monitor & Take-Profit
 *
 * Cron entrypoint — runs every 5 minutes in production.
 * Implementation lands in Phase 4.
 */

export async function runMonitor(): Promise<void> {
  console.log('[monitor] Phase 4 stub — not yet implemented');
}

// Entrypoint when run directly (npx tsx src/monitor/index.ts)
const isMain = process.argv[1]?.endsWith('monitor/index.ts') ?? false;
if (isMain) {
  runMonitor().catch((err: unknown) => {
    console.error('[monitor] fatal:', err);
    process.exit(1);
  });
}
