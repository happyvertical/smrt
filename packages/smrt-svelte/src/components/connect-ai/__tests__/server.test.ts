import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setRuntimeExposureGate } from '@happyvertical/smrt-core/runtime-exposure';
import {
  type ChatGPTPlanStatus,
  createAgentCliService,
} from '@happyvertical/smrt-inference/server';
import {
  fakeDeps,
  installFakeCli,
  tempDir,
} from '@happyvertical/smrt-inference/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectAiClient } from '../client.js';
import {
  type ConnectAiServerBinding,
  mountConnectAiRoutes,
} from '../server.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  setRuntimeExposureGate(undefined);
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});
function setup() {
  const dir = tempDir('connect-ai-route-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const cli = createAgentCliService(fakeDeps(dir, [join(dir, 'bin')]));
  let engine: 'api' | 'codex' | 'chatgpt' | null = null;
  let apiReady = false;
  let plan: ChatGPTPlanStatus = { signedIn: false, signingIn: false };
  const binding: ConnectAiServerBinding = {
    engine: async () => engine,
    select: vi.fn(async (next) => {
      engine = next as typeof engine;
    }),
    cli,
    chatgpt: {
      status: vi.fn(async () => plan),
      start: vi.fn(async () => {
        plan = { signedIn: false, signingIn: true };
        return {
          authorizationUrl: 'https://auth.openai.com/authorize?state=test',
        };
      }),
      signOut: vi.fn(async () => {
        plan = { signedIn: false, signingIn: false };
        return { remoteRevocationConfirmed: true };
      }),
    },
    apiStatus: vi.fn(async () => ({ configured: apiReady })),
  };
  const authorize = vi.fn(async () => binding as ConnectAiServerBinding | null);
  const routes = mountConnectAiRoutes({ authorize });
  return {
    dir,
    binding,
    authorize,
    routes,
    setApi: (value: boolean) => {
      apiReady = value;
    },
    setPlan: (value: ChatGPTPlanStatus) => {
      plan = value;
    },
  };
}
function event(body?: unknown, headers: Record<string, string> = {}) {
  return {
    request: new Request(
      'http://app.test/api/connect-ai',
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: {
              origin: 'http://app.test',
              'content-type': 'application/json',
              ...headers,
            },
            body: JSON.stringify(body),
          },
    ),
    url: new URL('http://app.test/api/connect-ai'),
  };
}

describe('Connect AI route over inference APIs', () => {
  it('connects AI before any cookbook models are enabled', async () => {
    const gate = vi.fn(() => false);
    setRuntimeExposureGate({ isEnabled: gate });
    const { routes, setApi, binding } = setup();
    setApi(true);
    expect(await (await routes.GET(event())).json()).toMatchObject({
      apiReady: true,
    });
    expect(
      (await routes.POST(event({ action: 'select', engine: 'api' }))).status,
    ).toBe(200);
    expect(binding.select).toHaveBeenCalledExactlyOnceWith('api');
    expect(await (await routes.GET(event())).json()).toMatchObject({
      engine: 'api',
      configured: true,
    });
    expect(gate).not.toHaveBeenCalled();
  });

  it('projects missing, installed signed-out, signed-in and saved-key states without secrets', async () => {
    const { routes, binding, dir, setApi, setPlan } = setup();
    const response = await routes.GET(event());
    expect(response.status).toBe(200); // Unconfigured is a normal status response.
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      engine: null,
      configured: false,
      apiReady: false,
      tools: [
        expect.objectContaining({ installed: false }),
        expect.objectContaining({ installed: false }),
      ],
    });
    installFakeCli(join(dir, 'bin'), 'codex');
    expect(await (await routes.GET(event())).json()).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          tool: 'codex',
          installed: true,
          signedIn: false,
        }),
      ]),
    });
    writeFileSync(join(dir, 'signed-in'), '');
    expect(
      (await routes.POST(event({ action: 'select', engine: 'codex' }))).status,
    ).toBe(200);
    expect(await (await routes.GET(event())).json()).toMatchObject({
      engine: 'codex',
      configured: true,
    });
    setApi(true);
    expect(
      (await routes.POST(event({ action: 'select', engine: 'api' }))).status,
    ).toBe(200);
    setPlan({
      signedIn: true,
      signingIn: false,
      account: { label: 'secret-account' },
    });
    vi.mocked(binding.apiStatus).mockResolvedValue({
      configured: true,
      message: 'sk-server-secret',
    });
    const output = await (await routes.GET(event())).text();
    expect(JSON.parse(output)).toMatchObject({
      engine: 'api',
      apiReady: true,
      configured: true,
    });
    expect(output).not.toMatch(/sk-server-secret|secret-account/);
  });

  it('starts only vendor CLI login and lets polling observe completion before selection', async () => {
    const { routes, dir, binding } = setup();
    installFakeCli(join(dir, 'bin'), 'codex');
    const started = await routes.POST(
      event({ action: 'connect', tool: 'codex' }),
    );
    expect(await started.json()).toMatchObject({ result: 'started' });
    await vi.waitFor(async () =>
      expect(
        (await binding.cli.cliStatus('codex', { fresh: true })).signedIn,
      ).toBe(true),
    );
    expect(
      (await routes.POST(event({ action: 'connect', tool: 'codex' }))).status,
    ).toBe(200);
    expect(binding.select).toHaveBeenCalledWith('codex');
  });

  it('starts, polls and signs out ChatGPT through the connection only', async () => {
    const { routes, binding, setPlan } = setup();
    expect(
      await (await routes.POST(event({ action: 'chatgpt-start' }))).json(),
    ).toMatchObject({
      authorizationUrl: 'https://auth.openai.com/authorize?state=test',
    });
    expect(await (await routes.GET(event())).json()).toMatchObject({
      chatgpt: { signingIn: true },
    });
    expect(
      (await routes.POST(event({ action: 'select', engine: 'chatgpt' })))
        .status,
    ).toBe(409);
    setPlan({ signedIn: true, signingIn: false });
    expect(
      (await routes.POST(event({ action: 'select', engine: 'chatgpt' })))
        .status,
    ).toBe(200);
    await routes.POST(event({ action: 'chatgpt-sign-out' }));
    expect(binding.chatgpt.signOut).toHaveBeenCalledOnce();
    expect(await (await routes.GET(event())).json()).toMatchObject({
      engine: 'chatgpt',
      configured: false,
    });
  });

  it('validates the sign-in destination before handing it to a desktop browser', async () => {
    const { authorize, binding } = setup();
    const openBrowser = vi.fn(async () => true);
    const routes = mountConnectAiRoutes({ authorize, openBrowser });
    vi.mocked(binding.chatgpt.start).mockResolvedValue({
      authorizationUrl: 'https://evil.test/token',
    });
    expect((await routes.POST(event({ action: 'chatgpt-start' }))).status).toBe(
      502,
    );
    expect(openBrowser).not.toHaveBeenCalled();
    vi.mocked(binding.chatgpt.start).mockResolvedValue({
      authorizationUrl: 'https://auth.openai.com/authorize',
    });
    expect(
      await (await routes.POST(event({ action: 'chatgpt-start' }))).json(),
    ).toEqual({ opened: true });
    expect(openBrowser).toHaveBeenCalledWith(
      'https://auth.openai.com/authorize',
    );
  });

  it('requires host owner/tenant authorization for every read, poll and mutation', async () => {
    const { routes, binding, authorize } = setup();
    authorize.mockResolvedValue(null);
    expect((await routes.GET(event())).status).toBe(403);
    expect((await routes.POST(event({ action: 'chatgpt-start' }))).status).toBe(
      403,
    );
    expect(binding.chatgpt.status).not.toHaveBeenCalled();
    expect(binding.chatgpt.start).not.toHaveBeenCalled();
    expect(binding.select).not.toHaveBeenCalled();
  });

  it('rejects cross-origin, oversized, malformed and future actions without mutation', async () => {
    const { routes, binding } = setup();
    expect(
      (
        await routes.POST(
          event(
            { action: 'select', engine: 'api' },
            { origin: 'https://evil.test' },
          ),
        )
      ).status,
    ).toBe(403);
    for (const [body, status] of [
      [{ action: 'select', engine: 'future' }, 400],
      [{ action: 'connect', tool: 'bash' }, 400],
      [{ action: 'connect', tool: 'codex' }, 409],
      [{ action: 'new-action' }, 400],
      [[], 400],
      [{ x: 'x'.repeat(2000) }, 413],
    ] as const) {
      expect((await routes.POST(event(body))).status).toBe(status);
    }
    expect(
      (
        await routes.POST(
          event(
            { action: 'select', engine: 'api' },
            { 'content-type': 'application/jsonbad' },
          ),
        )
      ).status,
    ).toBe(415);
    const malformed = event({});
    malformed.request = new Request(malformed.request.url, {
      method: 'POST',
      headers: {
        origin: 'http://app.test',
        'content-type': 'application/json',
      },
      body: '{',
    });
    expect((await routes.POST(malformed)).status).toBe(400);
    expect(binding.select).not.toHaveBeenCalled();
    expect(binding.chatgpt.start).not.toHaveBeenCalled();
  });

  it('returns fixed codes on upstream errors, without SDK messages or keys', async () => {
    const { routes, binding } = setup();
    vi.mocked(binding.chatgpt.status).mockRejectedValue(
      new Error('sk-private-token'),
    );
    expect(await (await routes.GET(event())).json()).toEqual({
      code: 'connect_ai_unavailable',
    });
    vi.mocked(binding.chatgpt.start).mockRejectedValue(
      new Error('sk-private-token'),
    );
    expect(
      await (await routes.POST(event({ action: 'chatgpt-start' }))).json(),
    ).toEqual({ code: 'connect_ai_unavailable' });
  });
});

describe('Connect AI browser transport', () => {
  it('uses a same-origin, no-store route with cancellation and ignores raw error bodies', async () => {
    const signal = new AbortController().signal;
    const fetch = vi.fn(async () => new Response('{"ok":true}'));
    const client = createConnectAiClient({
      endpoint: '/api/connect-ai',
      fetch: fetch as typeof globalThis.fetch,
    });
    await client.connect('codex', signal);
    expect(fetch).toHaveBeenCalledWith(
      '/api/connect-ai',
      expect.objectContaining({
        signal,
        credentials: 'same-origin',
        cache: 'no-store',
        body: '{"action":"connect","tool":"codex"}',
      }),
    );
    fetch.mockResolvedValue(new Response('sk-secret', { status: 503 }));
    await expect(client.state()).rejects.toThrow('Connect AI request failed.');
    expect(() =>
      createConnectAiClient({ endpoint: 'https://evil.test' }),
    ).toThrow('same-origin');
  });
});

it('only opts existing hosts into selecting an unconfigured API engine and revocation metadata', async () => {
  const { authorize, binding, routes } = setup();
  expect(
    (await routes.POST(event({ action: 'select', engine: 'api' }))).status,
  ).toBe(409);
  expect(binding.select).not.toHaveBeenCalled();
  const compatible = mountConnectAiRoutes({
    authorize,
    allowUnconfiguredApiSelection: true,
    includeSignOutConfirmation: true,
  });
  expect(
    (await compatible.POST(event({ action: 'select', engine: 'api' }))).status,
  ).toBe(200);
  expect(binding.select).toHaveBeenCalledExactlyOnceWith('api');
  expect(
    await (await compatible.POST(event({ action: 'chatgpt-sign-out' }))).json(),
  ).toEqual({ ok: true, remoteRevocationConfirmed: true });
  expect(
    await (await routes.POST(event({ action: 'chatgpt-sign-out' }))).json(),
  ).toEqual({ ok: true });
});
