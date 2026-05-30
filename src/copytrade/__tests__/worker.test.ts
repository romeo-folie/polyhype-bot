import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Snapshot and restore env vars to prevent global namespace pollution between test files.
let _savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  _savedEnv = { ...process.env };
  process.env.NODE_ENV = 'test';
  process.env.REDIS_URL = 'redis://localhost:6379';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
});
afterEach(() => {
  process.env = _savedEnv;
});

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const mockRedis = {
  get: vi.fn(),
  set: vi.fn().mockResolvedValue('OK'),
  setex: vi.fn(),
  del: vi.fn(),
  eval: vi.fn().mockResolvedValue(1),
};

vi.mock('../../shared/logger.js', () => ({ logger: mockLogger }));
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
  closeRedis: vi.fn(),
}));
vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    COPYTRADE_WALLETS: '0x1',
    COPYTRADE_MARKET_SCOPE: ['all'],
    COPYTRADE_POLL_INTERVAL_MS: 0,
  })),
}));

const mockRunCopytrade = vi.fn();
vi.mock('../index.js', () => ({ runCopytrade: mockRunCopytrade }));

const mockExecuteSignal = vi.fn();
vi.mock('../../execution/executor.js', () => ({
  executeAndRecordSignal: mockExecuteSignal,
}));

const mockGetBankroll = vi.fn();
vi.mock('../../shared/bankroll.js', () => ({
  getBankroll: mockGetBankroll,
}));

describe('copytrade worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBankroll.mockResolvedValue(1000);
    // Default: lock acquisition succeeds (eval returns 1)
    mockRedis.eval.mockResolvedValue(1);
    mockRedis.get.mockResolvedValue(null);
  });

  it('executes signals via executeAndRecordSignal', async () => {
    const signal = {
      marketId: 'm1',
      stakeUsd: 10,
      question: 'Q',
      direction: 'YES',
      conditionId: 'c1',
      clobTokenIds: ['t1', 't2'],
      outcomePrice: 0.5,
      sourcedFrom: 'copy',
    };

    mockRunCopytrade.mockResolvedValueOnce({ signals: [signal], exits: 0 });
    mockExecuteSignal.mockResolvedValue({
      signal,
      tradeResult: { success: true, tx_hash: '0x123', shares_bought: 20 },
      executionVenue: 'clob',
    });

    const { runWorker } = await import('../worker.js');
    await runWorker(1);

    expect(mockRunCopytrade).toHaveBeenCalled();
    // executeAndRecordSignal handles deductStake + recordPosition internally —
    // the worker only needs to invoke it with the right arguments.
    expect(mockExecuteSignal).toHaveBeenCalledWith(signal, mockRedis, 0);
  });
});
