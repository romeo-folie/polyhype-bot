import { describe, it, expect } from 'vitest';
import { parseCryptoQuantAlert } from '../cryptoQuantParser.js';

const BASE = {
  source: 'telegram:cryptoquant_alert',
  url: 'https://t.me/cryptoquant_alert/456',
  publishedAt: new Date('2026-05-11T10:00:00Z'),
};

describe('parseCryptoQuantAlert', () => {
  it('parses exchange inflow as SHORT', () => {
    const text = '🚨 Exchange Inflow (BTC): Large amount of BTC flowing into exchanges. Estimated 3,200 BTC ($220M).';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bearish');
    expect(result!.title).toContain('BTC');
  });

  it('parses exchange outflow as LONG', () => {
    const text = '🟢 Exchange Outflow (ETH): Large ETH outflow from exchanges. Bullish accumulation signal.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bullish');
    expect(result!.title).toContain('ETH');
  });

  it('parses miner selling as SHORT', () => {
    const text = '⚠️ Miner outflow to exchange (BTC): Miners are sending coins to exchanges. 1,200 BTC.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bearish');
  });

  it('parses high positive funding rate as SHORT', () => {
    const text = '🔴 Funding Rate Alert (BTC/USDT): Funding rate is extremely high — 0.12% per 8h on Binance.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bearish');
  });

  it('parses high negative funding rate as LONG', () => {
    const text = '🟢 Funding Rate Alert (ETH/USDT): Funding rate is extremely negative — shorts dominating.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bullish');
  });

  it('parses whale deposit to exchange as SHORT with urgency 8', () => {
    const text = '🚨 Whale deposit to exchange (BTC): Large wallet sent 2,000 BTC to Binance.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.urgencyScore).toBe(8);
    expect(result!.title).toContain('bearish');
  });

  it('returns null for unrecognised alert format', () => {
    const text = 'CryptoQuant: The market looks calm today with low volatility.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).toBeNull();
  });

  it('sets correct categoryId', () => {
    const text = '🚨 Exchange Inflow (BTC): Large inflow detected.';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result!.categoryId).toBe('crypto-futures');
  });

  it('defaults symbol to BTC when none found in parens', () => {
    const text = '🚨 Exchange Inflow: massive inflow alert — selling pressure incoming';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result!.keywords).toContain('BTC');
  });

  it('parses CQ aggregated inflows format as SHORT', () => {
    const text = '🐳 1,390.79 #BTC ($113,404,082) aggregated inflows to all exchanges in the last 1 hour';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bearish');
    expect(result!.keywords).toContain('BTC');
  });

  it('extracts symbol from #HASH format', () => {
    const text = '🐳 500 #ETH ($1,200,000) aggregated inflows to all exchanges';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.keywords).toContain('ETH');
  });

  it('parses CQ aggregated outflows format as LONG', () => {
    const text = '🟢 2,100 #BTC ($172,000,000) aggregated outflows from all exchanges in the last 1 hour';
    const result = parseCryptoQuantAlert(text, BASE.source, BASE.url, BASE.publishedAt);
    expect(result).not.toBeNull();
    expect(result!.title).toContain('bullish');
    expect(result!.keywords).toContain('BTC');
  });
});
