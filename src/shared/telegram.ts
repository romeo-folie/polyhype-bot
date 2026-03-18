/**
 * Telegram notification service.
 *
 * Sends structured messages via the Telegram Bot API.
 * All sends are fire-and-forget — failures are logged but never throw,
 * so a Telegram outage never blocks trade execution.
 *
 * Required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

import { logger } from './logger.js';
import type { TradeSignal } from '../mapping/index.js';
import type { ExecutionResult } from '../execution/executor.js';

/**
 * Escape text for Telegram HTML parse mode.
 * Telegram HTML supports only <b>, <i>, <code>, <pre>, <a> — all other
 * angle brackets and ampersands must be escaped to avoid parse failures
 * and silently-dropped messages when external text (headlines, errors, etc.)
 * contains HTML special characters.
 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const TELEGRAM_API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 10_000;

/**
 * Send a raw text message. Non-blocking — never throws.
 */
async function sendMessage(text: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];

  if (!token || !chatId) {
    logger.warn('[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping notify');
    return;
  }

  const url = `${TELEGRAM_API}/bot${token}/sendMessage`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn('[telegram] send failed', { status: res.status, body: body.slice(0, 200) });
    }
  } catch (err) {
    logger.warn('[telegram] send error (non-blocking)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function directionEmoji(direction: 'YES' | 'NO'): string {
  return direction === 'YES' ? '🟢' : '🔴';
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Notify: trade executed successfully.
 */
export function notifyTradeExecuted(result: ExecutionResult): void {
  if (!result.success || !result.signal) return;
  const s = result.signal;
  const text =
    `⚡ <b>Trade Executed</b>\n` +
    `${directionEmoji(s.direction)} <b>${s.direction}</b> on <i>${esc(s.question.slice(0, 80))}</i>\n\n` +
    `💰 Stake: <b>$${s.stakeUsd.toFixed(2)}</b>\n` +
    `📊 Market price: ${pct(s.outcomePrice)} | Consensus: ${pct(s.consensusProbability)}\n` +
    `📈 Edge: ${pct(s.edgeMagnitude)} | Half-Kelly: ${pct(s.halfKellyFraction)}\n` +
    `🔗 Market ID: <code>${esc(s.marketId)}</code>\n` +
    `${result.txHash ? `✅ TX: <code>${esc(result.txHash)}</code>\n` : ''}` +
    `📰 Source: ${esc(s.sourcedFrom.slice(0, 120))}`;

  void sendMessage(text);
}

/**
 * Notify: signal below divergence threshold — skipped.
 */
export function notifySignalSkipped(signal: TradeSignal, reason: string): void {
  const text =
    `⏭ <b>Signal Skipped</b>\n` +
    `${directionEmoji(signal.direction)} ${signal.direction} on <i>${esc(signal.question.slice(0, 80))}</i>\n` +
    `Reason: ${esc(reason)}\n` +
    `Market ID: <code>${esc(signal.marketId)}</code>`;

  void sendMessage(text);
}

/**
 * Notify: execution failed.
 */
export function notifyExecutionError(result: ExecutionResult): void {
  if (result.success) return;
  const s = result.signal;
  const text =
    `❌ <b>Execution Failed</b>\n` +
    `${directionEmoji(s.direction)} ${s.direction} on <i>${esc(s.question.slice(0, 80))}</i>\n` +
    `Stake: $${s.stakeUsd.toFixed(2)}\n` +
    `Error: ${esc(result.error ?? 'unknown')}\n` +
    `Market ID: <code>${esc(s.marketId)}</code>`;

  void sendMessage(text);
}

/**
 * Notify: take-profit triggered (for Phase 4 monitor to call).
 */
export function notifyTakeProfit(
  marketId: string,
  question: string,
  pnlPct: number,
  stakeUsd: number,
): void {
  const sign = pnlPct >= 0 ? '+' : '';
  const text =
    `💸 <b>Take-Profit Triggered</b>\n` +
    `<i>${esc(question.slice(0, 80))}</i>\n\n` +
    `P&amp;L: <b>${sign}${(pnlPct * 100).toFixed(1)}%</b>\n` +
    `Stake: $${stakeUsd.toFixed(2)}\n` +
    `Market ID: <code>${esc(marketId)}</code>`;

  void sendMessage(text);
}

// Export sendMessage for tests
export { sendMessage as _sendMessage };
