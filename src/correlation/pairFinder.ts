/**
 * Market pair finder for correlation discovery.
 *
 * Builds a reverse entity index over the full market list, then
 * enumerates candidate pairs that share at least N entity tokens.
 *
 * Complexity: O(M × E) where M = markets, E = avg entities per market.
 * With 2 000 markets and ~6 tokens each, runs in <10 ms.
 */

import { extractMarketEntities } from './entityExtractor.js';
import { pairKey } from './types.js';
import type { MarketPrice } from './types.js';

export interface CandidatePair {
  a: MarketPrice;
  b: MarketPrice;
  sharedEntities: string[];
}

/**
 * Find market pairs sharing at least `minSharedEntities` keyword tokens.
 *
 * @param markets        Current market price snapshots.
 * @param minSharedEntities Minimum shared tokens to form a pair.
 * @param maxPairs       Cap on returned pairs (sorted by overlap descending).
 */
export function findCandidatePairs(
  markets: MarketPrice[],
  minSharedEntities: number,
  maxPairs: number,
): CandidatePair[] {
  // 1. Extract entities for every market.
  const entitySets = new Map<string, Set<string>>();
  for (const m of markets) {
    entitySets.set(m.marketId, extractMarketEntities(m.question));
  }

  // 2. Build reverse index: entity → list of marketIds.
  const reverseIndex = new Map<string, string[]>();
  for (const [marketId, entities] of entitySets) {
    for (const token of entities) {
      let bucket = reverseIndex.get(token);
      if (!bucket) {
        bucket = [];
        reverseIndex.set(token, bucket);
      }
      bucket.push(marketId);
    }
  }

  // 3. For each entity with 2+ markets, enumerate all pairs and count
  //    shared entities. Use pairKey for dedup.
  const pairOverlap = new Map<string, Set<string>>();
  for (const [token, marketIds] of reverseIndex) {
    if (marketIds.length < 2) continue;
    for (let i = 0; i < marketIds.length; i++) {
      for (let j = i + 1; j < marketIds.length; j++) {
        const pk = pairKey(marketIds[i]!, marketIds[j]!);
        let shared = pairOverlap.get(pk);
        if (!shared) {
          shared = new Set();
          pairOverlap.set(pk, shared);
        }
        shared.add(token);
      }
    }
  }

  // 4. Filter to pairs meeting the threshold and build output.
  const marketMap = new Map(markets.map((m) => [m.marketId, m]));
  const results: CandidatePair[] = [];

  for (const [pk, shared] of pairOverlap) {
    if (shared.size < minSharedEntities) continue;
    const [idA, idB] = pk.split(':') as [string, string];
    const a = marketMap.get(idA);
    const b = marketMap.get(idB);
    if (!a || !b) continue;
    // Skip same-condition pairs (same market, different outcomes) — these
    // are handled by the NegRisk / pure arb scanners.
    if (a.conditionId === b.conditionId) continue;
    results.push({ a, b, sharedEntities: [...shared] });
  }

  // 5. Sort by overlap count descending (more overlap = more likely related).
  results.sort((x, y) => y.sharedEntities.length - x.sharedEntities.length);

  return results.slice(0, maxPairs);
}
