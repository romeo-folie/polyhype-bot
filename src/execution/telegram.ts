/**
 * Telegram notification service.
 *
 * Sends structured trade update messages via the Telegram Bot API.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment config.
 *
 * Gracefully no-ops when Telegram is not configured.
 */

import { logger } from '../shared/logger.js';
import type { TradeSignal } from '../mapping/index.js';
import type { Position } from './positionLedger.js';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const REQUEST_TIMEOUT_MS = 10_000;

// ── Low-level send ──────────────────────────────────────────────────────────

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API error ${res.status.toString()}: ${body}`);
  }
}

/**
 * Send a notification if Telegram is configured. No-ops silently if not.
 */
async function notify(text: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];

  if (!token || !chatId) {
    logger.info('[telegram] not configured — skipping notification');
    return;
  }

  try {
    await sendMessage(token, chatId, text);
    logger.info('[telegram] notification sent');
  } catch (err) {
    logger.warn('[telegram] notification failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Message formatters ──────────────────────────────────────────────────────

/**
 * Notify on a successful trade execution.
 */
export async function notifyTradeExecuted(
  signal: TradeSignal,
  txHash: string | undefined,
): Promise<void> {
  const edgePct = (signal.edgeMagnitude * 100).toFixed(1);
  const consensusPct = (signal.consensusProbability * 100).toFixed(1);
  const outcomePct = (signal.outcomePrice * 100).toFixed(1);

  const text =
    `🟢 <b>Trade Executed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(signal.question)}\n` +
    `<b>Direction:</b> ${signal.direction}\n` +
    `<b>Stake:</b> $${signal.stakeUsd.toFixed(2)} USDC\n\n` +
    `<b>Edge:</b> ${edgePct}%\n` +
    `<b>Our P:</b> ${consensusPct}% vs market ${outcomePct}%\n` +
    `<b>Reasoning:</b> ${escapeHtml(signal.reasoning)}\n\n` +
    `<b>Source:</b> ${escapeHtml(signal.sourcedFrom)}\n` +
    (txHash ? `<b>Tx:</b> <code>${escapeHtml(txHash)}</code>` : '');

  await notify(text);
}

/**
 * Notify on a failed trade execution.
 */
export async function notifyTradeError(
  signal: TradeSignal,
  error: string,
): Promise<void> {
  const text =
    `🔴 <b>Trade Failed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(signal.question)}\n` +
    `<b>Direction:</b> ${signal.direction}\n` +
    `<b>Stake:</b> $${signal.stakeUsd.toFixed(2)} USDC\n\n` +
    `<b>Error:</b> ${escapeHtml(error)}`;

  await notify(text);
}

/**
 * Notify on a take-profit exit.
 */
export async function notifyTakeProfitExecuted(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: 'take_profit_threshold' | 'divergence_closed' | 'stop_loss' | 'signal_reeval' | 'copytrade_mirror';
}): Promise<void> {
  const { position, currentPrice, returnPct, reason } = opts;
  const reasonLabels: Record<string, string> = {
    take_profit_threshold: '🎯 Take-profit threshold reached',
    divergence_closed: '📉 Divergence closed',
    stop_loss: '🛑 Stop-loss triggered',
    signal_reeval: '🔄 Signal re-evaluation — edge evaporated',
    copytrade_mirror: '🧲 Copytrade mirror exit',
  };
  const reasonLabel = reasonLabels[reason] ?? reason;

  const text =
    `💰 <b>Position Closed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(position.question)}\n` +
    `<b>Direction:</b> ${position.direction}\n` +
    `<b>Entry price:</b> ${(position.entryPrice * 100).toFixed(1)}%\n` +
    `<b>Exit price:</b> ${(currentPrice * 100).toFixed(1)}%\n` +
    `<b>Return:</b> +${returnPct.toFixed(1)}%\n` +
    `<b>Stake:</b> $${position.stakeUsd.toFixed(2)} USDC\n\n` +
    `<b>Reason:</b> ${reasonLabel}`;

  await notify(text);
}

/**
 * CRITICAL: Notify that an arb YES leg filled but NO leg failed, leaving an
 * unhedged long YES position that requires immediate manual intervention.
 */
export async function notifyUnhedgedArbPosition(opts: {
  marketId: string;
  question: string;
  stakeUsd: number;
  noError?: string | undefined;
}): Promise<void> {
  const text =
    `🚨 <b>CRITICAL: Unhedged Arb Position</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(opts.question)}\n` +
    `<b>Market ID:</b> <code>${escapeHtml(opts.marketId)}</code>\n` +
    `<b>YES stake:</b> $${opts.stakeUsd.toFixed(2)} USDC — <b>NO leg FAILED</b>\n` +
    `${opts.noError ? `<b>NO error:</b> ${escapeHtml(opts.noError)}\n` : ''}` +
    `\n⚠️ <b>Action required: manually close or hedge the YES position.</b>`;

  await notify(text);
}

/**
 * Notify on a resolved position redemption.
 */
export async function notifyRedemptionExecuted(opts: {
  marketId: string;
  question: string;
  side: 'yes' | 'no';
  txHash?: string;
  valueUsdc: number;
}): Promise<void> {
  const { question, side, txHash, valueUsdc } = opts;

  const text =
    `🏆 <b>Position Redeemed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(question)}\n` +
    `<b>Side:</b> ${side.toUpperCase()}\n` +
    `<b>Proceeds:</b> $${valueUsdc.toFixed(2)} USDC${txHash ? `\n<b>Tx:</b> <code>${escapeHtml(txHash)}</code>` : ''}`;

  await notify(text);
}

// ── Utility ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Export for testing
export { sendMessage as _sendMessage };
