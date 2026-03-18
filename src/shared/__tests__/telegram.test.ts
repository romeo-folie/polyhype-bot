import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { TradeSignal } from '../../mapping/index.js';
import type { ExecutionResult } from '../../execution/executor.js';

// Mock fetch globally
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFetch = jest.fn<(...args: any[]) => any>();
global.fetch = mockFetch as typeof fetch;

const { notifyTradeExecuted, notifyExecutionError, _sendMessage } =
  await import('../telegram.js');

function makeSignal(): TradeSignal {
  return {
    marketId: 'mkt-1',
    conditionId: 'cond-1',
    clobTokenIds: ['tok-yes', 'tok-no'],
    question: 'Will conflict escalate?',
    direction: 'YES',
    stakeUsd: 10,
    edgeMagnitude: 0.2,
    consensusProbability: 0.7,
    outcomePrice: 0.5,
    halfKellyFraction: 0.1,
    sourcedFrom: 'Reuters: Conflict escalates',
    reasoning: 'High tension',
  };
}

describe('Telegram notifications', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
    process.env['TELEGRAM_CHAT_ID'] = '-100123456';
  });

  afterEach(() => {
    delete process.env['TELEGRAM_BOT_TOKEN'];
    delete process.env['TELEGRAM_CHAT_ID'];
  });

  it('sendMessage posts to Telegram Bot API', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);

    await _sendMessage('Test message');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/bottest-token/sendMessage');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string) as { text: string; chat_id: string };
    expect(body.text).toBe('Test message');
    expect(body.chat_id).toBe('-100123456');
  });

  it('sendMessage is fire-and-forget — does not throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400, text: async () => 'Bad Request' } as Response);

    await expect(_sendMessage('Test')).resolves.toBeUndefined();
  });

  it('sendMessage is fire-and-forget — does not throw on network error', async () => {
    mockFetch.mockRejectedValue(new Error('network failure'));

    await expect(_sendMessage('Test')).resolves.toBeUndefined();
  });

  it('sendMessage skips when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env['TELEGRAM_BOT_TOKEN'];

    await _sendMessage('Test');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('notifyTradeExecuted triggers a send', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);

    const result: ExecutionResult = {
      success: true,
      txHash: '0xabc',
      signal: makeSignal(),
    };

    notifyTradeExecuted(result);

    // Fire-and-forget — give the microtask queue a tick to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('notifyExecutionError triggers a send', async () => {
    mockFetch.mockResolvedValue({ ok: true } as Response);

    const result: ExecutionResult = {
      success: false,
      error: 'Simmer error',
      signal: makeSignal(),
    };

    notifyExecutionError(result);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('notifyTradeExecuted is a no-op when result.success is false', async () => {
    const result: ExecutionResult = {
      success: false,
      error: 'failed',
      signal: makeSignal(),
    };

    notifyTradeExecuted(result);
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
