import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Api } from 'telegram';

/** Flush the microtask queue so fire-and-forget promises settle */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

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

// Mock gramjs/telegram
const mockConnect = vi.fn();
const mockAddEventHandler = vi.fn();
const mockGetEntity = vi.fn();
const mockGetMe = vi.fn().mockResolvedValue({
  username: 'test_user',
  id: '999',
  firstName: 'Test',
});
const mockGetDialogs = vi.fn().mockResolvedValue([]);
const mockGetPeerId = vi.fn().mockImplementation((p) => {
  if (p && typeof p === 'object' && 'id' in p) return Promise.resolve(String(p.id));
  return Promise.resolve(String(p));
});

vi.mock('telegram', () => {
  class UpdateNewChannelMessage {
    public message: any;
    constructor(args: any) {
      this.message = args.message;
    }
  }
  class UpdateNewMessage {
    public message: any;
    constructor(args: any) {
      this.message = args.message;
    }
  }

  return {
    TelegramClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      getMe: mockGetMe,
      getDialogs: mockGetDialogs,
      addEventHandler: mockAddEventHandler,
      getEntity: mockGetEntity,
      getPeerId: mockGetPeerId,
      invoke: vi.fn().mockResolvedValue({}), // For JoinChannel
      session: { save: () => 'mock-session' },
      connected: true,
    })),
    Api: {
      Channel: class {
        username = 'alpha_channel';
        title = 'Alpha Channel';
        left = false;
        broadcast = true;
      },
      Chat: class { id = 'mock-chat-id'; left = false; },
      User: class { id = 'mock-user-id'; },
      channels: {
        JoinChannel: vi.fn(),
      },
      UpdateNewChannelMessage,
      UpdateNewMessage,
      Message: class {},
    },
  };
});

vi.mock('telegram/sessions/index.js', () => ({
  StringSession: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('telegram/events/index.js', () => ({
  NewMessage: vi.fn().mockImplementation(() => ({})),
}));

describe('telegramMonitor', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
  });

  it('connects to Telegram on start', async () => {
    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    expect(mockConnect).toHaveBeenCalled();
    expect(mockAddEventHandler).toHaveBeenCalled();
  });

  it('triggers execution for high-urgency message', async () => {
    // Mock startup resolution for this test
    const mockChannel = new Api.Channel({} as any);
    (mockChannel as any).id = '123';
    (mockChannel as any).username = 'alpha_channel';
    mockGetEntity.mockResolvedValue(mockChannel);

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    // The message handler is now the second handler (index 1)
    const handler = mockAddEventHandler.mock.calls[0][0];

    const mockMessage = {
      text: 'Explosion in major oil hub!',
      id: 1001,
      peerId: { id: '123' },
      date: Math.floor(Date.now() / 1000),
    };
    mockScoreItems.mockResolvedValue([{ urgencyScore: 9 }]);

    const mockUpdate = new Api.UpdateNewChannelMessage({ message: mockMessage as any } as any);
    handler(mockUpdate);
    await flushMicrotasks();

    expect(mockScoreItems).toHaveBeenCalled();
    expect(mockProcessScoredItems).toHaveBeenCalled();
  });

  it('ignores low-urgency message', async () => {
    const mockChannel = new Api.Channel({} as any);
    (mockChannel as any).id = '123';
    (mockChannel as any).username = 'alpha_channel';
    mockGetEntity.mockResolvedValue(mockChannel);

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const handler = mockAddEventHandler.mock.calls[0][0];

    const mockMessage = {
      text: 'Routine diplomatic meeting scheduled.',
      id: 1002,
      peerId: { id: '123' },
      date: Math.floor(Date.now() / 1000),
    };
    mockScoreItems.mockResolvedValue([{ urgencyScore: 3 }]);

    const mockUpdate = new Api.UpdateNewChannelMessage({ message: mockMessage } as any);
    handler(mockUpdate);
    await flushMicrotasks();

    expect(mockProcessScoredItems).not.toHaveBeenCalled();
  });

  it('filters by channel name', async () => {
    const mockChannel = new Api.Channel({} as any);
    (mockChannel as any).id = '123';
    (mockChannel as any).username = 'alpha_channel';
    mockGetEntity.mockResolvedValue(mockChannel);

    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const handler = mockAddEventHandler.mock.calls[0][0];

    const mockMessage = {
      text: 'Alert!',
      id: 1003,
      peerId: { id: '456' }, // Different ID
      date: Math.floor(Date.now() / 1000),
    };

    const mockUpdate = new Api.UpdateNewChannelMessage({ message: mockMessage } as any);
    handler(mockUpdate);
    await flushMicrotasks();

    expect(mockScoreItems).not.toHaveBeenCalled();
  });
});
