import { describe, expect, it } from 'vitest';
import { parseToolArgs, runRuntimeTool } from './dev-runtime.js';

describe('dev:runtime (#2782)', () => {
  it('parses repeatable key=value args with coercion', () => {
    expect(
      parseToolArgs([
        'limit=5',
        'detail=true',
        'objects=Article,Author',
        'name=Article',
      ]),
    ).toEqual({
      limit: 5,
      detail: true,
      objects: ['Article', 'Author'],
      name: 'Article',
    });
    expect(parseToolArgs('name=One')).toEqual({ name: 'One' });
    expect(parseToolArgs(undefined)).toEqual({});
  });

  it('calls the dev-plane JSON route with the bearer token when a URL is given', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          ok: true,
          data: { provenance: 'live (app registry)' },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }) as unknown as typeof fetch;
    const { source, result } = await runRuntimeTool(
      'registry-live',
      { objects: ['Article'] },
      { url: 'http://127.0.0.1:5173/api/_dev/', token: 't0k', fetchImpl },
    );
    expect(source).toBe('dev-plane');
    expect((result as { ok: boolean }).ok).toBe(true);
    expect(calls[0].url).toBe('http://127.0.0.1:5173/api/_dev/registry-live');
    expect(
      (calls[0].init.headers as Record<string, string>).authorization,
    ).toBe('Bearer t0k');
    expect(calls[0].init.body).toBe(JSON.stringify({ objects: ['Article'] }));
  });

  it('refuses a URL without a token and rejects unknown local tools', async () => {
    const saved = process.env.SMRT_DEV_MCP_TOKEN;
    delete process.env.SMRT_DEV_MCP_TOKEN;
    try {
      await expect(
        runRuntimeTool('registry-drift', {}, { url: 'http://127.0.0.1:1/x' }),
      ).rejects.toThrow(/token/);
    } finally {
      if (saved !== undefined) process.env.SMRT_DEV_MCP_TOKEN = saved;
    }
    await expect(runRuntimeTool('nope', {})).rejects.toThrow(
      /Unknown runtime tool/,
    );
  });

  it('falls back to the local Level 2 boot without a URL', async () => {
    const saved = process.env.SMRT_DEV_PLANE_URL;
    delete process.env.SMRT_DEV_PLANE_URL;
    try {
      const { source, result } = await runRuntimeTool('registry-drift', {});
      expect(source).toBe('local');
      expect((result as { ok: boolean }).ok).toBe(true);
    } finally {
      if (saved !== undefined) process.env.SMRT_DEV_PLANE_URL = saved;
    }
  });
});
