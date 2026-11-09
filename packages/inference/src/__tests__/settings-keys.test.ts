import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseInferenceProviderConfig } from '../provider-config.js';
import {
  bindInferenceKey,
  InferenceKeyOriginError,
  InferenceSettingsService,
  inferenceKeyFor,
  inferenceKeyOrigin,
  inferenceProviderConfigFromKey,
  redactInferenceSecret,
} from '../server.js';

const KEY = 'sk-test-0123456789abcdef';

describe('origin-bound keys', () => {
  it('binds a key to its endpoint origin', () => {
    expect(inferenceKeyOrigin({ provider: 'openai' })).toBe(
      'https://api.openai.com',
    );
    expect(inferenceKeyOrigin({ provider: 'anthropic' })).toBe(
      'https://api.anthropic.com',
    );
    expect(inferenceKeyOrigin({ preset: 'openrouter' })).toBe(
      'https://openrouter.ai',
    );
    // The panel's preset choices arrive as a provider id.
    expect(inferenceKeyOrigin({ provider: 'openrouter' })).toBe(
      'https://openrouter.ai',
    );
    expect(bindInferenceKey({ provider: 'openrouter', key: KEY }).origin).toBe(
      'https://openrouter.ai',
    );
    expect(
      inferenceKeyOrigin({ provider: 'openai', baseUrl: 'https://gw.test/v1' }),
    ).toBe('https://gw.test');
    expect(
      inferenceKeyOrigin({
        provider: 'openai',
        baseUrl: 'http://localhost:4000/v1',
      }),
    ).toBe('http://localhost:4000');
    // Gateways and unknown providers need an explicit endpoint.
    expect(inferenceKeyOrigin({ provider: 'litellm' })).toBeNull();
    expect(inferenceKeyOrigin({ provider: 'nope' })).toBeNull();
  });

  it('refuses keys it cannot bind safely', () => {
    expect(() => bindInferenceKey({ provider: 'litellm', key: KEY })).toThrow(
      InferenceKeyOriginError,
    );
    expect(() =>
      bindInferenceKey({
        provider: 'openai',
        key: KEY,
        baseUrl: 'http://gw.example.com/v1',
      }),
    ).toThrow(/https/);
    expect(() =>
      bindInferenceKey({
        provider: 'openai',
        key: KEY,
        baseUrl: 'https://user:pass@gw.test/v1',
      }),
    ).toThrow(/credentials/);
    expect(() => bindInferenceKey({ provider: 'openai', key: '  ' })).toThrow(
      /empty/,
    );
  });

  it('sends a key only to its bound origin', () => {
    const record = bindInferenceKey({ provider: 'openai', key: KEY });
    expect(inferenceKeyFor(record, 'https://api.openai.com/v1/models')).toBe(
      KEY,
    );
    expect(inferenceKeyFor(record, 'https://api.openai.com.evil.test/v1')).toBe(
      undefined,
    );
    expect(inferenceKeyFor(record, 'http://api.openai.com/v1')).toBe(undefined);
    expect(inferenceKeyFor(record, 'not a url')).toBe(undefined);
  });

  it('redacts keys from text', () => {
    expect(redactInferenceSecret(`failed with ${KEY}`, KEY)).toBe(
      'failed with [redacted]',
    );
    expect(redactInferenceSecret('Bearer abcdefghijklmnop')).toBe(
      'Bearer [redacted]',
    );
  });
});

describe('inferenceProviderConfigFromKey (#4754 keys into #4756 storage)', () => {
  it('turns every bound key into a valid self-contained provider config', () => {
    const openai = inferenceProviderConfigFromKey(
      bindInferenceKey({ provider: 'openai', key: KEY }),
      { model: 'gpt-x' },
    );
    expect(openai).toEqual({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-x',
      apiKey: KEY,
    });
    expect(parseInferenceProviderConfig(openai)).toMatchObject(openai);

    // The Anthropic SDK appends /v1 itself: the stored base is host-only.
    expect(
      inferenceProviderConfigFromKey(
        bindInferenceKey({ provider: 'anthropic', key: KEY }),
        { model: 'claude-x' },
      ),
    ).toEqual({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-x',
      apiKey: KEY,
    });

    const gateway = inferenceProviderConfigFromKey(
      bindInferenceKey({
        provider: 'litellm',
        key: KEY,
        baseUrl: 'https://gw.example/v1',
      }),
    );
    expect(parseInferenceProviderConfig(gateway)).toMatchObject({
      provider: 'litellm',
      baseUrl: 'https://gw.example/v1',
    });

    // The panel's preset choice arrives as a provider id.
    const preset = inferenceProviderConfigFromKey(
      bindInferenceKey({ provider: 'openrouter', key: KEY }),
      { model: 'x/y' },
    );
    expect(preset).toEqual({ preset: 'openrouter', model: 'x/y', apiKey: KEY });
    expect(parseInferenceProviderConfig(preset)).toMatchObject(preset);

    // A preset key entered for a custom base URL keeps that endpoint: the
    // preset's default origin never receives it.
    const custom = inferenceProviderConfigFromKey(
      bindInferenceKey({
        provider: 'openrouter',
        baseUrl: 'https://private.example/v1',
        key: KEY,
      }),
      { model: 'x/y' },
    );
    expect(custom).toEqual({
      provider: 'openai',
      baseUrl: 'https://private.example/v1',
      model: 'x/y',
      apiKey: KEY,
    });
    expect(parseInferenceProviderConfig(custom)).toMatchObject(custom);
  });

  it('refuses a preset key without a model and an endpoint off the bound origin', () => {
    expect(() =>
      inferenceProviderConfigFromKey(
        bindInferenceKey({ provider: 'openrouter', key: KEY }),
      ),
    ).toThrow(InferenceKeyOriginError);
    expect(() =>
      inferenceProviderConfigFromKey({
        provider: 'openai',
        origin: 'https://other.example',
        apiKey: KEY,
      }),
    ).toThrow(InferenceKeyOriginError);
    expect(() =>
      inferenceProviderConfigFromKey(
        {
          provider: 'openrouter',
          origin: 'https://other.example',
          apiKey: KEY,
        },
        { model: 'x/y' },
      ),
    ).toThrow(InferenceKeyOriginError);
  });
});

describe('InferenceSettingsService.testConnection', () => {
  let db: DatabaseInterface;
  let service: InferenceSettingsService;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['InferenceOverride'] });
    service = await InferenceSettingsService.create(
      { db },
      { config: () => ({}) },
    );
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('sends the stored key to its own origin and never returns it', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const record = bindInferenceKey({ provider: 'openai', key: KEY });
    const result = await service.testConnection(
      { provider: 'openai', model: 'gpt-x' },
      { key: record, fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(result).toMatchObject({ reachable: true, keySent: true });
    expect(JSON.stringify(result)).not.toContain(KEY);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );
  });

  it('never sends a key to an endpoint on another origin', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const record = bindInferenceKey({ provider: 'openai', key: KEY });
    const result = await service.testConnection(
      { provider: 'openai', baseUrl: 'https://attacker.test/v1' },
      { key: record, fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result.keySent).toBe(false);
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain('https://api.openai.com');
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('reads no environment key for the default-view test', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 401 }));
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = KEY;
    try {
      const result = await service.testConnection(
        { provider: 'openai' },
        { fetch: fetch as unknown as typeof globalThis.fetch },
      );
      const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(init.headers).toEqual({});
      expect(result).toMatchObject({ reachable: false, keySent: false });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it('refuses a literal key on a tested candidate', async () => {
    await expect(
      service.testCandidate({ provider: 'openai', apiKey: KEY }),
    ).rejects.toThrow(/literal key/);
  });

  it('reads a key variable only for a configured candidate', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const env = { GW_KEY: KEY };
    const configured = {
      provider: 'openai',
      model: 'gpt-gw',
      baseUrl: 'https://gw.test/v1',
      apiKeyEnv: 'GW_KEY',
    };
    service = await InferenceSettingsService.create(
      { db },
      {
        config: () => ({
          aliases: { gateway: { candidates: [configured] } },
        }),
      },
    );
    await service.testCandidate(configured, {
      env,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const first = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(first[0]).toBe('https://gw.test/v1/models');
    expect((first[1].headers as Record<string, string>).authorization).toBe(
      `Bearer ${KEY}`,
    );

    // The same key variable pointed at an endpoint the caller chose.
    await service.testCandidate(
      { ...configured, baseUrl: 'https://attacker.test/v1' },
      { env, fetch: fetch as unknown as typeof globalThis.fetch },
    );
    const second = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(second[0]).toBe('https://attacker.test/v1/models');
    expect(second[1].headers).toEqual({});
  });
});
