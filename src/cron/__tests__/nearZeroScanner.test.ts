import { describe, it, expect } from 'vitest';
import { isExcludedByHeuristic } from '../nearZeroScanner.js';

describe('nearZeroScanner.isExcludedByHeuristic', () => {
  describe('head-to-head matchup pattern', () => {
    it('excludes tennis tournament matchups', () => {
      expect(isExcludedByHeuristic('BMW Open: Zhizhen Zhang vs Luciano Darderi')).toBe(true);
      expect(
        isExcludedByHeuristic('Open Capfinances Rouen Metropole: Chloe Paquet vs Xinyu Wang'),
      ).toBe(true);
      expect(isExcludedByHeuristic('Busan: Liam Broady vs Ilya Ivashka')).toBe(true);
      expect(isExcludedByHeuristic('Barcelona Open: Reilly Opelka vs Ethan Quinn')).toBe(true);
    });

    it('excludes baseball matchups', () => {
      expect(isExcludedByHeuristic('New York Yankees vs. Tampa Bay Rays')).toBe(true);
      expect(isExcludedByHeuristic('Miami Marlins vs. Atlanta Braves')).toBe(true);
    });

    it('does not match questions without a head-to-head format', () => {
      expect(isExcludedByHeuristic('Will Bitcoin reach $75,000 in April?')).toBe(false);
      expect(isExcludedByHeuristic('Iran x Israel/US conflict ends by June 30?')).toBe(false);
      expect(isExcludedByHeuristic('Will inflation reach more than 3.5% in 2026?')).toBe(false);
      expect(
        isExcludedByHeuristic('Kharg Island no longer under Iranian control by April 30?'),
      ).toBe(false);
      expect(
        isExcludedByHeuristic(
          'Trump announces US x Iran ceasefire end by April 21, 2026?',
        ),
      ).toBe(false);
    });

    it('does not match lowercase "vs" without capitalized right-hand name', () => {
      expect(isExcludedByHeuristic('How does X compare vs the baseline?')).toBe(false);
    });
  });

  describe('existing patterns still match', () => {
    it('excludes championship wins', () => {
      expect(isExcludedByHeuristic('Will Team X win the championship?')).toBe(true);
    });

    it('excludes "next president" markets', () => {
      expect(isExcludedByHeuristic('Who will be the next president of Country Y?')).toBe(true);
    });

    it('excludes award wins', () => {
      expect(isExcludedByHeuristic('Will Movie Z win an Oscar?')).toBe(true);
    });

    it('excludes playoff reach markets', () => {
      expect(isExcludedByHeuristic('Will Team A make the playoff?')).toBe(true);
      expect(isExcludedByHeuristic('Will Team B reach the semifinal?')).toBe(true);
    });
  });
});
