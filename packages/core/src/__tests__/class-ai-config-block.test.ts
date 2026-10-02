/**
 * SmrtClass AI provider selection through the shared smrt-config resolver
 * (#3372): options.ai > core global config > smrt.config `ai` block > SMRT_AI_*.
 */
import { clearRuntimeConfig, setConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { SmrtClass } from '../class.js';
import { config } from '../config.js';

class Probe extends SmrtClass {
  async init(): Promise<this> {
    return this.initialize();
  }
  async client() {
    return this.getOptionalAiClient();
  }
}

const SECRET = 'sk-core-secret-xyz';
const ENV_KEYS = [
  'SMRT_AI_PROVIDER',
  'SMRT_AI_API_KEY',
  'SMRT_AI_MODEL',
  'CORE_TEST_KEY',
];

describe('SmrtClass AI config block', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    config.reset();
    clearRuntimeConfig();
    getAIMock.mockReset();
    getAIMock.mockResolvedValue({ embed: async () => ({ embeddings: [[]] }) });
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    config.reset();
    clearRuntimeConfig();
  });

  it('does not initialize a client when nothing is configured', async () => {
    await new Probe().init();
    expect(getAIMock).not.toHaveBeenCalled();
  });

  it('uses the config block, with the key from the named env variable', async () => {
    setConfig({
      ai: { provider: 'openai', model: 'gpt-x', apiKeyEnv: 'CORE_TEST_KEY' },
    });
    process.env.CORE_TEST_KEY = SECRET;
    await new Probe().client();
    expect(getAIMock).toHaveBeenCalledTimes(1);
    expect(getAIMock.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      apiKey: SECRET,
      defaultModel: 'gpt-x',
    });
  });

  it('config block beats SMRT_AI_* env; options.ai beats the block', async () => {
    setConfig({ ai: { provider: 'openai' } });
    process.env.SMRT_AI_PROVIDER = 'anthropic';
    process.env.SMRT_AI_API_KEY = SECRET;
    await new Probe().client();
    expect(getAIMock.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      apiKey: SECRET,
    });

    getAIMock.mockClear();
    await new Probe({ ai: { provider: 'gemini' } } as never).client();
    expect(getAIMock.mock.calls[0][0].provider).toBe('gemini');
  });

  it('keeps legacy behaviour: SMRT_AI_PROVIDER alone still initializes', async () => {
    process.env.SMRT_AI_PROVIDER = 'anthropic';
    await new Probe().client();
    expect(getAIMock.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic',
    });
  });
});
