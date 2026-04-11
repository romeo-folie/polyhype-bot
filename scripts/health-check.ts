#!/usr/bin/env npx tsx
/**
 * scripts/health-check.ts
 *
 * Periodic system health check. Collects logs + diagnostic output, sends the
 * snapshot to Claude (Haiku) for free-form analysis, and fires a Telegram
 * alert if anything looks off.
 *
 * Cron (every 6h via run.sh):
 *   0 *\/6 * * * /home/romeo/projects/polymarket-geopolitical-agent/run.sh \
 *     npx tsx /home/romeo/projects/polymarket-geopolitical-agent/scripts/health-check.ts \
 *     >> ~/logs/pga/health-check.log 2>&1
 */

import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const LOG_DIR = join(process.env.HOME ?? '/root', 'logs', 'pga');

// Max chars we'll send to the API — keeps tokens under ~15k
const MAX_CONTEXT_CHARS = 55_000;

// Only consider log lines newer than this window — prevents stale entries from
// old runs leaking into assessments. Matches the cron cadence so every run
// sees exactly the period since the last check.
const LOG_WINDOW_HOURS = 6;

// ── shell helper ────────────────────────────────────────────────────────────

function sh(cmd: string): string {
  try {
    return execSync(cmd, {
      cwd: PROJECT_DIR,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return e?.stdout ?? e?.stderr ?? `(command failed: ${String(err)})`;
  }
}

// ── data collection ─────────────────────────────────────────────────────────

function collect(): string {
  const parts: string[] = [];

  // Cutoff ISO — cron logs filter on the "ts" field so we never include lines
  // older than LOG_WINDOW_HOURS, regardless of how many raw bytes the file has.
  const cutoffIso = new Date(Date.now() - LOG_WINDOW_HOURS * 3_600_000).toISOString();

  // 1. Structured diagnostic summary
  parts.push('=== DIAGNOSE OUTPUT ===');
  parts.push(sh('bash scripts/diagnose.sh'));

  // 2. Recent cron log windows (signal-dense files get a larger line cap).
  // awk filter keeps only lines whose "ts" field is newer than cutoffIso.
  // Portable POSIX awk — works on gawk and mawk.
  const cronLogs: Array<[string, number]> = [
    [`${LOG_DIR}/trade.log`, 200],
    [`${LOG_DIR}/monitor.log`, 200],
    [`${LOG_DIR}/spot.log`, 150],
    [`${LOG_DIR}/settlement.log`, 100],
  ];

  for (const [file, maxLines] of cronLogs) {
    const name = file.split('/').pop()!;
    parts.push(`\n=== RECENT (last ${LOG_WINDOW_HOURS}h, max ${maxLines} lines): ${name} ===`);
    const cmd =
      `awk -v cutoff='${cutoffIso}' '{ ` +
      `  if (match($0, /"ts":"[^"]+"/)) { ` +
      `    ts = substr($0, RSTART+6, RLENGTH-7); ` +
      `    if (ts >= cutoff) print; ` +
      `  } ` +
      `}' "${file}" 2>/dev/null | tail -n ${maxLines} || echo "(file not found)"`;
    parts.push(sh(cmd));
  }

  // 3. Docker worker logs — errors + warns only, same window
  const workers = ['pga-spot-feed', 'pga-arb', 'pga-copytrade', 'pga-futures', 'pga-telegram'];
  parts.push(`\n=== DOCKER WORKER ERRORS/WARNS (last ${LOG_WINDOW_HOURS}h) ===`);
  for (const svc of workers) {
    const lines = sh(
      `docker compose logs --since ${LOG_WINDOW_HOURS}h ${svc} 2>&1 | grep -E '"level":"(error|warn)"' | tail -20 || true`,
    );
    if (lines.trim()) {
      parts.push(`-- ${svc} --`);
      parts.push(lines.trim());
    } else {
      parts.push(`-- ${svc}: no errors/warns --`);
    }
  }

  const full = parts.join('\n');

  // Trim from the middle if over limit — keep head (diagnose) and tail (most recent)
  if (full.length > MAX_CONTEXT_CHARS) {
    const half = Math.floor(MAX_CONTEXT_CHARS / 2);
    return (
      full.slice(0, half) +
      '\n\n[... context trimmed to fit token limit ...]\n\n' +
      full.slice(-half)
    );
  }

  return full;
}

// ── Claude analysis ─────────────────────────────────────────────────────────

interface Assessment {
  healthy: boolean;
  issues: string[];
  summary: string;
}

async function assess(context: string): Promise<Assessment> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system: `You are the health monitor for PGA — a live prediction-market and crypto futures trading system running on a Hetzner CAX11 server.

You will receive a snapshot of logs, container status, and diagnostic output taken every 6 hours.
Assess whether the system is healthy. Use your judgment — do not limit yourself to known error patterns.

FLAG as unhealthy (healthy: false) if you see:
- Any Docker container that is not "Up"
- Redis connectivity issues or unexpectedly stale locks
- Spot feed or Telegram worker with no recent activity (silence = likely dead)
- Error spikes — many errors in a short window from the same source
- Repeated identical errors (crash loop signature)
- "no watchlist tokens", empty market caches, or data starvation patterns
- Bankroll or active position count that looks wrong (zero positions when there should be some, or implausibly large numbers)
- Any process that appears stuck or not making progress

Do NOT flag as issues:
- Normal INFO-level log activity
- Occasional single warnings that do not repeat
- Expected skips (confluence_block, extreme_price_llm_distrust, stake_floor, etc.)
- Low trade counts during quiet news periods
- Routine "no candidate markets found" entries

Respond ONLY with valid JSON — no markdown fences, no extra text:
{
  "healthy": true,
  "issues": [],
  "summary": "one sentence"
}`,
    messages: [
      {
        role: 'user',
        content: `System snapshot (${new Date().toISOString()}):\n\n${context}`,
      },
    ],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text.trim() : '';

  try {
    const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
    return JSON.parse(cleaned) as Assessment;
  } catch {
    return {
      healthy: false,
      issues: [`Health check could not parse Claude response: ${raw.slice(0, 200)}`],
      summary: 'Assessment parse error — review health-check.log manually.',
    };
  }
}

// ── Telegram alert ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendAlert(assessment: Assessment): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[health-check] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping alert');
    return;
  }

  const issueLines = assessment.issues
    .map((i) => `  • ${escapeHtml(i)}`)
    .join('\n');

  const text =
    `🔧⚠️ <b>SYSTEM HEALTH ALERT</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Summary:</b> ${escapeHtml(assessment.summary)}\n\n` +
    `<b>Issues detected:</b>\n${issueLines}\n\n` +
    `<i>Checked at ${new Date().toUTCString()}</i>\n` +
    `<i>See ~/logs/pga/health-check.log for full context.</i>`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[health-check] starting at ${new Date().toISOString()}`);

  const context = collect();
  console.log(`[health-check] collected ${context.length.toLocaleString()} chars`);

  const assessment = await assess(context);
  console.log(
    `[health-check] healthy=${String(assessment.healthy)} issues=${assessment.issues.length}`,
  );
  console.log(`[health-check] summary: ${assessment.summary}`);

  if (!assessment.healthy) {
    console.log(`[health-check] issues:\n${assessment.issues.map((i) => `  - ${i}`).join('\n')}`);
    await sendAlert(assessment);
    console.log('[health-check] alert sent');
  } else {
    console.log('[health-check] all clear — no alert sent');
  }
}

main().catch((err: unknown) => {
  console.error('[health-check] fatal:', err);
  process.exit(1);
});
