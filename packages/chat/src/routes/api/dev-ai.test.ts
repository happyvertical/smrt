import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveDevAIConfig } from './dev-ai.js';

const KEYS = [
  'SMRT_CHAT_DEV_PROVIDER',
  'SMRT_CHAT_DEV_API_KEY',
  'SMRT_CHAT_DEV_BASE_URL',
  'SMRT_CHAT_DEV_MODEL',
  'SMRT_AI_PROVIDER',
  'SMRT_AI_API_KEY',
  'SMRT_AI_BASE_URL',
  'SMRT_AI_MODEL',
  'HAVE_AI_PROVIDER',
  'HAVE_AI_API_KEY',
  'HAVE_AI_BASE_URL',
  'HAVE_AI_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveDevAIConfig (preserved dev precedence)', () => {
  it('returns null when nothing is configured', () => {
    expect(resolveDevAIConfig()).toBeNull();
  });

  it('prefers SMRT_CHAT_DEV_* over SMRT_AI_* over HAVE_AI_*', () => {
    process.env.HAVE_AI_PROVIDER = 'gemini';
    process.env.SMRT_AI_PROVIDER = 'anthropic';
    process.env.SMRT_CHAT_DEV_PROVIDER = 'openai';
    process.env.HAVE_AI_MODEL = 'h';
    process.env.SMRT_AI_MODEL = 's';
    expect(resolveDevAIConfig()).toMatchObject({
      provider: 'openai',
      model: 's',
    });
    process.env.SMRT_CHAT_DEV_MODEL = 'd';
    expect(resolveDevAIConfig()?.model).toBe('d');
  });

  it('request model beats env model', () => {
    process.env.SMRT_AI_PROVIDER = 'openai';
    process.env.SMRT_AI_MODEL = 's';
    expect(resolveDevAIConfig('req')?.model).toBe('req');
  });

  it('auto-detects by key and uses the provider key only for that provider', () => {
    process.env.ANTHROPIC_API_KEY = 'a-key';
    process.env.GEMINI_API_KEY = 'g-key';
    expect(resolveDevAIConfig()).toMatchObject({
      provider: 'anthropic',
      apiKey: 'a-key',
    });
  });

  it('generic key beats provider key; foreign provider key is unused', () => {
    process.env.SMRT_AI_PROVIDER = 'anthropic';
    process.env.OPENAI_API_KEY = 'o-key';
    expect(resolveDevAIConfig()?.apiKey).toBeUndefined();
    process.env.HAVE_AI_API_KEY = 'generic';
    process.env.ANTHROPIC_API_KEY = 'a-key';
    expect(resolveDevAIConfig()?.apiKey).toBe('generic');
  });

  it('a generic key without a provider or detectable key is unconfigured', () => {
    process.env.SMRT_AI_API_KEY = 'k';
    expect(resolveDevAIConfig()).toBeNull();
  });
});
