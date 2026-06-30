import { describe, it, expect } from 'vitest';
import {
  isYes,
  distanceToBracket,
  priceBucket,
  distanceBucket,
  edgeBucket,
  candidateFromShadowPayload,
  candidateKey,
  groupBy,
  winRate,
  avgPrice,
  realizedEdge,
  emptyStat,
  addToStat,
  attributeExecutedByFamily,
  type Candidate,
  type GroundTruth,
  type ExecutedRow,
} from '../entryBacktest.js';

describe('isYes (half-open ±0.5 boundary)', () => {
  it('range bracket includes [low-0.5, high+0.5)', () => {
    expect(isYes(70, 70, 71)).toBe(true);
    expect(isYes(69.5, 70, 71)).toBe(true);   // low edge included
    expect(isYes(71.4, 70, 71)).toBe(true);
    expect(isYes(71.5, 70, 71)).toBe(false);  // high edge excluded (half-open)
    expect(isYes(69.4, 70, 71)).toBe(false);
  });
  it('high tail (high=null) extends to +Infinity', () => {
    expect(isYes(200, 58, null)).toBe(true);
    expect(isYes(57.5, 58, null)).toBe(true);
    expect(isYes(57.4, 58, null)).toBe(false);
  });
  it('low tail (low=null) extends to -Infinity', () => {
    expect(isYes(-50, null, 39)).toBe(true);
    expect(isYes(39.4, null, 39)).toBe(true);
    expect(isYes(39.5, null, 39)).toBe(false);
  });
});

describe('distanceToBracket (±0.5° resolver boundaries, matches scanner)', () => {
  it('0 when the forecast rounds into the bracket', () => {
    expect(distanceToBracket(70.5, 70, 71)).toBe(0);
    expect(distanceToBracket(69.8, 70, 71)).toBe(0); // 69.8 >= 69.5 boundary → inside
    expect(distanceToBracket(71.4, 70, 71)).toBe(0); // 71.4 < 71.5 boundary → inside
  });
  it('measured from the ±0.5 boundary, not the raw bound', () => {
    expect(distanceToBracket(67, 70, 71)).toBe(2.5);  // 69.5 - 67
    expect(distanceToBracket(74, 70, 71)).toBe(2.5);  // 74 - 71.5
  });
  it('0 on the open side of a tail; measured from the boundary on the closed side', () => {
    expect(distanceToBracket(200, 58, null)).toBe(0);    // above a high tail's floor → inside
    expect(distanceToBracket(40, 58, null)).toBe(17.5);  // 57.5 - 40
    expect(distanceToBracket(-50, null, 39)).toBe(0);
  });
});

describe('bucket helpers', () => {
  it('priceBucket boundaries', () => {
    expect(priceBucket(0.05)).toBe('0.00-0.10');
    expect(priceBucket(0.30)).toBe('0.25-0.40');
    expect(priceBucket(0.69)).toBe('0.55-0.70');
    expect(priceBucket(0.95)).toBe('0.85-1.00');
    expect(priceBucket(NaN)).toBe('na');
  });
  it('distanceBucket boundaries', () => {
    expect(distanceBucket(0)).toBe('inside');
    expect(distanceBucket(0.3)).toBe('0.0-0.5'); // rounds-into-bracket danger zone
    expect(distanceBucket(0.7)).toBe('0.5-1.0');
    expect(distanceBucket(2.5)).toBe('2.0-3.0');
    expect(distanceBucket(5)).toBe('3.0+');
  });
  it('edgeBucket boundaries', () => {
    expect(edgeBucket(-0.01)).toBe('edge<0');
    expect(edgeBucket(0.03)).toBe('edge 0.00-0.05');
    expect(edgeBucket(0.25)).toBe('edge 0.20+');
    expect(edgeBucket(NaN)).toBe('na');
  });
});

// ── Candidate scoring + family re-derivation ──────────────────────────────────

const GT: GroundTruth = {
  high: new Map([['chicago|2026-06-15', 72]]), // resolved high 72°F
  low: new Map([['chicago|2026-06-15', 50]]),
};

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    city: 'chicago', targetDate: '2026-06-15', metric: 'high', bracket: '70-71°F',
    tradeSide: 'NO', outcomePrice: 0.6, daysOut: 1, correctedForecastHigh: 75,
    forecastSource: 'open-meteo', ...over,
  };
}

describe('candidateFromShadowPayload', () => {
  it('scores a NO that wins because the actual landed outside the bracket', () => {
    // actual high 72 is NOT in [69.5, 71.5) → bracket resolved NO → NO side wins.
    const c = candidateFromShadowPayload('m1', payload(), 0.12, '2026-06-15T10:00:00Z', GT);
    expect(c).not.toBeNull();
    expect(c!.side).toBe('NO');
    expect(c!.win).toBe(true);
    expect(c!.family).toBe('native_no');
    expect(c!.entryPrice).toBe(0.6);
    expect(c!.metric).toBe('high');
  });

  it('scores a YES that loses (actual outside its bracket)', () => {
    const c = candidateFromShadowPayload('m1', payload({ tradeSide: 'YES', outcomePrice: 0.4 }), 0.1, 'ts', GT);
    expect(c!.side).toBe('YES');
    expect(c!.win).toBe(false); // 72 not in [69.5,71.5) → YES loses
    expect(c!.family).toBe('interior_yes');
  });

  it('re-derives far_no_ladder from noLadderKind', () => {
    const c = candidateFromShadowPayload('m1', payload({ noLadderKind: 'far' }), 0.2, 'ts', GT);
    expect(c!.family).toBe('far_no_ladder');
    expect(c!.selectedBy).toBe('ladder_bid');
  });

  it('re-derives resday_lockin_no from liveObservationConfirmed', () => {
    const c = candidateFromShadowPayload('m1', payload({ liveObservationConfirmed: true }), 0.3, 'ts', GT);
    expect(c!.family).toBe('resday_lockin_no');
    expect(c!.selectedBy).toBe('lockin');
  });

  it('re-derives market_favorite_fade when the bracket is the market favorite', () => {
    const c = candidateFromShadowPayload('m1', payload({ marketFavoriteBracket: '70-71°F' }), 0.1, 'ts', GT);
    expect(c!.family).toBe('market_favorite_fade');
  });

  it('flags modalDisagreement when modal != favorite', () => {
    const c = candidateFromShadowPayload('m1', payload({ modelModalBracket: '72-73°F', marketFavoriteBracket: '74-75°F' }), 0.1, 'ts', GT);
    expect(c!.modalDisagreement).toBe(true);
  });

  it('uses the low extreme for a low-metric market', () => {
    // low resolved 50; bracket 49-50 → [48.5,50.5) includes 50 → YES; NO loses.
    const c = candidateFromShadowPayload('m1', payload({ metric: 'low', bracket: '49-50°F', tradeSide: 'NO' }), 0.1, 'ts', GT);
    expect(c!.metric).toBe('low');
    expect(c!.win).toBe(false);
  });

  it('treats a missing metric as high (legacy rows)', () => {
    const pl = payload(); delete pl.metric;
    const c = candidateFromShadowPayload('m1', pl, 0.1, 'ts', GT);
    expect(c!.metric).toBe('high');
  });

  it('returns null when ground truth is missing (unresolved)', () => {
    const c = candidateFromShadowPayload('m1', payload({ targetDate: '2099-01-01' }), 0.1, 'ts', GT);
    expect(c).toBeNull();
  });

  it('returns null on an unparseable bracket label', () => {
    expect(candidateFromShadowPayload('m1', payload({ bracket: 'nonsense' }), 0.1, 'ts', GT)).toBeNull();
  });

  it('derives distance from forecast when farNoDistance is absent', () => {
    // forecast 75, bracket 70-71 → distance = 75 - (71+0.5) = 3.5 (±0.5 boundary)
    const c = candidateFromShadowPayload('m1', payload(), 0.1, 'ts', GT);
    expect(c!.distance).toBe(3.5);
  });
});

describe('candidateKey', () => {
  it('is stable per (metric, city, date, bracket, daysOut)', () => {
    const c = candidateFromShadowPayload('m1', payload(), 0.1, 'ts', GT)!;
    expect(candidateKey(c)).toBe('high|chicago|2026-06-15|70-71°F|1');
  });
});

// ── Aggregation ───────────────────────────────────────────────────────────────

function cand(over: Partial<Candidate>): Candidate {
  return {
    marketId: 'm', city: 'chicago', targetDate: '2026-06-15', metric: 'high', bracket: '70-71°F',
    shape: 'range', source: 'open-meteo', daysOut: 1, horizon: '0-1', side: 'NO',
    family: 'native_no', selectedBy: 'raw_edge', modalDisagreement: false,
    entryPrice: 0.6, edge: 0.1, distance: 1, wouldTrade: true, win: true, observedAt: 'ts',
    ...over,
  };
}

describe('aggregation', () => {
  it('winRate / avgPrice / realizedEdge over a small cohort', () => {
    const s = emptyStat();
    addToStat(s, cand({ win: true, entryPrice: 0.6 }));   // edge +0.4
    addToStat(s, cand({ win: false, entryPrice: 0.6 }));  // edge -0.6
    addToStat(s, cand({ win: true, entryPrice: 0.6 }));   // edge +0.4
    expect(s.n).toBe(3);
    expect(winRate(s)).toBeCloseTo(2 / 3, 10);
    expect(avgPrice(s)).toBeCloseTo(0.6, 10);
    // realizedEdge = winRate - avgPrice = 0.6667 - 0.6
    expect(realizedEdge(s)).toBeCloseTo(2 / 3 - 0.6, 10);
  });

  it('groupBy partitions by the key function', () => {
    const m = groupBy(
      [cand({ family: 'native_no' }), cand({ family: 'native_no' }), cand({ family: 'tail_yes', side: 'YES' })],
      (c) => c.family,
    );
    expect(m.get('native_no')!.n).toBe(2);
    expect(m.get('tail_yes')!.n).toBe(1);
  });

  it('realizedEdge equals winRate minus break-even price', () => {
    const m = groupBy([cand({ win: true, entryPrice: 0.7 }), cand({ win: true, entryPrice: 0.7 })], () => 'x');
    const s = m.get('x')!;
    expect(realizedEdge(s)).toBeCloseTo(winRate(s) - avgPrice(s), 10);
  });
});

// ── Executed → family attribution ─────────────────────────────────────────────

describe('attributeExecutedByFamily', () => {
  const cands: Candidate[] = [
    cand({ marketId: 'mkt1', side: 'NO', family: 'native_no', observedAt: '2026-06-14T00:00:00Z' }),
    cand({ marketId: 'mkt1', side: 'NO', family: 'resday_lockin_no', observedAt: '2026-06-15T12:00:00Z' }),
    cand({ marketId: 'mkt2', side: 'NO', family: 'market_favorite_fade', observedAt: '2026-06-14T00:00:00Z' }),
  ];

  it('attributes a trade to the nearest shadow candidate at/before entry', () => {
    const executed: ExecutedRow[] = [
      // entered res-day after the lockin candidate → resday_lockin_no
      { market_id: 'mkt1', question: 'q', opened_at: '2026-06-15T13:00:00Z', result: 'won', return_pct: 50, stake_usd: 5, direction: 'NO' },
    ];
    const m = attributeExecutedByFamily(executed, cands);
    expect(m.get('resday_lockin_no')!.n).toBe(1);
    expect(m.get('resday_lockin_no')!.won).toBe(1);
    expect(m.get('resday_lockin_no')!.pnl).toBeCloseTo(2.5, 10); // 5 * 50/100
  });

  it('attributes a trade BETWEEN two scans to the family AS IT WAS at entry (not a future scan)', () => {
    // mkt1 was native_no on 06-14, then became resday_lockin_no on 06-15T12 once
    // live obs confirmed. A trade that executed on 06-15T06 — BEFORE confirmation —
    // entered as native_no and must attribute there, not to the later lockin row.
    // This is the case the deduped candidate set would mis-attribute (the two rows
    // share a dedup key on res-day), so attribution must run on the full history.
    const executed: ExecutedRow[] = [
      { market_id: 'mkt1', question: 'q', opened_at: '2026-06-15T06:00:00Z', result: 'lost', return_pct: -100, stake_usd: 4, direction: 'NO' },
    ];
    const m = attributeExecutedByFamily(executed, cands);
    expect(m.get('native_no')!.n).toBe(1);
    expect(m.get('native_no')!.pnl).toBeCloseTo(-4, 10);
    expect(m.has('resday_lockin_no')).toBe(false);
  });

  it('falls back to the earliest candidate when entry precedes all shadow rows', () => {
    const executed: ExecutedRow[] = [
      { market_id: 'mkt1', question: 'q', opened_at: '2026-06-13T00:00:00Z', result: 'lost', return_pct: -100, stake_usd: 5, direction: 'NO' },
    ];
    const m = attributeExecutedByFamily(executed, cands);
    expect(m.get('native_no')!.n).toBe(1);
    expect(m.get('native_no')!.pnl).toBeCloseTo(-5, 10);
  });

  it("buckets a trade with no matching shadow row under 'unmatched'", () => {
    const executed: ExecutedRow[] = [
      { market_id: 'unknown', question: 'q', opened_at: '2026-06-15T00:00:00Z', result: 'lost', return_pct: -100, stake_usd: 3, direction: 'NO' },
    ];
    const m = attributeExecutedByFamily(executed, cands);
    expect(m.get('unmatched')!.n).toBe(1);
  });

  it('matches on side — a YES trade does not borrow a NO candidate', () => {
    const executed: ExecutedRow[] = [
      { market_id: 'mkt1', question: 'q', opened_at: '2026-06-15T13:00:00Z', result: 'won', return_pct: 50, stake_usd: 5, direction: 'YES' },
    ];
    const m = attributeExecutedByFamily(executed, cands);
    expect(m.get('unmatched')!.n).toBe(1);
    expect(m.has('resday_lockin_no')).toBe(false);
  });
});
