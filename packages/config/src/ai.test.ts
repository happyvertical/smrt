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
    // env base URL belongs to env-provider, not the selected provider.
    expect(r.baseUrl).toBeUndefined();
    expect(r.sources).toEqual({ provider: 'explicit', model: 'config' });
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
    // HAVE_AI_API_KEY belongs to HAVE_AI_PROVIDER=openai: not sent to anthropic.
    expect(r.apiKey).toBeUndefined();
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

describe('credential binding to the selected provider (K1)', () => {
  const config = { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' };
  const env = { OPENAI_API_KEY: SECRET };

  it('explicit provider override discards the config-bound key', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'anthropic' },
      config,
      env,
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBeUndefined();
  });

  it('falls back to the selected provider key variable after discarding', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'anthropic' },
      config,
      env: { ...env, ANTHROPIC_API_KEY: OTHER_SECRET },
    });
    expect(r.apiKey).toBe(OTHER_SECRET);
    expect(r.sources.apiKey).toBe('provider-key-env');
  });

  it('discards a literal config apiKey and config baseUrl too', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'anthropic' },
      config: {
        provider: 'openai',
        apiKey: SECRET,
        baseUrl: 'https://openai-gateway.example/v1',
      },
      env: {},
    });
    expect(r.apiKey).toBeUndefined();
    expect(r.baseUrl).toBeUndefined();
  });

  it('chat-style env override beats config without taking its key', () => {
    const r = resolveAIProviderConfig({
      prefixes: ['SMRT_CHAT_DEV', 'SMRT_AI'],
      envOverridesConfig: true,
      config,
      env: { ...env, SMRT_CHAT_DEV_PROVIDER: 'anthropic' },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBeUndefined();
  });

  it('cross-prefix: a lower prefix key bound to another provider is dropped', () => {
    const r = resolveAIProviderConfig({
      prefixes: ['SMRT_CHAT_DEV', 'SMRT_AI'],
      env: {
        SMRT_CHAT_DEV_PROVIDER: 'anthropic',
        SMRT_AI_PROVIDER: 'openai',
        SMRT_AI_API_KEY: SECRET,
        SMRT_AI_BASE_URL: 'https://openai-gateway.example/v1',
      },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBeUndefined();
    expect(r.baseUrl).toBeUndefined();
  });

  it('explicit apiKey is kept when explicit selects the provider', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'anthropic', apiKey: OTHER_SECRET },
      config,
      env,
    });
    expect(r.apiKey).toBe(OTHER_SECRET);
  });

  it('same-provider setups are unchanged', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'OpenAI' },
      config: { ...config, baseUrl: 'https://gw.example/v1' },
      env,
    });
    expect(r.apiKey).toBe(SECRET);
    expect(r.baseUrl).toBe('https://gw.example/v1');
  });

  it('a key with no provider in its source binds to the selected provider', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'anthropic' },
      env: { SMRT_AI_API_KEY: SECRET },
    });
    expect(r.apiKey).toBe(SECRET);
  });
});

describe('base URL redaction (K2)', () => {
  it('exposes at most the origin, never path tokens', () => {
    const r = resolveAIProviderConfig({
      explicit: {
        provider: 'openai',
        baseUrl: 'https://u:p@gateway.example:8443/v1/token-secret?k=1#f',
      },
      env: {},
    });
    expect(r.baseUrl).toContain('token-secret');
    for (const text of [
      JSON.stringify(r),
      JSON.stringify(describeAIProviderConfig(r)),
    ]) {
      expect(text).not.toContain('token-secret');
      expect(text).toContain('https://gateway.example:8443');
    }
  });
});

describe('ai block layers keep provider ownership (L1)', () => {
  type Layer = 'file.packages' | 'file.ai' | 'runtime.packages' | 'runtime.ai';
  const ORDER: Layer[] = [
    'file.packages',
    'file.ai',
    'runtime.packages',
    'runtime.ai',
  ];
  function apply(layer: Layer, block: Record<string, string>) {
    if (layer.startsWith('file')) {
      const cur = (globalThis.__smrtConfigCache ?? {}) as Record<string, any>;
      if (layer === 'file.ai') cur.ai = block;
      else cur.packages = { ...(cur.packages ?? {}), ai: block };
      globalThis.__smrtConfigCache = cur;
    } else if (layer === 'runtime.ai') {
      setConfig({ ai: block });
    } else {
      setConfig({ packages: { ai: block } });
    }
  }

  const pairs: [Layer, Layer][] = [];
  for (let i = 0; i < ORDER.length; i++) {
    for (let j = i + 1; j < ORDER.length; j++) pairs.push([ORDER[i], ORDER[j]]);
  }

  it.each(
    pairs,
  )('%s (openai) < %s (anthropic): lower credentials dropped', (low, high) => {
    apply(low, {
      provider: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      apiKey: SECRET,
      baseUrl: 'https://openai-gw.example/v1',
      model: 'gpt-x',
    });
    apply(high, { provider: 'anthropic' });
    expect(getAIConfigBlock()).toEqual({ provider: 'anthropic' });
  });

  it.each(pairs)('%s < %s: same provider layers still merge', (low, high) => {
    apply(low, { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' });
    apply(high, { provider: 'OpenAI', model: 'gpt-y' });
    expect(getAIConfigBlock()).toMatchObject({
      apiKeyEnv: 'OPENAI_API_KEY',
      model: 'gpt-y',
    });
  });

  it('a provider-less higher layer binds to the provider selected so far', () => {
    apply('file.ai', { provider: 'openai' });
    apply('runtime.ai', { apiKeyEnv: 'OPENAI_API_KEY' });
    expect(getAIConfigBlock()).toEqual({
      provider: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
    });
  });

  it('the issue example resolves to Anthropic without the OpenAI key', () => {
    apply('file.packages', { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' });
    apply('file.ai', { provider: 'anthropic' });
    const r = resolveConfiguredAIProvider({ env: { OPENAI_API_KEY: SECRET } });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBeUndefined();
  });
});

describe('alias normalisation (L3)', () => {
  it('a blank provider does not suppress the type alias in binding', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: ' ', type: 'anthropic', apiKey: OTHER_SECRET },
      config: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: SECRET },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBe(OTHER_SECRET);
  });

  it('a type-owned explicit provider still drops the config key', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: '', type: 'anthropic' },
      config: { provider: 'openai', apiKeyEnv: 'OPENAI_API_KEY' },
      env: { OPENAI_API_KEY: SECRET },
    });
    expect(r.provider).toBe('anthropic');
    expect(r.apiKey).toBeUndefined();
  });

  it('a blank model falls through to defaultModel', () => {
    const r = resolveAIProviderConfig({
      explicit: { provider: 'openai', model: '  ', defaultModel: 'gpt-z' },
      env: {},
    });
    expect(r.model).toBe('gpt-z');
  });
});
