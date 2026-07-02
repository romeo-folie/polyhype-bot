/**
 * Native exchange-side stop-loss trigger computation for Hyperliquid entries.
 *
 * Context (2026-07-02 HL review): 8 of 21 losing hl-momentum trades since 06-12
 * exited at the FUTURES_MAX_LOSS_ROE_PCT backstop (−$7.99 — the largest loss
 * bucket) because the effective software stop was wider than the backstop:
 *  - meme symbols: HL_MOMENTUM_MEME_SL_FLOOR_PCT=8 (price %) always clamps the
 *    ATR stop up to 8% price, while the −25% ROE backstop sits at 25/leverage
 *    (≈2.5% price at 10x) — the design stop is unreachable;
 *  - non-meme: ATR×2.75 exceeds 25/leverage whenever entry ATR > ~0.9%.
 * The backstop is margin-based, so its price distance varies inversely with
 * leverage (WIF at ~4.7x was allowed −5.3% price before exiting).
 *
 * This module computes where the software stop will ACTUALLY bind (min of the
 * design stop and the ROE backstop, both in price %) so a reduce-only
 * stop-market trigger can rest exchange-side slightly wider than it. In normal
 * operation the futures monitor still exits first; the native trigger is a hard
 * floor for gaps, monitor downtime, and fast dumps that outrun the 5s poll.
 */

export interface NativeStopParams {
  entryPrice: number;
  direction: 'LONG' | 'SHORT';
  /** Leverage requested at entry (updateLeverage was called with this). */
  leverage: number;
  /** Design SL in price % (positive magnitude) — frozen ATR SL when captured. */
  designSlPricePct?: number | undefined;
  /** Fallback fixed SL in ROE % (positive magnitude), e.g. HL_MOMENTUM_STOP_LOSS_PCT. */
  fixedSlRoePct: number;
  /** FUTURES_MAX_LOSS_ROE_PCT (positive magnitude); 0 disables the backstop. */
  maxLossRoePct: number;
  /** Multiplier applied to the effective stop distance (≥1) so the software
   *  monitor exits first in normal operation. */
  bufferMult: number;
}

export interface NativeStopResult {
  /** Exchange trigger price (unrounded — caller applies tick rounding). */
  triggerPx: number;
  /** The binding software-stop distance in price % (before buffer). */
  effectiveSlPricePct: number;
  /** Trigger distance in price % (after buffer). */
  triggerDistancePct: number;
}

/**
 * Returns null when inputs cannot produce a sane trigger (non-finite entry,
 * zero/negative distances, or a trigger that would cross the entry price).
 */
export function computeNativeStop(p: NativeStopParams): NativeStopResult | null {
  if (!Number.isFinite(p.entryPrice) || p.entryPrice <= 0) return null;
  if (!Number.isFinite(p.leverage) || p.leverage <= 0) return null;

  const fixedSlPricePct =
    Number.isFinite(p.fixedSlRoePct) && p.fixedSlRoePct > 0
      ? p.fixedSlRoePct / p.leverage
      : undefined;

  const designPct =
    p.designSlPricePct !== undefined &&
    Number.isFinite(p.designSlPricePct) &&
    p.designSlPricePct > 0
      ? p.designSlPricePct
      : fixedSlPricePct;
  if (designPct === undefined) return null;

  const backstopPricePct =
    Number.isFinite(p.maxLossRoePct) && p.maxLossRoePct > 0
      ? p.maxLossRoePct / p.leverage
      : Infinity;

  const effectiveSlPricePct = Math.min(designPct, backstopPricePct);
  if (!Number.isFinite(effectiveSlPricePct) || effectiveSlPricePct <= 0) return null;

  const bufferMult = Number.isFinite(p.bufferMult) && p.bufferMult >= 1 ? p.bufferMult : 1;
  const triggerDistancePct = effectiveSlPricePct * bufferMult;
  // A stop ≥100% below entry is meaningless for a LONG (price can't go negative)
  // and indicates a config error either way.
  if (triggerDistancePct >= 100) return null;

  const triggerPx =
    p.direction === 'LONG'
      ? p.entryPrice * (1 - triggerDistancePct / 100)
      : p.entryPrice * (1 + triggerDistancePct / 100);
  if (!Number.isFinite(triggerPx) || triggerPx <= 0) return null;

  return { triggerPx, effectiveSlPricePct, triggerDistancePct };
}
