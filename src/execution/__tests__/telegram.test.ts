import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { TradeSignal } from '../../mapping/index.js';
import type { Position } from '../positionLedger.js';

// Mock logger
vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock Config
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    REDIS_URL: 'redis://localhost:6379',
    SIMMER_API_KEY: 'test-key',
    OPENAI_API_KEY: 'test-openai',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  })),
}));

const mockFetch = vi.fn<typeof fetch>();
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

const { notifyTradeExecuted, notifyTradeError, notifyTakeProfitExecuted, notifyMakerOrderPosted } =
  await import('../telegram.js');

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will war escalate?',
    direction: 'YES',
    stakeUsd: 5.0,
    edgeMagnitude: 0.2,
    consensusProbability: 0.7,
    consensusStddev: 0.01,
    outcomePrice: 0.5,
    halfKellyFraction: 0.1,
    sourcedFrom: 'Breaking news',
    reasoning: 'Strong escalation signal',
    ...overrides,
  };
}

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will war escalate?',
    direction: 'YES',
    entryPrice: 0.5,
    stakeUsd: 5.0,
    consensusProbability: 0.7,
    edgeMagnitude: 0.2,
    sourcedFrom: 'Breaking news',
    openedAt: new Date('2026-03-18T12:00:00Z').toISOString(),
    executionVenue: 'simmer',
    ...overrides,
  };
}

describe('Telegram notifications', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.TELEGRAM_CHAT_ID = 'test-chat';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
  });

  describe('notifyTradeExecuted', () => {
    it('sends a message via Telegram API', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTradeExecuted(makeSignal(), '0xabc');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('test-token');
      expect(url).toContain('sendMessage');
      const body = JSON.parse(opts.body as string) as { chat_id: string; text: string };
      expect(body.chat_id).toBe('test-chat');
      expect(body.text).toContain('Trade Executed');
      expect(body.text).toContain('0xabc');
    });

    it('no-ops when bot token is missing', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await notifyTradeExecuted(makeSignal(), undefined);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('does not throw when Telegram API returns error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'Too Many Requests',
      } as Response);

      await expect(notifyTradeExecuted(makeSignal(), undefined)).resolves.not.toThrow();
    });
  });

  describe('notifyMakerOrderPosted', () => {
    it('sends a 🟡 pending message with posted price and order ID', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyMakerOrderPosted(makeSignal(), { postedPrice: 0.61, orderId: '0xabc123' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('test-token');
      expect(url).toContain('sendMessage');
      const body = JSON.parse(opts.body as string) as { chat_id: string; text: string };
      expect(body.chat_id).toBe('test-chat');
      expect(body.text).toContain('Maker Order Posted');
      expect(body.text).toContain('0.610');
      expect(body.text).toContain('0xabc123');
      expect(body.text).toContain('Will war escalate?');
    });

    it('omits order ID line when not provided', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyMakerOrderPosted(makeSignal(), { postedPrice: 0.5 });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).not.toContain('Order ID');
    });

    it('no-ops when bot token is missing', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await notifyMakerOrderPosted(makeSignal(), { postedPrice: 0.5 });
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('notifyTradeError', () => {
    it('includes error in message body', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTradeError(makeSignal(), 'insufficient funds');

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('Trade Failed');
      expect(body.text).toContain('insufficient funds');
    });
  });

  describe('notifyTakeProfitExecuted', () => {
    it('sends take-profit message with return info', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition(),
        currentPrice: 0.75,
        returnPct: 50,
        reason: 'take_profit_threshold',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('Position Closed');
      expect(body.text).toContain('+50.0%');
      expect(body.text).toContain('Take-profit threshold');
    });

    it('uses correct reason label for divergence_closed', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition(),
        currentPrice: 0.6,
        returnPct: 20,
        reason: 'divergence_closed',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('Divergence closed');
    });

    it('escapes HTML special chars in question', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition({ question: 'Will <X> & Y > Z?' }),
        currentPrice: 0.6,
        returnPct: 20,
        reason: 'take_profit_threshold',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('&lt;X&gt;');
      expect(body.text).toContain('&amp;');
      expect(body.text).not.toContain('<X>');
    });
  });
});
