import { afterEach, describe, expect, it } from 'vitest';
import {
  AIProviderNotConfiguredError,
  clearCache,
  clearRuntimeConfig,
  describeAIProviderConfig,
  getAIConfigBlock,
  getDefaultAIKeyEnvName,
  resolveAIProviderConfig,
  resolveConfiguredAIProvider,
  setConfig,
  toAIClientOptions,
  tryResolveAIProviderConfig,
  tryResolveConfiguredAIProvider,
} from './index.js';

const SECRET = 'sk-super-secret-value-123';
const OTHER_SECRET = 'sk-other-provider-secret-456';

afterEach(() => {
  clearRuntimeConfig();
  clearCache();
});

describe('resolveAIProviderConfig precedence', () => {
  it('explicit beats config beats env beats provider key env', () => {
    const env = {
      SMRT_AI_PROVIDER: 'env-provider',
      SMRT_AI_MODEL: 'env-model',
      SMRT_AI_BASE_URL: 'https://env.example/v1',
    };
    const config = { provider: 'cfg-provider', model: 'cfg-model' };
    const r = resolveAIProviderConfig({
      explicit: { provider: 'explicit-provider' },
      config,
      env,
    });
    expect(r.provider).toBe('explicit-provider');
    expect(r.model).toBe('cfg-model');
    expect(r.baseUrl).toBe('https://env.example/v1');
    expect(r.sources).toEqual({
      provider: 'explicit',
      model: 'config',
      baseUrl: 'env:SMRT_AI_BASE_URL',
    });
  });

  it('accepts type/defaultModel aliases in explicit', () => {
    const r = resolveAIProviderConfig({
      explicit: { type: 'openai', defaultModel: 'gpt-x', apiKey: SECRET },
      env: {},
    });
    expect(toAIClientOptions(r)).toEqual({
      type: 'openai',
      provider: 'openai',
      apiKey: SECRET,
      defaultModel: 'gpt-x',
    });
  });

  it('walks prefixes in order and per field', () => {
    const r = resolveAIProviderConfig({
      prefixes: ['SMRT_CHAT_DEV', 'SMRT_AI', 'HAVE_AI'],
      env: {
        HAVE_AI_PROVIDER: 'openai',
        SMRT_AI_PROVIDER: 'anthropic',
        HAVE_AI_API_KEY: SECRET,
        SMRT_CHAT_DEV_MODEL: 'dev-model',
        SMRT_AI_MODEL: 'ai-model',
      },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBe(SECRET);
    expect(r.model).toBe('dev-model');
  });

  it('default prefixes are SMRT_AI then HAVE_AI only', () => {
    const r = resolveAIProviderConfig({
      env: { SMRT_CHAT_DEV_PROVIDER: 'x', HAVE_AI_PROVIDER: 'gemini' },
    });
    expect(r.provider).toBe('gemini');
  });

  it('envOverridesConfig lets env beat the config block', () => {
    const base = {
      config: { provider: 'cfg' },
      env: { SMRT_AI_PROVIDER: 'envp' },
    };
    expect(resolveAIProviderConfig(base).provider).toBe('cfg');
    expect(
      resolveAIProviderConfig({ ...base, envOverridesConfig: true }).provider,
    ).toBe('envp');
  });

  it('generic key beats provider-specific key', () => {
    const r = resolveAIProviderConfig({
      env: {
        SMRT_AI_PROVIDER: 'openai',
        SMRT_AI_API_KEY: SECRET,
        OPENAI_API_KEY: OTHER_SECRET,
      },
    });
    expect(r.apiKey).toBe(SECRET);
  });

  it('config apiKeyEnv reads the named variable', () => {
    const r = resolveAIProviderConfig({
      config: { provider: 'openai', apiKeyEnv: 'MY_KEY' },
      env: { MY_KEY: SECRET, OPENAI_API_KEY: OTHER_SECRET },
    });
    expect(r.apiKey).toBe(SECRET);
    expect(r.sources.apiKey).toBe('config');
  });

  it('config apiKeyEnv pointing at an unset variable falls through', () => {
    const r = resolveAIProviderConfig({
      config: { provider: 'openai', apiKeyEnv: 'MISSING' },
      env: { OPENAI_API_KEY: SECRET },
    });
    expect(r.apiKey).toBe(SECRET);
    expect(r.sources.apiKey).toBe('provider-key-env');
  });
});

describe('provider selection', () => {
  it('auto-detects openai > anthropic > gemini', () => {
    expect(
      resolveAIProviderConfig({
        env: {
          GEMINI_API_KEY: 'g',
          ANTHROPIC_API_KEY: 'a',
          OPENAI_API_KEY: 'o',
        },
      }).provider,
    ).toBe('openai');
    expect(
      resolveAIProviderConfig({
        env: { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' },
      }).provider,
    ).toBe('anthropic');
    const r = resolveAIProviderConfig({ env: { GEMINI_API_KEY: 'g' } });
    expect(r.provider).toBe('gemini');
    expect(r.sources.provider).toBe('auto-detect');
  });

  it('autoDetect:false disables detection', () => {
    expect(
      tryResolveAIProviderConfig({
        autoDetect: false,
        env: { OPENAI_API_KEY: SECRET },
      }),
    ).toBeUndefined();
  });

  it('never uses a key for a provider that is not selected', () => {
    const r = resolveAIProviderConfig({
      env: { SMRT_AI_PROVIDER: 'anthropic', OPENAI_API_KEY: OTHER_SECRET },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBeUndefined();
  });

  it('uses the selected provider key variable, case-insensitively', () => {
    const r = resolveAIProviderConfig({
      env: { SMRT_AI_PROVIDER: 'Anthropic', ANTHROPIC_API_KEY: SECRET },
    });
    expect(r.provider).toBe('Anthropic');
    expect(r.apiKey).toBe(SECRET);
  });

  it('passes unknown providers through with no fallback key', () => {
    const r = resolveAIProviderConfig({
      env: { SMRT_AI_PROVIDER: 'claude-cli', OPENAI_API_KEY: OTHER_SECRET },
    });
    expect(r.provider).toBe('claude-cli');
    expect(r.apiKey).toBeUndefined();
    expect(getDefaultAIKeyEnvName('claude-cli')).toBeUndefined();
    expect(getDefaultAIKeyEnvName('__proto__')).toBeUndefined();
  });

  it('missing optional fields stay undefined and are omitted for getAI', () => {
    const r = resolveAIProviderConfig({ env: { SMRT_AI_PROVIDER: 'openai' } });
    expect(toAIClientOptions(r)).toEqual({
      type: 'openai',
      provider: 'openai',
    });
  });

  it('ignores blank values', () => {
    const r = tryResolveAIProviderConfig({
      env: { SMRT_AI_PROVIDER: '   ', HAVE_AI_PROVIDER: '' },
    });
    expect(r).toBeUndefined();
  });

  it('requireProvider:false accepts a key alone', () => {
    const r = resolveAIProviderConfig({
      requireProvider: false,
      autoDetect: false,
      env: { SMRT_AI_API_KEY: SECRET },
    });
    expect(r.provider).toBeUndefined();
    expect(r.apiKey).toBe(SECRET);
    expect(
      tryResolveAIProviderConfig({
        autoDetect: false,
        env: { SMRT_AI_API_KEY: SECRET },
      }),
    ).toBeUndefined();
  });
});

describe('not configured and secret hygiene', () => {
  it('throws a clear error that contains no secret material', () => {
    const env = { SMRT_AI_API_KEY: SECRET, OTHER: OTHER_SECRET };
    let error: unknown;
    try {
      resolveAIProviderConfig({
        env,
        config: { baseUrl: 'https://user:pw-secret@host/v1', apiKey: SECRET },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AIProviderNotConfiguredError);
    const text = `${(error as Error).message}${(error as Error).stack}${JSON.stringify(error)}`;
    expect((error as Error).message).toContain('smrt.config.ts');
    expect((error as Error).message).toContain('SMRT_AI_PROVIDER');
    expect((error as Error).message).toContain('OPENAI_API_KEY');
    for (const s of [SECRET, OTHER_SECRET, 'pw-secret']) {
      expect(text).not.toContain(s);
    }
  });

  it('toJSON, describe and util.inspect-free JSON never leak the key', () => {
    const r = resolveAIProviderConfig({
      env: { SMRT_AI_PROVIDER: 'openai', SMRT_AI_API_KEY: SECRET },
      explicit: { baseUrl: 'https://user:pw-secret@host/v1?token=abc' },
    });
    for (const text of [
      JSON.stringify(r),
      JSON.stringify(describeAIProviderConfig(r)),
    ]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('pw-secret');
      expect(text).not.toContain('token=abc');
    }
    expect(JSON.parse(JSON.stringify(r)).apiKey).toBe('[redacted]');
    expect(Object.keys(r)).not.toContain('toJSON');
  });
});

describe('configured block', () => {
  it('merges runtime > file fields and falls back to packages.ai', () => {
    setConfig({ packages: { ai: { provider: 'openai', model: 'm1' } } });
    expect(getAIConfigBlock()).toEqual({ provider: 'openai', model: 'm1' });
    setConfig({ ai: { model: 'm2' } });
    expect(getAIConfigBlock()).toEqual({ provider: 'openai', model: 'm2' });
  });

  it('returns null when nothing is declared', () => {
    expect(getAIConfigBlock()).toBeNull();
  });

  it('resolveConfiguredAIProvider reads the config block', () => {
    setConfig({ ai: { provider: 'openai', apiKeyEnv: 'LANE_KEY' } });
    process.env.LANE_KEY = SECRET;
    try {
      const r = resolveConfiguredAIProvider({ env: process.env });
      expect(r.provider).toBe('openai');
      expect(r.apiKey).toBe(SECRET);
      expect(
        tryResolveConfiguredAIProvider({ config: null, env: {} }),
      ).toBeUndefined();
    } finally {
      delete process.env.LANE_KEY;
    }
  });
});
