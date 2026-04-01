# PRD: Continuous Self-Improvement (Phase 8)

**Date:** 2026-03-29  
**Author:** Devin  
**Status:** Draft — awaiting Romeo sign-off

---

## Problem

Every decision the PGA makes is stateless. The consensus estimator has no memory of whether similar signals were profitable in the past. The position sizing uses static Kelly fractions with no feedback loop. The system cannot learn from its own track record.

This matters because:
- The LLM's probability estimates are noisy. Without calibration data, the system can't tell if the model consistently over- or underestimates on specific signal types.
- Losing streaks on a particular category (e.g. macro signals) won't reduce future exposure to that category.
- Winners are forgotten as fast as losers.

---

## Proposed Solution: Three-Layer Feedback Loop

### Layer 1 — Outcome Recorder
Record every closed position with full signal context. This is the raw data everything else builds on.

### Layer 2 — Historical Context Injection
Inject recent similar outcomes as context into LLM prompts. The model adjusts its probability estimate based on how similar signals performed.

### Layer 3 — Calibration & Auto-Tuning
Weekly analysis of outcome records to detect systematic bias per category. Apply correction factors at execution time without LLM calls.

---

## Layer 1: Outcome Recorder

### What to record

On every position close (via `resolutionRedeemer.ts` and `takeProfitExecutor.ts`), write a `PositionOutcome` record:

```typescript
interface PositionOutcome {
  // Identity
  id: string;                      // uuid
  closedAt: string;                // ISO timestamp
  source: 'osint' | 'copytrade' | 'spot' | 'arb' | 'crypto-arb';

  // Signal context
  category: string;                // geopolitical, macro, crypto-regulatory, etc.
  question: string;                // market question (truncated to 200 chars)
  direction: 'YES' | 'NO';
  urgencyScore?: number;           // OSINT only
  consensusProbability: number;    // model's stated probability at entry
  divergence: number;              // edge at entry (fairValue - pmPrice)

  // Outcome
  result: 'won' | 'lost' | 'pushed'; // pushed = position closed at ~entry price
  returnPct: number;               // actual return %
  holdingHours: number;            // time held

  // Venue
  executionVenue: 'simmer' | 'clob' | 'hyperliquid';
}
```

### Storage

Redis sorted set: `outcomes:<category>` sorted by `closedAt` timestamp (epoch ms).
Also a global set: `outcomes:all` for cross-category queries.

Key per record: `outcome:<id>` (hash). TTL: 180 days.

Indices (sorted sets, score = epoch ms):
- `outcomes:all`
- `outcomes:<category>` (e.g. `outcomes:geopolitical`)
- `outcomes:source:<source>` (e.g. `outcomes:source:copytrade`)

On write: `ZADD outcomes:all <ts> <id>` + `ZADD outcomes:<category> <ts> <id>` + `HSET outcome:<id> ...fields`.

Keep last 500 outcomes per category (prune on write if ZCARD > 500).

### Where to hook in

**Win (full redemption):** `resolutionRedeemer.ts` — after `creditProceeds()` call, before position removal from ledger.

**Exit (take-profit / stop-loss / re-eval):** `takeProfitExecutor.ts` — after successful `closePosition()`, using `returnPct` already computed.

**Copytrade exits:** `copytrade/worker.ts` — after mirror exits are processed (exits > 0 path).

---

## Layer 2: Historical Context Injection

### Where to inject

`src/mapping/consensusCalculator.ts` — the `estimateConsensusProbability()` function already builds an LLM prompt. Add a `historicalContext` block before the probability question.

### Query strategy

Before calling the LLM, fetch the 5 most recent outcomes for the same category:

```typescript
async function getRecentOutcomes(category: string, redis: Redis, limit = 5): Promise<PositionOutcome[]>
```

Use `ZREVRANGE outcomes:<category> 0 <limit-1>` to get the N most recent outcome IDs, then `HGETALL outcome:<id>` for each.

If fewer than 3 outcomes exist for the category, skip injection (not enough signal yet).

### Prompt block format

```
Historical performance on ${category} signals (last ${n} closed positions):
${outcomes.map(o =>
  `- "${o.question.slice(0, 100)}" → ${o.direction} at ${(o.consensusProbability * 100).toFixed(0)}% confidence → ${o.result.toUpperCase()} (${o.returnPct > 0 ? '+' : ''}${o.returnPct.toFixed(1)}% in ${o.holdingHours.toFixed(1)}h)`
).join('\n')}

Use this track record to calibrate your probability estimate. If similar signals consistently underperformed, apply downward pressure. If they overperformed, apply upward pressure.
```

### Token cost

5 recent outcomes × ~40 tokens each = ~200 tokens per consensus call. At $0.15/1M tokens (GPT-4o-mini), that's ~$0.00003 per call. Negligible.

### Guardrails

- Never inject outcomes from a different category (prevents cross-contamination)
- Cap injection at 5 outcomes regardless of history depth
- If Redis is unavailable, skip injection and proceed without context (non-blocking)
- Outcomes are informational — the LLM may weight them as it sees fit; we don't force a correction

---

## Layer 3: Calibration Tracker

### What it measures

For each category, track:
- **Win rate** — % of positions that resolved in our favour
- **Calibration error** — when model says 70% probability, do those positions win 70% of the time?
- **Average return** — mean returnPct across all closed positions

### Implementation

New script: `src/shared/calibration.ts`

```typescript
interface CalibrationStats {
  category: string;
  updatedAt: string;
  sampleSize: number;
  winRate: number;              // 0-1
  avgReturn: number;            // mean returnPct
  // Calibration buckets: probability range → actual win rate
  calibration: {
    bucket: string;             // e.g. "0.5-0.6"
    stated: number;             // midpoint of bucket
    actual: number;             // observed win rate in bucket
    count: number;
  }[];
  // Derived correction factor
  // If model says 0.70 but actual win rate in 0.65-0.75 bucket is 0.55,
  // correctionFactor = 0.55 / 0.70 = 0.786 → multiply edge by this before Kelly sizing
  edgeCorrectionFactor: number;
}
```

Stored in Redis: `calibration:<category>` (hash), refreshed weekly.

### Weekly cron

New npm script: `npm run cron:calibrate`
New cron entry: `0 3 * * MON` (Monday 03:00 UTC — after shortlist refresh)

The cron:
1. Reads all outcomes per category (ZRANGE)
2. Computes calibration stats
3. Writes `calibration:<category>` to Redis
4. Logs a summary to Telegram: "Weekly calibration update: geopolitical win rate 61%, macro win rate 44% (correction applied)"

### Application at execution time

In `executor.ts`, after computing `signal.edgeMagnitude` but before Kelly sizing:

```typescript
const cal = await getCalibrationStats(signal.category, redis);
if (cal && cal.sampleSize >= 20 && cal.edgeCorrectionFactor < 1.0) {
  // Only apply downward correction — never amplify beyond stated edge
  signal.edgeMagnitude = signal.edgeMagnitude * cal.edgeCorrectionFactor;
  logger.info('[executor] calibration correction applied', {
    category: signal.category,
    correctionFactor: cal.edgeCorrectionFactor,
    originalEdge: originalEdge,
    adjustedEdge: signal.edgeMagnitude,
  });
}
```

Minimum 20 samples before correction is applied — avoids overcorrecting on sparse data.

---

## New Files

| File | Purpose |
|---|---|
| `src/shared/outcomeRecorder.ts` | `recordOutcome()`, `getRecentOutcomes()`, `pruneOutcomes()` |
| `src/shared/calibration.ts` | `computeCalibration()`, `getCalibrationStats()`, `applyCalibrationCorrection()` |
| `src/cron/calibrate.ts` | Weekly calibration cron entrypoint |

## Modified Files

| File | Change |
|---|---|
| `src/monitor/resolutionRedeemer.ts` | Call `recordOutcome()` on win |
| `src/monitor/takeProfitExecutor.ts` | Call `recordOutcome()` on exit |
| `src/mapping/consensusCalculator.ts` | Inject `getRecentOutcomes()` context into prompt |
| `src/execution/executor.ts` | Apply `applyCalibrationCorrection()` before Kelly sizing |
| `src/shared/config.ts` | Add `CALIBRATION_ENABLED`, `CALIBRATION_MIN_SAMPLES` |
| `package.json` | Add `cron:calibrate` script |
| `README.md` | Document new modules and flow |

---

## Config

```
CALIBRATION_ENABLED=true           # master switch
CALIBRATION_MIN_SAMPLES=20         # minimum outcomes before correction applied
OUTCOME_HISTORY_DAYS=180           # TTL for outcome records
OUTCOME_MAX_PER_CATEGORY=500       # prune after this many per category
CONTEXT_INJECTION_ENABLED=true     # enable historical context in LLM prompts
CONTEXT_INJECTION_LIMIT=5          # max outcomes to inject per prompt
```

---

## Tests

- `outcomeRecorder.test.ts` — write, read, prune, Redis unavailable (graceful skip)
- `calibration.test.ts` — correct win rate, calibration bucket assignment, correction factor computation, min samples guard
- `consensusCalculator.test.ts` — extend existing test: with outcomes injected, prompt includes history block; without outcomes, prompt unchanged

---

## Phases

**Phase 8a — Outcome Recorder + Context Injection**
- `outcomeRecorder.ts`
- Hook into resolutionRedeemer + takeProfitExecutor
- Context injection in consensusCalculator
- Tests

**Phase 8b — Calibration Tracker**
- `calibration.ts`
- Weekly cron
- Correction factor application in executor
- Telegram weekly summary
- Tests

---

## Open Questions for Romeo

1. **Outcome retention:** 180 days / 500 records per category — reasonable, or adjust?
2. **Context injection:** 5 recent outcomes is simple. Alternative: most similar outcomes by question embedding (requires pgvector or Redis vector search). Worth the complexity?
3. **Downward-only correction:** The current spec only applies correction when the model is overconfident (edgeCorrectionFactor < 1.0). Should we also allow upward correction when model is underconfident?
4. **Start Phase 8a now or wait for PR #119 to merge to main first?**
