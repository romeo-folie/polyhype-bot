import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Snapshot and restore env vars to prevent global namespace pollution between test files.
let _savedEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  _savedEnv = { ...process.env };
  // Set mandatory environment variables for config validation
  process.env['NODE_ENV'] = 'test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['SIMMER_API_KEY'] = 'test-simmer-key';
  process.env['GEMINI_API_KEY'] = 'test-gemini-key';
});
afterEach(() => {
  process.env = _savedEnv;
});

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockRedis = { get: jest.fn(), set: jest.fn(), setex: jest.fn(), del: jest.fn() };

jest.unstable_mockModule('../../shared/logger.js', () => ({ logger: mockLogger }));
jest.unstable_mockModule('../../shared/redis.js', () => ({ 
  getRedis: jest.fn(() => mockRedis),
  closeRedis: jest.fn()
}));

jest.unstable_mockModule('../../shared/config.js', () => ({
  loadConfig: jest.fn(() => ({
    COPYTRADE_WALLETS: '0x1',
    COPYTRADE_MARKET_SCOPE: ['all'],
    SIMMER_API_KEY: 'test-simmer-key'
  }))
}));

const mockRunCopytrade = jest.fn() as any;
jest.unstable_mockModule('../index.js', () => ({ runCopytrade: mockRunCopytrade }));

const mockExecuteSignal = jest.fn() as any;
jest.unstable_mockModule('../../execution/executor.js', () => ({ executeSignal: mockExecuteSignal }));

const mockRecordPosition = jest.fn() as any;
jest.unstable_mockModule('../../execution/positionLedger.js', () => ({ recordPosition: mockRecordPosition }));

const mockDeductStake = jest.fn() as any;
const mockGetBankroll = jest.fn() as any;
jest.unstable_mockModule('../../shared/bankroll.js', () => ({ 
  deductStake: mockDeductStake,
  getBankroll: mockGetBankroll
}));

describe('copytrade worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBankroll.mockResolvedValue(1000);
  });

  it('executes signals and records positions', async () => {
    const signal = { 
      marketId: 'm1', 
      stakeUsd: 10, 
      question: 'Q', 
      direction: 'YES',
      conditionId: 'c1',
      clobTokenIds: ['t1', 't2'],
      outcomePrice: 0.5,
      sourcedFrom: 'copy'
    };
    
    // 1. Mock runCopytrade to return a signal
    mockRunCopytrade.mockResolvedValueOnce({ signals: [signal], exits: 0 });
    // 2. Mock executeSignal to return success
    mockExecuteSignal.mockResolvedValue({ 
      tradeResult: { success: true, tx_hash: '0x123', shares_bought: 20 } 
    });
    // 3. To break the loop after one iteration, we can make the next call throw
    mockRunCopytrade.mockImplementationOnce(() => { throw new Error('stop-loop'); });

    const { runWorker } = await import('../worker.js');
    
    try {
        await runWorker(1); // Run 1 cycle
    } catch (e: any) {
        if (e.message !== 'stop-loop') throw e;
    }

    expect(mockRunCopytrade).toHaveBeenCalled();
    expect(mockExecuteSignal).toHaveBeenCalledWith(signal, mockRedis);
    expect(mockDeductStake).toHaveBeenCalledWith(mockRedis, 10);
    expect(mockRecordPosition).toHaveBeenCalled();
  });
});
