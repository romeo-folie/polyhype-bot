import { describe, it, expect, vi } from 'vitest';

vi.mock('../../shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../shared/config.js', () => ({
  // No LLM keys — forces keyword-only path, LLM fallback returns null.
  loadConfig: () => ({}),
}));

import { classifyCategory } from '../categoryClassifier.js';

describe('classifyCategory — sports', () => {
  it('routes NBA headline to sports', async () => {
    const cat = await classifyCategory('Lakers vs Warriors tonight: LeBron questionable');
    expect(cat.id).toBe('sports');
  });

  it('routes NHL headline to sports', async () => {
    const cat = await classifyCategory('Bruins beat Rangers in OT thriller');
    expect(cat.id).toBe('sports');
  });

  it('routes generic playoff headline to sports', async () => {
    const cat = await classifyCategory('Championship game tipoff set for tonight');
    expect(cat.id).toBe('sports');
  });
});

describe('classifyCategory — existing categories still work', () => {
  it('routes macro headline to macro', async () => {
    const cat = await classifyCategory('Federal Reserve signals rate cut amid CPI surprise');
    expect(cat.id).toBe('macro');
  });

  it('routes crypto headline to crypto-regulatory', async () => {
    const cat = await classifyCategory('SEC approves spot Bitcoin ETF filings');
    expect(cat.id).toBe('crypto-regulatory');
  });

  it('routes AI headline to ai-tech', async () => {
    const cat = await classifyCategory('OpenAI releases GPT frontier model with new chip');
    expect(cat.id).toBe('ai-tech');
  });

  it('falls back to geopolitical for non-matching text', async () => {
    const cat = await classifyCategory('Border dispute escalates in disputed region');
    expect(cat.id).toBe('geopolitical');
  });
});
