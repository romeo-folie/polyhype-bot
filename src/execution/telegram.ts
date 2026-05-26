/**
 * Telegram notification service.
 *
 * Sends structured trade update messages via the Telegram Bot API.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in environment config.
 *
 * Gracefully no-ops when Telegram is not configured.
 */

import { logger } from '../shared/logger.js';
import { loadConfig } from '../shared/config.js';
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
export async function notify(text: string): Promise<void> {
  const cfg = loadConfig();
  const token = cfg.TELEGRAM_BOT_TOKEN;
  const chatId = cfg.TELEGRAM_CHAT_ID;

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

// ── Formatting helpers ──────────────────────────────────────────────────────

/**
 * Format a prediction-market probability price.
 * Shows both the raw decimal and the implied percentage so it's unambiguous:
 *   e.g. 0.285 → "0.285 (28.5% implied)"
 */
function fmtProb(price: number): string {
  return `${price.toFixed(3)} (${(price * 100).toFixed(1)}% implied)`;
}

/**
 * Format a futures/perp price as a plain dollar value.
 */
function fmtFiat(price: number): string {
  const abs = Math.abs(price);
  if (abs >= 1000) return `$${price.toFixed(2)}`;
  if (abs >= 1) return `$${price.toFixed(4)}`;
  if (abs >= 0.1) return `$${price.toFixed(5)}`;
  if (abs >= 0.01) return `$${price.toFixed(6)}`;
  return `$${price.toFixed(8)}`;
}

/**
 * Format a signed return percentage with leading +/-.
 */
function fmtReturn(pct: number): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/**
 * Format a venue label for display.
 */
function fmtVenue(venue: string): string {
  const labels: Record<string, string> = {
    simmer: 'Simmer',
    clob: 'CLOB',
    hyperliquid: 'Hyperliquid',
  };
  return labels[venue] ?? venue.toUpperCase();
}

// ── Message formatters ──────────────────────────────────────────────────────

/**
 * Notify on a successful trade execution.
 */
export async function notifyTradeExecuted(
  signal: TradeSignal,
  txHash: string | undefined,
  opts?: { venue?: string; sharesFilled?: number; entryPrice?: number | null },
): Promise<void> {
  const edgePct = (signal.edgeMagnitude * 100).toFixed(1);
  const venue = fmtVenue(opts?.venue ?? 'clob');
  const isFutures = opts?.venue === 'hyperliquid' || signal.isFutures === true;
  const entryPrice = opts?.entryPrice ?? signal.outcomePrice;

  const sharesLine =
    opts?.sharesFilled != null && opts.sharesFilled > 0
      ? `<b>Shares:</b> ${opts.sharesFilled.toFixed(4)}\n`
      : '';

  let metaLine = '';
  if (signal.latencyMs != null || signal.volatility != null || signal.spreadBps != null) {
    const parts = [];
    if (signal.latencyMs != null) parts.push(`lat: ${Math.round(signal.latencyMs)}ms`);
    if (signal.volatility != null) parts.push(`vol: ${(signal.volatility * 100).toFixed(1)}%`);
    if (signal.spreadBps != null) parts.push(`spr: ${Math.round(signal.spreadBps)}bps`);
    metaLine = `\n<code>[${parts.join(' | ')}]</code>\n`;
  }

  const marketContextLine = isFutures
    ? `\n<b>Edge:</b> ${edgePct}%\n`
    : `\n<b>Edge:</b> ${edgePct}%  |  <b>Our P:</b> ${((signal.consensusProbability ?? 0.5) * 100).toFixed(1)}% vs market ${(signal.outcomePrice * 100).toFixed(1)}%\n`;

  const directionLabel = signal.isContrarian
    ? `${signal.direction} ↩️ contrarian`
    : signal.direction;

  const text =
    `🟢 <b>Trade Executed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(signal.question)}\n` +
    `<b>Direction:</b> ${directionLabel}  |  <b>Venue:</b> ${venue}\n` +
    `<b>Entry price:</b> ${isFutures ? fmtFiat(entryPrice) : fmtProb(signal.outcomePrice)}\n` +
    `<b>Stake:</b> $${signal.stakeUsd.toFixed(2)} USDC\n` +
    sharesLine +
    metaLine +
    marketContextLine +
    `<b>Source:</b> ${escapeHtml(signal.sourcedFrom)}\n` +
    `<b>Reasoning:</b> ${escapeHtml(signal.reasoning)}\n` +
    (txHash ? `\n<b>Tx:</b> <code>${escapeHtml(txHash)}</code>` : '');

  await notify(text);
}

/**
 * Notify on a failed trade execution.
 */
export async function notifyTradeError(
  signal: { question: string; direction: string; stakeUsd: number; marketId?: string },
  error: string,
  opts?: { venue?: string },
): Promise<void> {
  const venue = opts?.venue ? fmtVenue(opts.venue) : undefined;

  const text =
    `🔴 <b>Trade Failed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(signal.question)}\n` +
    `<b>Direction:</b> ${signal.direction}` +
    (venue ? `  |  <b>Venue:</b> ${venue}` : '') +
    `\n` +
    `<b>Intended stake:</b> $${signal.stakeUsd.toFixed(2)} USDC\n` +
    (signal.marketId ? `<b>Market ID:</b> <code>${escapeHtml(signal.marketId)}</code>\n` : '') +
    `\n<b>Error:</b> ${escapeHtml(error)}`;

  await notify(text);
}

/**
 * Notify on a take-profit exit.
 */
export type TakeProfitReason =
  | 'take_profit_threshold'
  | 'divergence_closed'
  | 'stop_loss'
  | 'signal_reeval'
  | 'copytrade_mirror'
  | 'synthetic'
  | 'futures_sl'
  | 'futures_tp'
  | 'futures_max_hold'
  | 'stale_exit'
  | 'trailing_stop'
  | 'trend_exit'
  | 'oracle_lag_compressed'
  | 'oracle_lag_reversed'
  | 'oracle_lag_timeout'
  | 'oracle_lag_near_resolution'
  | 'oracle_lag_stop_loss'
  | 'weather_near_resolution'
  | 'funding_normalized'
  | 'funding_sign_flip'
  | 'hedge_pm_resolved';

export async function notifyTakeProfitExecuted(opts: {
  position: Position;
  currentPrice: number;
  returnPct: number;
  reason: TakeProfitReason;
  mechanismDetail?: string;
}): Promise<void> {
  const { position, currentPrice, returnPct, reason, mechanismDetail } = opts;
  const reasonLabels: Record<string, string> = {
    take_profit_threshold: '🎯 Take-profit threshold reached',
    divergence_closed: '📉 Divergence closed',
    stop_loss: '🛑 Stop-loss triggered',
    signal_reeval: '🔄 Signal re-evaluation — edge evaporated',
    copytrade_mirror: '🧲 Copytrade mirror exit',
    synthetic: '🛡️ Synthetic exit (Hedged on Hyperliquid)',
    futures_sl: '🛑 Futures Stop-Loss triggered',
    futures_tp: '🎯 Futures Take-Profit triggered',
    futures_max_hold: '⏱️ Futures max hold reached',
    stale_exit: '⏱️ Stale-exit — position rotated out',
    trailing_stop: returnPct >= 0 ? '🪤 Trailing stop — gains locked in' : '🪤 Trailing stop — reversal below entry',
    trend_exit: '📉 Trend exit — adverse drift',
    oracle_lag_compressed: '🎯 Oracle-lag — gap compressed',
    oracle_lag_reversed: '↩️ Oracle-lag — Chainlink reversed',
    oracle_lag_timeout: '⏱️ Oracle-lag — max hold reached',
    oracle_lag_near_resolution: '🔒 Oracle-lag — near-resolution profit lock',
    oracle_lag_stop_loss: '🛑 Oracle-lag — stop-loss triggered',
    weather_near_resolution: '⏱️ Weather — near-resolution loss cut',
    funding_normalized: '📊 Funding normalized — mean-reversion exit',
    funding_sign_flip: '🔀 Funding sign flip — crowd reversed',
    hedge_pm_resolved: '🔗 Delta-hedge closed — PM market resolved',
  };
  let reasonLabel = reasonLabels[reason] ?? reason;
  if (mechanismDetail) reasonLabel = `${reasonLabel} [${mechanismDetail}]`;

  const isFutures = position.isFutures === true;
  const venue = fmtVenue(position.executionVenue);

  // Absolute P&L: returnPct is already (exitPrice/entryPrice - 1) * 100 for PM positions
  const pnlUsdc = position.stakeUsd * (returnPct / 100);
  const pnlLine = `<b>P&amp;L:</b> ${pnlUsdc >= 0 ? '+' : ''}$${pnlUsdc.toFixed(2)} USDC (${fmtReturn(returnPct)})`;

  const sharesLine =
    position.sharesHeld != null && position.sharesHeld > 0
      ? `<b>Shares:</b> ${position.sharesHeld.toFixed(4)}\n`
      : '';

  const entryFmt = isFutures ? fmtFiat(position.entryPrice) : fmtProb(position.entryPrice);
  const exitFmt = isFutures ? fmtFiat(currentPrice) : fmtProb(currentPrice);

  const closedDirectionLabel = position.isContrarian
    ? `${position.direction} ↩️ contrarian`
    : position.direction;

  const text =
    `💰 <b>Position Closed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(position.question)}\n` +
    `<b>Direction:</b> ${closedDirectionLabel}  |  <b>Venue:</b> ${venue}\n` +
    `<b>Entry:</b> ${entryFmt}  →  <b>Exit:</b> ${exitFmt}\n` +
    sharesLine +
    `<b>Stake:</b> $${position.stakeUsd.toFixed(2)} USDC\n` +
    pnlLine +
    `\n` +
    `\n<b>Reason:</b> ${reasonLabel}`;

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
  yesPrice?: number;
  noError?: string | undefined;
}): Promise<void> {
  const yesPriceLine =
    opts.yesPrice != null ? `<b>YES fill price:</b> ${fmtProb(opts.yesPrice)}\n` : '';

  const text =
    `🚨 <b>CRITICAL: Unhedged Arb Position</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(opts.question)}\n` +
    `<b>Market ID:</b> <code>${escapeHtml(opts.marketId)}</code>\n` +
    `<b>YES stake:</b> $${opts.stakeUsd.toFixed(2)} USDC — <b>NO leg FAILED</b>\n` +
    yesPriceLine +
    (opts.noError ? `<b>NO error:</b> ${escapeHtml(opts.noError)}\n` : '') +
    `\n⚠️ <b>Action required: manually close or hedge the YES position.</b>`;

  await notify(text);
}

/**
 * CRITICAL: Notify that a NegRisk multi-leg arb partially filled, leaving
 * unhedged YES positions on the filled legs.
 */
export async function notifyUnhedgedNegRiskPosition(opts: {
  eventId: string;
  eventTitle: string;
  filledLegs: number;
  totalLegs: number;
  totalCostUsd: number;
  failedLegMarketId: string;
  failedLegError?: string;
}): Promise<void> {
  const text =
    `🚨 <b>CRITICAL: Unhedged NegRisk Arb</b>\n\n` +
    `<b>Event:</b> ${escapeHtml(opts.eventTitle)}\n` +
    `<b>Event ID:</b> <code>${escapeHtml(opts.eventId)}</code>\n` +
    `<b>Filled:</b> ${opts.filledLegs.toString()}/${opts.totalLegs.toString()} legs\n` +
    `<b>Total spent:</b> $${opts.totalCostUsd.toFixed(2)} USDC — ` +
    `<b>${(opts.totalLegs - opts.filledLegs).toString()} legs UNFILLED</b>\n` +
    `<b>Failed at:</b> <code>${escapeHtml(opts.failedLegMarketId)}</code>\n` +
    (opts.failedLegError
      ? `<b>Error:</b> ${escapeHtml(opts.failedLegError)}\n`
      : '') +
    `\n⚠️ <b>Action: ${opts.filledLegs.toString()} unhedged YES positions recorded in ledger. ` +
    `Manual intervention may be required.</b>`;

  await notify(text);
}

/**
 * Notify when a market resolves — covers both wins and losses.
 * For wins this supplements the existing notifyRedemptionExecuted (which fires
 * only on successful on-chain redemptions). For losses this is the only
 * notification the user gets.
 */
export async function notifyMarketResolved(opts: {
  question: string;
  direction: string;
  result: 'won' | 'lost';
  stakeUsd?: number;
  proceedsUsdc?: number;
  reason?: string;
}): Promise<void> {
  const { question, direction, result, stakeUsd, proceedsUsdc, reason } = opts;
  const isWin = result === 'won';
  const emoji = isWin ? '✅' : '❌';
  const header = isWin ? 'Market Resolved — Won' : 'Market Resolved — Lost';

  let stakeLine = '';
  if (stakeUsd != null && stakeUsd > 0) {
    if (isWin && proceedsUsdc != null && proceedsUsdc > 0) {
      const profit = proceedsUsdc - stakeUsd;
      stakeLine = `\n<b>Stake:</b> $${stakeUsd.toFixed(2)} → <b>$${proceedsUsdc.toFixed(2)}</b> (+$${profit.toFixed(2)})`;
    } else if (isWin) {
      // Won directionally but proceeds are unavailable (e.g. auto-redeemed by Polymarket before our redeemer ran)
      stakeLine = `\n<b>Stake:</b> $${stakeUsd.toFixed(2)} (proceeds unknown)`;
    } else {
      stakeLine = `\n<b>Stake lost:</b> $${stakeUsd.toFixed(2)}`;
    }
  }

  const reasonLine = reason ? `\n<b>Detail:</b> ${escapeHtml(reason)}` : '';

  const text =
    `${emoji} <b>${header}</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(question)}\n` +
    `<b>Side:</b> ${escapeHtml(direction)}` +
    stakeLine +
    reasonLine;

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
  stakeUsd?: number;
  /** Override the displayed side label (e.g. 'DOWN' for oracle-lag positions). */
  displayDirection?: string;
}): Promise<void> {
  const { question, side, txHash, valueUsdc } = opts;
  const sideLabel = opts.displayDirection ?? side.toUpperCase();
  const profitLine =
    opts.stakeUsd != null && opts.stakeUsd > 0
      ? `\n<b>Profit:</b> +$${(valueUsdc - opts.stakeUsd).toFixed(2)} USDC (stake was $${opts.stakeUsd.toFixed(2)})`
      : '';

  const text =
    `🏆 <b>Position Redeemed</b>\n\n` +
    `<b>Market:</b> ${escapeHtml(question)}\n` +
    `<b>Winning side:</b> ${escapeHtml(sideLabel)}\n` +
    `<b>Proceeds:</b> $${valueUsdc.toFixed(2)} USDC` +
    profitLine +
    (txHash ? `\n<b>Tx:</b> <code>${escapeHtml(txHash)}</code>` : '');

  await notify(text);
}

/**
 * Notify that a CLOB position won but cannot be auto-redeemed (Magic Proxy wallet).
 * Prompts Romeo to claim manually on polymarket.com.
 */
export async function notifyManualRedemptionRequired(opts: {
  conditionId: string;
  direction: 'YES' | 'NO';
  question?: string;
  estimatedUsdc?: number;
}): Promise<void> {
  const amountLine =
    opts.estimatedUsdc != null && opts.estimatedUsdc > 0
      ? `\n<b>Estimated value:</b> ~$${opts.estimatedUsdc.toFixed(2)} USDC`
      : '';
  const questionLine = opts.question ? `\n<b>Market:</b> ${escapeHtml(opts.question)}` : '';

  const text =
    `💸 <b>Manual Redemption Required</b>\n` +
    questionLine +
    `\n<b>Direction:</b> ${opts.direction} (won)` +
    amountLine +
    `\n<b>Condition:</b> <code>${escapeHtml(opts.conditionId.slice(0, 20))}...</code>` +
    `\n\n⚠️ Magic Proxy wallet — cannot auto-redeem on-chain.\n` +
    `<b>Action:</b> Claim at <a href="https://polymarket.com">polymarket.com</a>`;

  await notify(text);
}

/**
 * Notify weekly calibration summary (Phase 8b).
 */
export async function notifyCalibrationUpdate(lines: string[]): Promise<void> {
  const text =
    `📊 <b>Weekly Calibration Update</b>\n\n` + lines.map((l) => escapeHtml(l)).join('\n');

  await notify(text);
}

/**
 * Notify when a delta hedge is opened on Hyperliquid alongside a PM position.
 */
export async function notifyHedgeOpened(opts: {
  pmMarketId: string;
  pmQuestion: string;
  hlSymbol: string;
  direction: 'LONG' | 'SHORT';
  stakeUsd: number;
  txHash?: string;
}): Promise<void> {
  const text =
    `🔗 <b>Delta Hedge Opened</b>\n\n` +
    `<b>HL Symbol:</b> ${escapeHtml(opts.hlSymbol)} ${opts.direction}\n` +
    `<b>Stake:</b> $${opts.stakeUsd.toFixed(2)} USDC  |  <b>Leverage:</b> 1x\n` +
    `<b>Hedging:</b> ${escapeHtml(opts.pmQuestion)}\n` +
    `<b>PM Market:</b> ${opts.pmMarketId}\n` +
    (opts.txHash ? `<b>Tx:</b> <code>${escapeHtml(opts.txHash)}</code>` : '');

  await notify(text);
}

// ── Utility ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Export for testing
export { sendMessage as _sendMessage };
