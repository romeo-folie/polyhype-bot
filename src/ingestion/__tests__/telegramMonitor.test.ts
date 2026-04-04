
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Flush the microtask queue so fire-and-forget promises settle */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 50));

// --- Mocks ---

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockConfig = {
  TELEGRAM_MONITOR_ENABLED: true,
  TELEGRAM_API_ID: 12345,
  TELEGRAM_API_HASH: 'hash',
  TELEGRAM_CHANNELS: 'alpha_channel',
  URGENCY_THRESHOLD: 8,
  TELEGRAM_DB_PATH: './tdlib-data',
};

vi.mock('../../shared/config.js', () => ({
  loadConfig: vi.fn(() => mockConfig),
}));

vi.mock('../../shared/watchlist.js', () => ({
  matchesWatchlist: vi.fn().mockResolvedValue(true),
}));

const mockRedis = {
  get: vi.fn(),
  set: vi.fn(),
};
vi.mock('../../shared/redis.js', () => ({
  getRedis: vi.fn(() => mockRedis),
}));

const mockScoreItems = vi.fn();
vi.mock('../scorer.js', () => ({
  scoreItems: (...args: unknown[]) => mockScoreItems(...args),
}));

const mockProcessScoredItems = vi.fn();
vi.mock('../../execution/index.js', () => ({
  processScoredItems: (...args: unknown[]) => mockProcessScoredItems(...args),
}));

// Mock tdl
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('tdl', () => ({
  configure: vi.fn(),
  createClient: vi.fn().mockImplementation(() => ({
    login: mockLogin,
    invoke: mockInvoke,
    on: mockOn,
    close: mockClose,
  })),
}));

vi.mock('prebuilt-tdlib', () => ({
  getTdjson: () => 'mock-libtdjson.so',
}));

describe('telegramMonitor (TDLib)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetMonitorStateForTest } = await import('../telegramMonitor.js');
    __resetMonitorStateForTest();

    // Default invoke mocks
    mockInvoke.mockImplementation(async (req: any) => {
      if (req._ === 'getMe') return { id: 1, first_name: 'Test', username: 'pga_bot' };
      if (req._ === 'searchPublicChat') return { id: 1001, title: 'Alpha Channel' };
      if (req._ === 'openChat') return { _: 'ok' };
      return {};
    });
  });

  it('connects to Telegram and opens monitored chats', async () => {
    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    expect(mockLogin).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith({ _: 'searchPublicChat', username: 'alpha_channel' });
    expect(mockInvoke).toHaveBeenCalledWith({ _: 'openChat', chat_id: 1001 });
  });

  it('triggers execution for high-urgency message', async () => {
    // Setup client.on listener capture
    let onUpdate: (update: any) => void = () => {};
    mockOn.mockImplementation((event, cb) => {
      if (event === 'update') onUpdate = cb;
    });

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    // Mock high urgency
    mockScoreItems.mockResolvedValue([{ urgencyScore: 9 }]);

    const mockUpdate = {
      _: 'updateNewMessage',
      message: {
        id: 5001,
        chat_id: 1001,
        date: Math.floor(Date.now() / 1000),
        content: {
          _: 'messageText',
          text: { text: 'BREAKING NEWS: OIL LEAK!' }
        }
      }
    };

    onUpdate(mockUpdate);
    await flushMicrotasks();

    expect(mockScoreItems).toHaveBeenCalled();
    expect(mockProcessScoredItems).toHaveBeenCalled();
  });

  it('filters out messages from non-monitored chats', async () => {
    let onUpdate: (update: any) => void = () => {};
    mockOn.mockImplementation((event, cb) => {
      if (event === 'update') onUpdate = cb;
    });

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const mockUpdate = {
      _: 'updateNewMessage',
      message: {
        id: 5002,
        chat_id: 9999, // Unknown chat ID
        date: Math.floor(Date.now() / 1000),
        content: {
          _: 'messageText',
          text: { text: 'Unknown source alert!' }
        }
      }
    };

    onUpdate(mockUpdate);
    await flushMicrotasks();

    expect(mockScoreItems).not.toHaveBeenCalled();
  });

  it('skips message if it does not match watchlist', async () => {
    const { matchesWatchlist } = await import('../../shared/watchlist.js');
    (matchesWatchlist as any).mockResolvedValueOnce(false);

    let onUpdate: (update: any) => void = () => {};
    mockOn.mockImplementation((event, cb) => {
      if (event === 'update') onUpdate = cb;
    });

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const mockUpdate = {
      _: 'updateNewMessage',
      message: {
        id: 5003,
        chat_id: 1001,
        date: Math.floor(Date.now() / 1000),
        content: {
          _: 'messageText',
          text: { text: 'Some random message' }
        }
      }
    };

    onUpdate(mockUpdate);
    await flushMicrotasks();

    expect(mockScoreItems).not.toHaveBeenCalled();
  });

  it('does not trigger execution for low-urgency messages', async () => {
    mockScoreItems.mockResolvedValueOnce([{ urgencyScore: 5 }]); // Below threshold 8

    let onUpdate: (update: any) => void = () => {};
    mockOn.mockImplementation((event, cb) => {
      if (event === 'update') onUpdate = cb;
    });

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const mockUpdate = {
      _: 'updateNewMessage',
      message: {
        id: 5004,
        chat_id: 1001,
        date: Math.floor(Date.now() / 1000),
        content: {
          _: 'messageText',
          text: { text: 'Low urgency news' }
        }
      }
    };

    onUpdate(mockUpdate);
    await flushMicrotasks();

    expect(mockScoreItems).toHaveBeenCalled();
    expect(mockProcessScoredItems).not.toHaveBeenCalled();
  });
});
