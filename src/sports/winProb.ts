/**
 * Pure closed-form win-probability models per league.
 *
 * These are deliberately simple starter models — the scanner gates at
 * SPORTS_MIN_EDGE (~8%) which is wide enough to absorb calibration error.
 * Coefficients refit later from accumulated divergence logs.
 *
 * Inspiration: inpredictable / FiveThirtyEight logistic win-probability
 * models (score-differential scaled by remaining time). No external data,
 * no training in this phase.
 */

function sigmoid(x: number): number {
  if (!Number.isFinite(x)) return 0.5;
  if (x > 40) return 1;
  if (x < -40) return 0;
  return 1 / (1 + Math.exp(-x));
}

export interface NbaState {
  /** Home score minus away score. */
  scoreDiff: number;
  /** Total seconds remaining in regulation / game (<=0 at final buzzer). */
  secondsRemaining: number;
  /** Optional possession indicator: +1 home has ball, -1 away, 0 unknown. */
  possession?: number;
  /** True if the game has entered overtime. */
  inOvertime?: boolean;
}

/**
 * NBA home-team win probability.
 *
 * Model: logistic on score-differential scaled by sqrt of minutes remaining.
 * Shape borrowed from Stern (1994) / inpredictable; constants picked to match
 * known anchors (5-point lead with 1 minute left ≈ 0.93 home win prob).
 *
 * Boundary: tied game at the final buzzer returns 0.5 (overtime coin-flip).
 */
export function nbaWinProb(state: NbaState): number {
  const { scoreDiff, secondsRemaining } = state;
  const minutesRemaining = Math.max(secondsRemaining, 0) / 60;

  // End-of-game handling.
  if (minutesRemaining <= 0) {
    if (scoreDiff > 0) return 1;
    if (scoreDiff < 0) return 0;
    return 0.5;
  }

  // Baseline home-court edge (~55% on a neutral-state game).
  const homeEdge = 0.2;
  // Scaled score diff: each point matters more as time runs out.
  const scaled = scoreDiff / Math.sqrt(minutesRemaining + 1);
  // Coefficient picks: tuned so 5 pts with 1 min remaining ≈ 93%.
  const logit = homeEdge + 0.55 * scaled;

  // Small possession nudge (one possession ≈ 2 points).
  const poss = state.possession ?? 0;
  const possNudge = poss * Math.min(0.15, 1 / Math.sqrt(minutesRemaining + 1));

  return sigmoid(logit + possNudge);
}

export interface MlbState {
  /** Home score minus away score. */
  scoreDiff: number;
  /** Current inning (1–9; 10+ for extra innings). */
  inning: number;
  /** True if the home team has not yet batted in the current inning (top half). */
  isTop: boolean;
}

/**
 * MLB home-team win probability.
 *
 * Model: logistic on score-diff scaled by sqrt of innings remaining.
 * Home bats last, so the model carries a small home edge.
 *
 * Calibration anchors:
 *   - tied at start of game          → ~0.54 (home field)
 *   - home up 3 entering bottom 9th  → ~0.97
 *   - away up 1 entering bottom 9th  → ~0.33 (home can tie/win)
 */
export function mlbWinProb(state: MlbState): number {
  const { scoreDiff, inning, isTop } = state;

  // Remaining innings including the current half-inning, so live games always
  // have inningsLeft > 0 (bottom 9th = 0.5, not 0).
  // Extra innings: treat each half the same as the 9th.
  const inningsLeft = Math.max(9 - inning, 0) + (isTop ? 1 : 0.5);

  if (inningsLeft <= 0) {
    // Game over (or extra innings beyond 9 — treat as coin flip for model purposes).
    if (scoreDiff > 0) return 1;
    if (scoreDiff < 0) return 0;
    return 0.5;
  }

  // Home advantage (~54% pre-game) + score scale by innings remaining.
  const homeEdge = 0.15;
  const scaled = scoreDiff / Math.sqrt(inningsLeft + 0.5);
  return sigmoid(homeEdge + 0.8 * scaled);
}

export interface NhlState {
  /** Home score minus away score. */
  scoreDiff: number;
  /** Total seconds remaining in regulation. */
  secondsRemaining: number;
  /** True if the trailing team has pulled its goalie (empty net). */
  emptyNet?: boolean;
  /** 1=1st, 2=2nd, 3=3rd, 4+=OT. */
  period?: number;
}

/**
 * NHL home-team regulation win probability.
 *
 * Model: logistic on score-diff scaled by period-adjusted time remaining.
 * Empty-net in final 90s gives the leading team an extra boost.
 *
 * Calibration anchors:
 *   - up 1 with empty net and 30s left  → ~0.90 (home)
 *   - up 2 with 5 minutes left          → ~0.92 (home)
 *   - tied at final buzzer              → 0.5 (OT coin-flip)
 */
export function nhlWinProb(state: NhlState): number {
  const { scoreDiff, secondsRemaining } = state;
  if (secondsRemaining <= 0) {
    if (scoreDiff > 0) return 1;
    if (scoreDiff < 0) return 0;
    return 0.5;
  }

  const minutesRemaining = secondsRemaining / 60;

  // NHL is lower scoring than NBA so each goal dominates harder.
  const homeEdge = 0.15;
  const scaled = scoreDiff / Math.sqrt(minutesRemaining + 0.5);
  let logit = homeEdge + 1.35 * scaled;

  // Empty-net adjustment — only applies in the final 90 seconds.
  if (state.emptyNet && secondsRemaining <= 90 && scoreDiff !== 0) {
    // Sign of scoreDiff is the leading team; empty net extends their edge.
    logit += Math.sign(scoreDiff) * 0.6;
  }

  return sigmoid(logit);
}
