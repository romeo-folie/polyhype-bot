/**
 * Realized-vol estimator from Chainlink RTDS tick series.
 *
 * Two estimators per asset:
 *   Rolling  — std(log-returns over last 3600 s) × √SECONDS_PER_YEAR
 *   EWMA     — recursive half-life-300s variance × √SECONDS_PER_YEAR
 *
 * Selection: EWMA wins if EWMA > spikeMultiplier × rolling (vol-spike regime).
 * Output is clamped to [sigmaMin, sigmaMax] and suppressed until both
 * warmupTicks ticks have been received AND warmupMinMs wall-clock time has
 * elapsed (warmedUp=false during this period).
 */

import { SECONDS_PER_YEAR } from './blackScholes.js';
import type { ChainlinkTick } from '../spot/feeds/chainlinkFeed.js';

export interface SigmaConfig {
  rollingWindowMs: number;      // 3_600_000 (1 h)
  ewmaHalfLifeS: number;       // 300 (5 min)
  ewmaSpikeMultiplier: number; // 1.5
  sigmaMin: number;            // 0.20
  sigmaMax: number;            // 5.00
  warmupTicks: number;         // 180
  /** Minimum wall-clock ms before warmedUp=true, regardless of tick count. */
  warmupMinMs: number;         // 180_000 (3 min)
}

export const DEFAULT_SIGMA_CONFIG: SigmaConfig = {
  rollingWindowMs: 3_600_000,
  ewmaHalfLifeS: 300,
  ewmaSpikeMultiplier: 1.5,
  sigmaMin: 0.20,
  sigmaMax: 5.00,
  warmupTicks: 180,
  warmupMinMs: 180_000,
};

export interface SigmaResult {
  sigma: number;
  warmedUp: boolean;
  source: 'rolling' | 'ewma';
  sigmaRolling: number;
  sigmaEwma: number;
  ticksInWindow: number;
}

interface EwmaState {
  /** Variance estimate (per-tick²), updated each tick. */
  ewmaVar: number;
  lastValue: number;
  tickCount: number;
  /** Wall-clock ms when the first tick was received for this symbol. */
  firstTickAt: number;
}

export class SigmaCalibrator {
  private readonly cfg: SigmaConfig;
  private readonly state = new Map<string, EwmaState>();

  /** EWMA decay factor per tick (assumes ~1 s cadence from RTDS). */
  private readonly lambda: number;

  constructor(cfg: Partial<SigmaConfig> = {}) {
    this.cfg = { ...DEFAULT_SIGMA_CONFIG, ...cfg };
    this.lambda = Math.exp(-Math.LN2 / this.cfg.ewmaHalfLifeS);
  }

  /** Feed one new RTDS tick. Call on every Chainlink tick for relevant symbols. */
  onTick(tick: ChainlinkTick): void {
    const sym = tick.symbol.toLowerCase();
    const s = this.state.get(sym);
    if (!s) {
      this.state.set(sym, { ewmaVar: 0, lastValue: tick.value, tickCount: 1, firstTickAt: Date.now() });
      return;
    }
    if (s.lastValue > 0 && tick.value > 0) {
      const r = Math.log(tick.value / s.lastValue);
      s.ewmaVar = this.lambda * s.ewmaVar + (1 - this.lambda) * r * r;
    }
    s.lastValue = tick.value;
    s.tickCount++;
  }

  /**
   * Compute σ for `symbol` given a chronological slice of recent ticks.
   * `recentTicks` should be the last `rollingWindowMs` of ticks from
   * `ChainlinkFeed.getTicksSince(symbol, rollingWindowMs)`.
   */
  getSigma(symbol: string, recentTicks: ChainlinkTick[]): SigmaResult {
    const sym = symbol.toLowerCase();
    const s = this.state.get(sym);
    const tickCount = s?.tickCount ?? 0;
    const elapsedMs = s ? Date.now() - s.firstTickAt : 0;
    const warmedUp = tickCount >= this.cfg.warmupTicks && elapsedMs >= this.cfg.warmupMinMs;

    // Rolling σ from provided window
    let sigmaRolling = this.cfg.sigmaMin;
    const logReturns: number[] = [];
    for (let i = 1; i < recentTicks.length; i++) {
      const prev = recentTicks[i - 1]!;
      const curr = recentTicks[i]!;
      if (prev.value > 0 && curr.value > 0) {
        logReturns.push(Math.log(curr.value / prev.value));
      }
    }
    if (logReturns.length >= 2) {
      const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
      const variance =
        logReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0) /
        (logReturns.length - 1);
      sigmaRolling = Math.sqrt(variance) * Math.sqrt(SECONDS_PER_YEAR);
    }

    // EWMA σ
    const sigmaEwma = s
      ? Math.sqrt(s.ewmaVar) * Math.sqrt(SECONDS_PER_YEAR)
      : sigmaRolling;

    // Select spike-regime estimator if EWMA is significantly elevated
    const useEwma = sigmaEwma > this.cfg.ewmaSpikeMultiplier * sigmaRolling;
    const raw = useEwma ? sigmaEwma : sigmaRolling;
    const sigma = Math.max(this.cfg.sigmaMin, Math.min(this.cfg.sigmaMax, raw));

    return {
      sigma,
      warmedUp,
      source: useEwma ? 'ewma' : 'rolling',
      sigmaRolling,
      sigmaEwma,
      ticksInWindow: logReturns.length,
    };
  }
}
