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
vi.mock('telegram', () => ({
  TelegramClient: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    addEventHandler: mockAddEventHandler,
    getEntity: mockGetEntity,
    session: { save: () => 'mock-session' },
  })),
  Api: {
    Channel: class {
      username = 'alpha_channel';
      title = 'Alpha Channel';
    },
    Chat: class {},
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
    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const handler = mockAddEventHandler.mock.calls[0][0];
    
    // Simulate event payload with a date field (Unix seconds) to exercise latencyMs path
    const messageDate = Math.floor((Date.now() - 200) / 1000); // 200ms ago
    const mockMessage = {
      text: 'Breaking news: Market impact detected!',
      id: 1001,
      peerId: { channelId: 1 },
      date: messageDate,
    };
    
    mockGetEntity.mockResolvedValue(new Api.Channel({} as any));
    mockScoreItems.mockResolvedValue([
      {
        title: mockMessage.text,
        urgencyScore: 9,
        source: 'telegram:alpha_channel',
        latencyMs: expect.any(Number),
      }
    ]);

    await handler({ message: mockMessage });

    expect(mockScoreItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ latencyMs: expect.any(Number) }),
      ]),
      expect.anything(),
    );
    expect(mockProcessScoredItems).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ urgencyScore: 9 })]),
      mockRedis
    );
  });

  it('ignores low-urgency message', async () => {
    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const handler = mockAddEventHandler.mock.calls[0][0];
    
    const mockMessage = { text: 'Routine news...', id: 1002, peerId: { channelId: 1 }, date: Math.floor(Date.now() / 1000) };
    mockGetEntity.mockResolvedValue(new Api.Channel({} as any));
    mockScoreItems.mockResolvedValue([{ urgencyScore: 3 }]);

    await handler({ message: mockMessage });

    expect(mockProcessScoredItems).not.toHaveBeenCalled();
  });

  it('filters by channel name', async () => {
    const { startTelegramMonitor } = await import('../telegramMonitor.js');
    await startTelegramMonitor();

    const handler = mockAddEventHandler.mock.calls[0][0];
    
    const mockMessage = { text: 'Alert!', id: 1003, peerId: { channelId: 2 }, date: Math.floor(Date.now() / 1000) };
    const otherChannel = new Api.Channel({} as any);
    (otherChannel as any).username = 'other_channel';
    mockGetEntity.mockResolvedValue(otherChannel);

    await handler({ message: mockMessage });

    expect(mockScoreItems).not.toHaveBeenCalled();
  });
});
