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
    OPENAI_API_KEY: 'test-openai',
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  })),
}));

const mockFetch = vi.fn<typeof fetch>();
(global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;

const { notifyTradeExecuted, notifyTradeError, notifyTakeProfitExecuted } =
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
    executionVenue: 'clob',
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

    it('defaults to CLOB venue label when no venue is passed', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTradeExecuted(makeSignal(), '0xabc');

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('CLOB');
      expect(body.text).not.toContain('Simmer');
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

    it('formats Hyperliquid meme entries with higher precision', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTradeExecuted(
        makeSignal({
          question: 'HL momentum LONG kPEPE',
          direction: 'LONG',
          isFutures: true,
          outcomePrice: 0.003879,
        }),
        '0xhl',
        { venue: 'hyperliquid', entryPrice: 0.003879 },
      );

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('$0.00387900');
      expect(body.text).not.toContain('0.003 (0.4% implied)');
      expect(body.text).not.toContain('Our P:');
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

    it('formats Hyperliquid exits with higher precision for meme prices', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition({
          question: 'HL momentum LONG kPEPE',
          direction: 'LONG',
          entryPrice: 0.003879,
          executionVenue: 'hyperliquid',
          isFutures: true,
        }),
        currentPrice: 0.004125,
        returnPct: 6.34,
        reason: 'trailing_stop',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('$0.00387900');
      expect(body.text).toContain('$0.00412500');
    });

    it('trailing_stop label says "gains locked in" when returnPct is positive', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition({ entryPrice: 0.45, executionVenue: 'clob' }),
        currentPrice: 0.55,
        returnPct: 22.22,
        reason: 'trailing_stop',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('gains locked in');
      expect(body.text).not.toContain('reversal below entry');
    });

    it('trailing_stop label says "reversal below entry" when returnPct is negative', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition({ entryPrice: 0.45, executionVenue: 'clob' }),
        currentPrice: 0.415,
        returnPct: -7.78,
        reason: 'trailing_stop',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('reversal below entry');
      expect(body.text).not.toContain('gains locked in');
    });

    it('appends contrarian tag on close when position.isContrarian is true', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTakeProfitExecuted({
        position: makePosition({ direction: 'LONG', isFutures: true, executionVenue: 'hyperliquid', isContrarian: true }),
        currentPrice: 2100,
        returnPct: 5,
        reason: 'futures_tp',
      });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('LONG ↩️ contrarian');
    });
  });

  describe('notifyTradeExecuted contrarian label', () => {
    it('appends contrarian tag on entry when signal.isContrarian is true', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTradeExecuted(
        makeSignal({ direction: 'LONG', isFutures: true, isContrarian: true }),
        '0xhl',
        { venue: 'hyperliquid' },
      );

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).toContain('LONG ↩️ contrarian');
    });

    it('does NOT append contrarian tag when isContrarian is false', async () => {
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);

      await notifyTradeExecuted(makeSignal({ direction: 'LONG' }), '0xhl');

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(opts.body as string) as { text: string };
      expect(body.text).not.toContain('contrarian');
    });
  });
});
