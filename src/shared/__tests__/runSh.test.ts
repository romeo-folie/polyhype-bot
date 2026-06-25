import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Regression test for the 2026-06-22→25 outage: a single malformed `.env` line made
 * `set -e` + `source` abort run.sh before it ever exec'd the command, silently killing
 * the whole host-cron fleet. run.sh must now load `.env` tolerantly — a bad line warns
 * but does NOT abort — so the wrapped command still runs.
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');
const RUN_SH = path.join(REPO_ROOT, 'run.sh');
let tmpDir: string | null = null;

function runWith(envContents: string): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'pga-runsh-'));
  const envFile = path.join(tmpDir, 'test.env');
  writeFileSync(envFile, envContents);
  return execFileSync('bash', [RUN_SH, 'echo', 'RUNSH_REACHED_EXEC'], {
    // HOME → tmpDir so run.sh's log dir + env-source.log stay hermetic (not the real ~/logs).
    env: { ...process.env, PGA_ENV_FILE: envFile, HOME: tmpDir },
    encoding: 'utf8',
  });
}

afterEach(() => {
  if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

describe('run.sh .env sourcing tolerance', () => {
  it('still execs the command when .env has an unquoted pipe (the cohort-line bug)', () => {
    const out = runWith('GOOD_VAR=ok\nWEATHER_CALIBRATION_LIVE_COHORTS=high|range|hrrr-combined\n');
    expect(out).toContain('RUNSH_REACHED_EXEC');
  });

  it('still execs the command when .env has a stray space in a key (the ARB-block bug)', () => {
    const out = runWith('GOOD_VAR=ok\nARB_ ENABLED=true\nN EGRISK_ARB_MAX_OUTCOMES=50\n');
    expect(out).toContain('RUNSH_REACHED_EXEC');
  });

  it('a clean .env still works (no regression)', () => {
    const out = runWith('GOOD_VAR=ok\nWEATHER_CALIBRATION_LIVE_COHORTS="high|range|hrrr-combined"\n');
    expect(out).toContain('RUNSH_REACHED_EXEC');
  });
});
