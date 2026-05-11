import { describe, it, expect } from 'vitest';
import { parseWhaleAlert } from '../whaleAlertParser.js';

const BASE = {
  source: 'telegram:whale_alert_io',
  url: 'https://t.me/whale_alert_io/123',
  publishedAt: new Date('2026-05-11T10:00:00Z'),
};

describe('parseWhaleAlert', () => {
  it('classifies wallet→exchange transfer as SHORT', () => {
    const text = '🚨 5,000 #BTC (421,000,000 USD) transferred from unknown wallet to #Binance';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bearish');
    expect(result!.title).toContain('BTC');
    expect(result!.urgencyScore).toBeGreaterThanOrEqual(7);
  });

  it('classifies exchange→wallet transfer as LONG', () => {
    const text = '🟢 10,000 #ETH (32,000,000 USD) transferred from #Kraken to unknown wallet';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bullish');
    expect(result!.title).toContain('ETH');
  });

  it('skips exchange→exchange transfers', () => {
    const text = '🔄 1,000 #BTC (85,000,000 USD) transferred from #Binance to #Coinbase';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result).toBeNull();
  });

  it('skips unknown→unknown transfers (non-directional)', () => {
    const text = '🔄 2,000 #ETH (60,000,000 USD) transferred from unknown wallet to unknown wallet';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result).toBeNull();
  });

  it('skips transfers below the USD threshold', () => {
    const text = '⚠️ 100 #BTC (8,500,000 USD) transferred from unknown wallet to #Binance';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result).toBeNull();
  });

  it('scores $100M+ transfers at urgency 9', () => {
    const text = '🚨 1,200 #BTC (102,000,000 USD) transferred from #Coinbase to unknown wallet';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result!.urgencyScore).toBe(9);
  });

  it('scores $50-100M transfers at urgency 8', () => {
    const text = '🚨 700 #BTC (59,500,000 USD) transferred from unknown wallet to #Kraken';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result!.urgencyScore).toBe(8);
  });

  it('returns null for unrecognised message format', () => {
    const result = parseWhaleAlert('Bitcoin is looking bullish today!', BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result).toBeNull();
  });

  it('sets correct categoryId and keywords', () => {
    const text = '🚨 3,000 #SOL (450,000,000 USD) transferred from unknown wallet to #Binance';
    const result = parseWhaleAlert(text, BASE.source, BASE.url, BASE.publishedAt, 20);
    expect(result!.categoryId).toBe('crypto-futures');
    expect(result!.keywords).toContain('SOL');
  });
});
