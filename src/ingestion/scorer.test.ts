import { describe, it, expect } from '@jest/globals';
import { parseScoreResponse } from './scorer.js';

describe('parseScoreResponse', () => {
  it('parses valid JSON with correct score and keywords', () => {
    const result = parseScoreResponse('{"score": 8, "keywords": ["Ukraine", "NATO", "Russia"]}');
    expect(result.score).toBe(8);
    expect(result.keywords).toEqual(['Ukraine', 'NATO', 'Russia']);
  });

  it('parses JSON wrapped in markdown code block', () => {
    const result = parseScoreResponse('```json\n{"score": 7, "keywords": ["China"]}\n```');
    expect(result.score).toBe(7);
    expect(result.keywords).toEqual(['China']);
  });

  it('clamps score above 10 to 10', () => {
    const result = parseScoreResponse('{"score": 15, "keywords": ["test"]}');
    expect(result.score).toBe(10);
  });

  it('clamps score below 1 to 1', () => {
    const result = parseScoreResponse('{"score": -3, "keywords": ["test"]}');
    expect(result.score).toBe(1);
  });

  it('returns score 0 and empty keywords for malformed JSON', () => {
    const result = parseScoreResponse('this is not json at all');
    expect(result.score).toBe(0);
    expect(result.keywords).toEqual([]);
  });

  it('returns score 0 and empty keywords for empty string', () => {
    const result = parseScoreResponse('');
    expect(result.score).toBe(0);
    expect(result.keywords).toEqual([]);
  });

  it('returns score 0 and empty keywords when score field is missing', () => {
    const result = parseScoreResponse('{"keywords": ["test"]}');
    expect(result.score).toBe(0);
    expect(result.keywords).toEqual(['test']);
  });

  it('returns empty keywords when keywords field is missing', () => {
    const result = parseScoreResponse('{"score": 5}');
    expect(result.score).toBe(5);
    expect(result.keywords).toEqual([]);
  });

  it('filters non-string keywords', () => {
    const result = parseScoreResponse('{"score": 6, "keywords": ["valid", 123, null, "also valid"]}');
    expect(result.score).toBe(6);
    expect(result.keywords).toEqual(['valid', 'also valid']);
  });

  it('limits keywords to 5', () => {
    const keywords = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = parseScoreResponse(JSON.stringify({ score: 5, keywords }));
    expect(result.keywords).toHaveLength(5);
  });

  it('rounds fractional scores', () => {
    const result = parseScoreResponse('{"score": 7.6, "keywords": []}');
    expect(result.score).toBe(8);
  });
});
