#!/usr/bin/env tsx
/**
 * One-shot backfill: parse weather scanner logs (current + rotated) for
 * `[weather] event evaluated` lines, extract distinct (city, target_date)
 * tuples for past dates, and reconcile each via the Open-Meteo archive.
 *
 * Use case: the shadow_observations DB writer for `weather_event` was wired
 * 2026-04-14, but the scanner had been logging since 2026-04-13. This script
 * recovers ground truth for those scans (and any subsequent gap) by going
 * directly to the host log files.
 *
 * Idempotent: weather_ground_truth has UNIQUE(city, target_date), and
 * reconcileTargets re-uses the same enqueueWrite path the cron uses. Running
 * twice is harmless.
 *
 * Usage:
 *   npx tsx scripts/backfill-weather-ground-truth.ts [--logs-dir DIR] [--dry-run]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../src/shared/logger.js';
import { reconcileTargets, type UnresolvedTarget } from '../src/weather/weatherReconciler.js';

interface CliArgs {
  logsDir: string;
  dryRun: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let logsDir = join(homedir(), 'logs', 'pga');
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--logs-dir' && args[i + 1]) {
      logsDir = args[i + 1]!;
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--help' || a === '-h') {
      // eslint-disable-next-line no-console
      console.log(
        'Usage: backfill-weather-ground-truth.ts [--logs-dir DIR] [--dry-run]',
      );
      process.exit(0);
    }
  }
  return { logsDir, dryRun };
}

/** Distinct (city, target_date) tuples gathered from log files. */
function extractTargetsFromLogs(logsDir: string): UnresolvedTarget[] {
  // Match weather.log + rotated weather.log.1, weather.log.2.gz, etc. Gzip
  // files are intentionally skipped here — log rotation only keeps 1 backup
  // (`scripts/rotate-logs.sh`), so any .gz here is unexpected.
  const files = readdirSync(logsDir).filter((f) =>
    /^weather\.log(\.\d+)?$/.test(f),
  );
  if (files.length === 0) {
    logger.warn('[backfill] no weather.log files found', { logsDir });
    return [];
  }

  const today = new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const out: UnresolvedTarget[] = [];

  for (const f of files) {
    const path = join(logsDir, f);
    const text = readFileSync(path, 'utf-8');
    const lines = text.split('\n');
    let parsed = 0;
    let added = 0;
    for (const line of lines) {
      // Cheap filter before JSON parse: every event-evaluated line contains
      // this exact substring, so we skip ~90% of bracket/scan-summary lines.
      if (!line.includes('"[weather] event evaluated"')) continue;
      try {
        const row = JSON.parse(line) as {
          city?: unknown;
          targetDate?: unknown;
        };
        if (typeof row.city !== 'string' || typeof row.targetDate !== 'string') {
          continue;
        }
        parsed++;
        const targetDate = row.targetDate.slice(0, 10);
        // Future dates aren't reconcilable yet; the daily cron will pick them
        // up once they're past.
        if (targetDate >= today) continue;
        const key = `${row.city}|${targetDate}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ city: row.city, targetDate });
        added++;
      } catch {
        // Malformed log line — skip silently.
      }
    }
    logger.info('[backfill] parsed log file', {
      file: basename(path),
      eventLines: parsed,
      newTargets: added,
    });
  }
  return out;
}

async function main(): Promise<void> {
  const { closeSql } = await import('../src/db/client.js');
  const { closeRedis } = await import('../src/shared/redis.js');
  const { logsDir, dryRun } = parseArgs();

  const targets = extractTargetsFromLogs(logsDir);
  logger.info('[backfill] extracted distinct targets', {
    logsDir,
    totalTargets: targets.length,
  });

  if (targets.length === 0) {
    logger.info('[backfill] nothing to reconcile, exiting');
    await closeSql();
    await closeRedis();
    return;
  }

  if (dryRun) {
    // Show first 20 so the operator can sanity-check before a real run.
    const sample = targets.slice(0, 20);
    logger.info('[backfill] dry-run sample (first 20)', { sample });
    await closeSql();
    await closeRedis();
    return;
  }

  try {
    const summary = await reconcileTargets(targets);
    logger.info('[backfill] complete', {
      candidates: targets.length,
      ...summary,
    });
  } finally {
    await closeSql();
    await closeRedis();
  }
}

void main().catch((err: unknown) => {
  logger.error('[backfill] fatal error', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
