import { describe, it, expect } from 'vitest';
import { extractMarketEntities } from '../entityExtractor.js';

describe('extractMarketEntities', () => {
  it('extracts country names from a geopolitical question', () => {
    const entities = extractMarketEntities('Will Russia invade Ukraine before 2026?');
    expect(entities.has('russia')).toBe(true);
    expect(entities.has('ukraine')).toBe(true);
    expect(entities.has('invade')).toBe(true);
  });

  it('extracts person names and organizations', () => {
    const entities = extractMarketEntities('Will Trump sign an executive order on NATO?');
    expect(entities.has('trump')).toBe(true);
    expect(entities.has('nato')).toBe(true);
    expect(entities.has('executive')).toBe(true);
    expect(entities.has('order')).toBe(true);
    expect(entities.has('sign')).toBe(true);
  });

  it('lowercases all tokens', () => {
    const entities = extractMarketEntities('Will Biden Win The Election?');
    expect(entities.has('biden')).toBe(true);
    expect(entities.has('win')).toBe(true);
    expect(entities.has('election')).toBe(true);
    // No uppercase tokens.
    for (const token of entities) {
      expect(token).toBe(token.toLowerCase());
    }
  });

  it('filters out pure numbers (years, thresholds)', () => {
    const entities = extractMarketEntities('Will Bitcoin reach 100000 by 2026?');
    expect(entities.has('100000')).toBe(false);
    expect(entities.has('2026')).toBe(false);
    expect(entities.has('bitcoin')).toBe(true);
  });

  it('filters out stop words', () => {
    const entities = extractMarketEntities('Will the price of gold be above the threshold?');
    expect(entities.has('the')).toBe(false);
    expect(entities.has('of')).toBe(false);
    expect(entities.has('be')).toBe(false);
    expect(entities.has('gold')).toBe(true);
  });

  it('filters out short tokens (< 3 chars)', () => {
    const entities = extractMarketEntities('Is it a go or no?');
    expect(entities.has('is')).toBe(false);
    expect(entities.has('it')).toBe(false);
    expect(entities.has('go')).toBe(false);
  });

  it('strips punctuation', () => {
    const entities = extractMarketEntities("What's Biden's approval rating?");
    expect(entities.has('biden')).toBe(true);
    expect(entities.has('approval')).toBe(true);
    expect(entities.has('rating')).toBe(true);
  });

  it('deduplicates tokens', () => {
    const entities = extractMarketEntities('Bitcoin Bitcoin bitcoin BITCOIN');
    expect(entities.size).toBe(1);
    expect(entities.has('bitcoin')).toBe(true);
  });

  it('returns empty set for very short or generic questions', () => {
    const entities = extractMarketEntities('Will it be?');
    expect(entities.size).toBe(0);
  });

  it('handles empty string', () => {
    const entities = extractMarketEntities('');
    expect(entities.size).toBe(0);
  });
});
