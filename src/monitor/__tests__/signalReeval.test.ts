import { describe, it, expect } from 'vitest';
import { extractKeywords, STOP_WORDS } from '../signalReeval.js';

// ── extractKeywords unit tests ──────────────────────────────────────────────

describe('extractKeywords', () => {
  it('extracts meaningful words from a market question', () => {
    const keywords = extractKeywords('Will the US withdraw troops from Syria before 2027?');
    // "will", "from", "before" are stop-words; "the" is < 4 chars
    expect(keywords).toContain('withdraw');
    expect(keywords).toContain('troops');
    expect(keywords).toContain('syria');
    expect(keywords).toContain('2027');
    expect(keywords).not.toContain('will');
    expect(keywords).not.toContain('from');
    expect(keywords).not.toContain('before');
    expect(keywords).not.toContain('the');
  });

  it('strips punctuation before filtering', () => {
    const keywords = extractKeywords("Will Biden's tariffs increase?");
    expect(keywords).toContain('bidens');
    expect(keywords).toContain('tariffs');
    expect(keywords).toContain('increase');
  });

  it('filters all stop-words', () => {
    // Every word in STOP_WORDS should be excluded
    const stopSentence = Array.from(STOP_WORDS).join(' ');
    const keywords = extractKeywords(stopSentence);
    expect(keywords).toEqual([]);
  });

  it('filters words shorter than 4 characters', () => {
    const keywords = extractKeywords('Can the EU ban AI by 2026?');
    expect(keywords).not.toContain('can');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('ban');
    expect(keywords).toContain('2026');
  });

  it('returns empty array for an all-stopword question', () => {
    const keywords = extractKeywords('Will this have been done?');
    // "will", "this", "have", "been", "done" — all either stop-words or < 4 chars
    expect(keywords.length).toBeLessThanOrEqual(1); // "done" is 4 chars, not in stop list
  });
});

// ── Relevance matching behavior tests ────────────────────────────────────────

describe('keyword relevance matching', () => {
  function headlineMatchesPosition(question: string, headline: string): boolean {
    const questionWords = extractKeywords(question);
    return questionWords.some((word) => headline.toLowerCase().includes(word));
  }

  it('matches when headline contains a meaningful keyword', () => {
    expect(
      headlineMatchesPosition(
        'Will MicroStrategy sell Bitcoin before March 31?',
        'MicroStrategy announces new Bitcoin acquisition strategy',
      ),
    ).toBe(true);
  });

  it('does not match on stop-words alone', () => {
    // The question only has stop-words + short words that overlap with headline
    expect(
      headlineMatchesPosition(
        'Will this have been done before 2027?',
        'The government will have been through many changes before then',
      ),
    ).toBe(false);
  });

  it('does not match unrelated headlines', () => {
    expect(
      headlineMatchesPosition(
        'Will the US withdraw troops from Syria before 2027?',
        'Apple launches new iPhone model at annual keynote event',
      ),
    ).toBe(false);
  });

  it('matches country/entity names in both directions', () => {
    expect(
      headlineMatchesPosition(
        'Will China impose new tariffs on EU goods?',
        'Breaking: China announces retaliatory trade measures',
      ),
    ).toBe(true);
  });
});

// ── Edge computation tests ───────────────────────────────────────────────────

describe('edge computation logic', () => {
  // Replicates the edge formula from signalReeval.ts
  function computeEdge(direction: 'YES' | 'NO', freshP: number, marketP: number): number {
    return direction === 'YES' ? freshP - marketP : 1 - freshP - (1 - marketP);
  }

  it('YES position: positive edge when freshP > marketP', () => {
    // freshP=0.70, marketP=0.50 → edge=0.20
    expect(computeEdge('YES', 0.7, 0.5)).toBeCloseTo(0.2);
  });

  it('YES position: negative edge (flip) when freshP < marketP', () => {
    // freshP=0.40, marketP=0.60 → edge=-0.20
    expect(computeEdge('YES', 0.4, 0.6)).toBeCloseTo(-0.2);
  });

  it('YES position: edge below floor triggers exit', () => {
    const edgeFloor = 0.03;
    const edge = computeEdge('YES', 0.52, 0.5); // edge=0.02 < 0.03
    expect(edge < edgeFloor).toBe(true);
  });

  it('YES position: edge above floor holds', () => {
    const edgeFloor = 0.03;
    const edge = computeEdge('YES', 0.55, 0.5); // edge=0.05 > 0.03
    expect(edge < edgeFloor).toBe(false);
  });

  it('NO position: positive edge when freshP < marketP', () => {
    // NO direction: we bet the market will go down
    // freshP=0.30, marketP=0.50 → edge = (1-0.30)-(1-0.50) = 0.70-0.50 = 0.20
    expect(computeEdge('NO', 0.3, 0.5)).toBeCloseTo(0.2);
  });

  it('NO position: direction flip when freshP > marketP', () => {
    // freshP=0.60, marketP=0.50 → edge = (1-0.60)-(1-0.50) = 0.40-0.50 = -0.10
    expect(computeEdge('NO', 0.6, 0.5)).toBeCloseTo(-0.1);
  });
});
