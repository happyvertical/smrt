/**
 * `smrt doctor --ai` checks (#4752): offline fixtures and a fake fetch for
 * probes; no network.
 */
import type { InferenceConfig } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import {
  checkInferenceBindings,
  formatInferenceDoctorReport,
  probeInferenceCandidate,
} from '../node.js';

const SECRET = 'sk-never-printed';

const GOOD: InferenceConfig = {
  aliases: {
    frontier: {
      description: 'best hosted first',
      candidates: [
        { provider: 'anthropic', model: 'claude-x' },
        {
          provider: 'openai',
          model: 'gpt-x',
          baseUrl: 'https://proxy.example/v1',
          apiKeyEnv: 'PROXY_KEY',
        },
        { alias: 'local' },
      ],
    },
    local: { candidates: [{ preset: 'lemonade', model: 'qwen' }] },
  },
  tiers: {
    great: { alias: 'frontier' },
    cheap: { provider: 'openai', model: 'mini' },
  },
};

const env = {
  ANTHROPIC_API_KEY: SECRET,
  PROXY_KEY: SECRET,
  OPENAI_API_KEY: SECRET,
};

function byBinding(report: Awaited<ReturnType<typeof checkInferenceBindings>>) {
  return Object.fromEntries(
    report.bindings.map((binding) => [binding.binding, binding]),
  );
}

describe('checkInferenceBindings (offline)', () => {
  it('passes a resolvable config and reports unbound tiers as the configured client', async () => {
    const report = await checkInferenceBindings({ config: GOOD, env });
    expect(report.ok).toBe(true);
    expect(report.configured).toBe(true);
    const bindings = byBinding(report);
    expect(bindings['tier:good']).toMatchObject({
      status: 'ok',
      target: 'the configured client',
    });
    expect(bindings['tier:great']?.status).toBe('ok');
    expect(bindings['alias:frontier']?.candidates.map((c) => c.label)).toEqual([
      'anthropic/claude-x',
      'openai/gpt-x',
      'alias:local',
    ]);
  });

  it('reports an unconfigured app as ok', async () => {
    const report = await checkInferenceBindings({ config: undefined, env: {} });
    expect(report.ok).toBe(true);
    expect(report.configured).toBe(false);
    expect(formatInferenceDoctorReport(report)[0]).toContain(
      'every tier uses the configured AI client',
    );
  });

  it('fails a tier pointing at an unknown alias, naming it', async () => {
    const report = await checkInferenceBindings({
      config: { tiers: { best: { alias: 'ghost' } } },
      env,
    });
    expect(report.ok).toBe(false);
    expect(byBinding(report)['tier:best']).toMatchObject({
      status: 'error',
      problems: [expect.stringContaining('unknown alias "ghost"')],
    });
  });

  it('checks fusion tiers and fusion structure without the app prompts (#4753)', async () => {
    const report = await checkInferenceBindings({
      config: {
        tiers: { best: { fusion: 'review' }, great: { fusion: 'ghost' } },
        fusions: {
          review: {
            mode: 'handoff',
            description: 'draft then review',
            seats: [
              { name: 'a', prompt: 'unloaded.prompt', target: 'cheap' },
              { name: 'b', prompt: 'unloaded.prompt', target: 'great' },
            ],
          },
          broken: { mode: 'pair', seats: [] },
        },
      },
      env,
    });
    const bindings = byBinding(report);
    expect(bindings['tier:best']).toMatchObject({
      status: 'ok',
      target: 'fusion review',
    });
    expect(bindings['tier:great']).toMatchObject({
      status: 'error',
      problems: [expect.stringContaining('unknown fusion "ghost"')],
    });
    expect(bindings['fusion:review']).toMatchObject({
      status: 'ok',
      target: 'handoff, 2 seat(s) — draft then review',
    });
    expect(bindings['fusion:broken']).toMatchObject({
      status: 'error',
      problems: [expect.stringContaining('exactly 3 seat(s)')],
    });
  });

  it('fails a cycle and an empty alias', async () => {
    const report = await checkInferenceBindings({
      config: {
        aliases: {
          a: { candidates: [{ alias: 'b' }] },
          b: { candidates: [{ alias: 'a' }] },
          empty: { candidates: [] },
        },
      },
      env,
    });
    expect(report.ok).toBe(false);
    const bindings = byBinding(report);
    expect(bindings['alias:a']?.problems.join(' ')).toContain('cycle');
    expect(bindings['alias:empty']?.problems.join(' ')).toContain(
      'has no candidates',
    );
  });

  it('fails a binding whose only candidate has an unknown provider or unset key', async () => {
    const report = await checkInferenceBindings({
      config: {
        tiers: {
          good: { candidates: [{ provider: 'nope', model: 'x' }] },
          best: {
            candidates: [
              {
                provider: 'openai',
                model: 'x',
                baseUrl: 'https://proxy.example/v1',
                apiKeyEnv: 'UNSET_4752',
              },
            ],
          },
        },
      },
      env: {},
    });
    const bindings = byBinding(report);
    expect(bindings['tier:good']?.status).toBe('error');
    expect(bindings['tier:good']?.candidates[0]?.problems[0]).toContain(
      'provider "nope" is not recognized',
    );
    expect(bindings['tier:best']?.candidates[0]?.problems[0]).toContain(
      'key variable UNSET_4752 is not set',
    );
    expect(report.ok).toBe(false);
  });

  it('warns, without failing, when one candidate of a chain is unusable', async () => {
    const report = await checkInferenceBindings({
      config: {
        tiers: {
          great: {
            candidates: [
              { provider: 'nope', model: 'x' },
              { provider: 'anthropic' },
            ],
          },
        },
      },
      env,
    });
    expect(report.ok).toBe(true);
    expect(byBinding(report)['tier:great']?.status).toBe('warn');
  });

  it('warns that HAVE_AI_* makes core refuse another provider without its own endpoint', async () => {
    const report = await checkInferenceBindings({
      config: {
        tiers: {
          great: { candidates: [{ provider: 'anthropic', model: 'x' }] },
        },
      },
      env: { ...env, HAVE_AI_API_KEY: SECRET },
    });
    const candidate = byBinding(report)['tier:great']?.candidates[0];
    expect(candidate?.status).toBe('warn');
    expect(candidate?.problems.join(' ')).toContain('HAVE_AI_API_KEY is set');
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it('reports a structurally invalid block instead of throwing', async () => {
    const report = await checkInferenceBindings({
      config: { defaultTier: 'fast' } as never,
      env,
    });
    expect(report.ok).toBe(false);
    expect(report.bindings[0]?.problems[0]).toContain('inference.defaultTier');
  });

  it('never prints a key', async () => {
    const report = await checkInferenceBindings({ config: GOOD, env });
    const lines = formatInferenceDoctorReport(report).join('\n');
    expect(lines).not.toContain(SECRET);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
});

describe('probes', () => {
  it('calls each candidate list endpoint with its own key and reports reachability', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      if (url.startsWith('https://api.anthropic.com')) {
        expect(headers['x-api-key']).toBe(SECRET);
        return new Response('{}', { status: 200 });
      }
      if (url.startsWith('https://proxy.example')) {
        return new Response('{}', { status: 401 });
      }
      return new Response('{}', { status: 200 });
    });
    const report = await checkInferenceBindings({
      config: GOOD,
      env,
      probe: true,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const calls = fetch.mock.calls.map(([url]) => url);
    expect(calls).toContain('https://api.anthropic.com/v1/models');
    expect(calls).toContain('https://proxy.example/v1/models');
    expect(calls).toContain('http://127.0.0.1:13305/v1/models');
    expect(calls).toContain('https://api.openai.com/v1/models');
    const frontier = byBinding(report)['alias:frontier'];
    expect(frontier?.candidates[1]).toMatchObject({
      status: 'error',
      probe: { reachable: false, status: 401 },
    });
    expect(frontier?.status).toBe('warn');
    expect(report.ok).toBe(true);
    expect(formatInferenceDoctorReport(report).join('\n')).not.toContain(
      SECRET,
    );
  });

  it('never follows a redirect with the key', async () => {
    const fetch = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(null, {
          status: init.redirect === 'manual' ? 302 : 200,
          headers: { location: 'https://elsewhere.example/' },
        }),
    );
    const result = await probeInferenceCandidate(
      { provider: 'anthropic', model: 'x' },
      { env, fetch: fetch as unknown as typeof globalThis.fetch },
    );
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(result).toMatchObject({ reachable: false, status: 302 });
    expect(result.detail).toContain('redirected (not followed');
  });

  it('times out a silent endpoint', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const result = await probeInferenceCandidate(
      { provider: 'ollama', model: 'llama' },
      {
        env: {},
        timeoutMs: 10,
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );
    expect(result).toMatchObject({ reachable: false });
    expect(result.detail).toContain('did not answer within 10 ms');
    expect(fetch.mock.calls[0]?.[0]).toBe('http://127.0.0.1:11434/api/tags');
  });

  it('never sends a candidate key without its own baseUrl', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    for (const candidate of [
      { provider: 'openai', model: 'm', apiKey: SECRET },
      { provider: 'openai', model: 'm', apiKeyEnv: 'PROXY_KEY' },
      { preset: 'unknown', model: 'm', apiKey: SECRET },
      { preset: 'unknown', model: 'm', apiKeyEnv: 'PROXY_KEY' },
    ]) {
      const result = await probeInferenceCandidate(candidate, {
        env,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
      expect(result).toMatchObject({ reachable: false });
      expect(result.detail).toMatch(/needs its own baseUrl|unknown preset/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips providers with no cheap probe', async () => {
    const result = await probeInferenceCandidate(
      { provider: 'claude-cli', model: 'x' },
      { env: {} },
    );
    expect(result).toMatchObject({ reachable: false, skipped: true });
  });

  it('never probes OpenAI with a gateway key when the gateway has no base URL', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const result = await probeInferenceCandidate(
      { provider: 'litellm', model: 'x' },
      {
        env: { LITELLM_API_KEY: 'sk-gateway-secret' },
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reachable: false, skipped: true });
  });
});
