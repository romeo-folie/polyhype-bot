import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Api } from 'telegram';

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
const mockGetPeerId = vi.fn().mockImplementation((p) => {
  if (p && typeof p === 'object' && 'id' in p) return Promise.resolve(String(p.id));
  return Promise.resolve(String(p));
});

vi.mock('telegram', () => ({
  TelegramClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    addEventHandler: mockAddEventHandler,
    getEntity: mockGetEntity,
    getPeerId: mockGetPeerId,
    session: { save: () => 'mock-session' },
    connected: true,
  })),
  Api: {
    Channel: class {
      username = 'alpha_channel';
      title = 'Alpha Channel';
    },
    Chat: class { id = 'mock-chat-id'; },
  },
}));

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

    const handler = mockAddEventHandler.mock.calls[0][0];

    // Simulate event payload with a date field (Unix seconds) to exercise latencyMs path
    const mockMessage = {
      text: 'Explosion in major oil hub!',
      id: 1001,
      peerId: '123',
      date: Math.floor(Date.now() / 1000),
    };
    mockScoreItems.mockResolvedValue([{ urgencyScore: 9 }]);

    await handler({ message: mockMessage });

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
      peerId: '123',
      date: Math.floor(Date.now() / 1000),
    };
    mockScoreItems.mockResolvedValue([{ urgencyScore: 3 }]);

    await handler({ message: mockMessage });

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
      peerId: '456', // Different ID
      date: Math.floor(Date.now() / 1000),
    };

    await handler({ message: mockMessage });

    expect(mockScoreItems).not.toHaveBeenCalled();
  });
});
