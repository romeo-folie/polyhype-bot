import { describe, it, expect } from '@jest/globals';
import { parseWalletList, isWeatherMarket } from '../index.js';

describe('copytrade helpers', () => {
  it('parses wallet list', () => {
    expect(parseWalletList(undefined)).toEqual([]);
    expect(parseWalletList('')).toEqual([]);
    expect(parseWalletList(' 0xabc , 0xdef ')).toEqual(['0xabc', '0xdef']);
  });

  it('detects weather markets by title', () => {
    expect(isWeatherMarket('Will the highest temperature in Shenzhen be 28°C on March 25?')).toBe(true);
    expect(isWeatherMarket('Precipitation in NYC in April?')).toBe(true);
    expect(isWeatherMarket('Will the price of Bitcoin be above $70k?')).toBe(false);
  });
});
