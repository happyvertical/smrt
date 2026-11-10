// Onboarding and engine choice: owner-only, persisted, state transitions, and
// the assistant status reflecting the chosen engine. The CLIs are fakes on a
// temp PATH (agent-cli/test-support.ts); nothing real is started.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentLogin,
  configureAgentCli,
  invalidateCliStatus,
} from '../lib/server/agent-cli/service.ts';
import {
  fakeDeps,
  installFakeCli,
  tempDir,
} from '../lib/server/agent-cli/test-support.ts';
import { mountAssistantRoutes } from '../lib/server/assistant/routes.ts';
import { mountOnboardingRoutes } from '../lib/server/onboarding.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';

// No API key in the environment, whatever this machine has.
const onboardingRoutes = mountOnboardingRoutes({ config: { env: {} } });

let h: ShellHarness;
beforeAll(async () => {
  h = await openShell();
});
afterAll(async () => {
  configureAgentCli(null);
  await h.close();
});

const ORIGIN = 'http://localhost:5173';
type Who = { id: string; tenantId: string } | null;

function event(who: Who, method: string, path: string, body?: unknown) {
  const url = new URL(path, ORIGIN);
  return {
    request: new Request(url, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url,
    params: {},
    locals: who
      ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] }
      : { user: null, tenantId: null, permissions: [] },
  } as never;
}

async function call(
  who: Who,
  fn: (e: never) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fn(event(who, method, path, body));
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

const get = (who: Who = h.owner, q = '') =>
  call(who, onboardingRoutes.state, 'GET', `/api/shell/onboarding${q}`);
const post = (
  name: 'connect' | 'engine' | 'complete' | 'skip',
  body?: unknown,
  who: Who = h.owner,
) =>
  call(
    who,
    onboardingRoutes[name],
    'POST',
    `/api/shell/onboarding/${name}`,
    body ?? {},
  );

describe('owner only', () => {
  const all: [string, (who: Who) => Promise<{ status: number }>][] = [
    ['state', (w) => get(w)],
    ['connect', (w) => post('connect', { tool: 'codex' }, w)],
    ['engine', (w) => post('engine', { engine: 'api' }, w)],
    ['complete', (w) => post('complete', { start: 'fresh' }, w)],
    ['skip', (w) => post('skip', {}, w)],
  ];
  it.each(all)('%s: nobody is 401, a member is 403', async (_n, run) => {
    expect((await run(null)).status).toBe(401);
    expect((await run(h.member)).status).toBe(403);
    expect((await run(h.stranger)).status).toBe(403);
  });

  it('a refused member changes nothing', async () => {
    await post('skip', {}, h.member);
    expect((await get()).body.onboarding).toBeNull();
  });

  it('writes must come from this origin', async () => {
    const res = await onboardingRoutes.skip({
      ...(event(h.owner, 'POST', '/api/shell/onboarding/skip', {}) as object),
      request: new Request(`${ORIGIN}/api/shell/onboarding/skip`, {
        method: 'POST',
        headers: {
          origin: 'http://evil.example',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    } as never);
    expect(res.status).toBe(403);
  });
});

describe('connecting a local CLI', () => {
  let home: string;
  let bin: string;
  beforeEach(() => {
    home = tempDir();
    bin = tempDir();
    configureAgentCli(fakeDeps(home, [bin]));
  });

  it('lists what is installed and whether it is signed in', async () => {
    installFakeCli(bin, 'claude-code', { version: '3.1.0' });
    const { body } = await get(h.owner, '?fresh=1');
    expect(body.engine).toBe('api');
    const claude = body.tools.find((t: any) => t.tool === 'claude-code');
    const codex = body.tools.find((t: any) => t.tool === 'codex');
    expect(claude).toMatchObject({
      installed: true,
      signedIn: false,
      version: '3.1.0',
      login: 'idle',
    });
    expect(codex).toMatchObject({
      installed: false,
      installUrl: 'https://developers.openai.com/codex/cli',
    });
    // nothing about where it is, nor any account
    expect(JSON.stringify(body)).not.toContain(bin);
  });

  it('points a missing tool at the vendor’s install page and installs nothing', async () => {
    const { body } = await post('connect', { tool: 'codex' });
    expect(body).toEqual({
      result: 'missing',
      installUrl: 'https://developers.openai.com/codex/cli',
    });
  });

  it('signed out: starts the tool’s own sign-in, then selects it once signed in', async () => {
    installFakeCli(bin, 'claude-code');
    const first = await post('connect', { tool: 'claude-code' });
    expect(first.body.result).toBe('login_started');
    await agentLogin().settled('claude-code');
    const state = await get(h.owner, '?fresh=1');
    expect(
      state.body.tools.find((t: any) => t.tool === 'claude-code'),
    ).toMatchObject({
      signedIn: true,
      login: 'finished',
    });
    // not selected until the person connects with a signed-in tool
    expect(state.body.engine).toBe('api');
    const done = await post('connect', { tool: 'claude-code' });
    expect(done.body).toEqual({ result: 'ready', engine: 'claude-code' });
    expect((await get()).body.engine).toBe('claude-code');
  });

  it('already signed in: selects it at once', async () => {
    installFakeCli(bin, 'codex');
    writeFileSync(join(home, 'signed-in'), '');
    const { body } = await post('connect', { tool: 'codex' });
    expect(body).toEqual({ result: 'ready', engine: 'codex' });
    expect((await get()).body.engine).toBe('codex');
  });

  it('rejects an unknown tool', async () => {
    expect((await post('connect', { tool: 'rm -rf' })).status).toBe(400);
  });
});

describe('choosing the engine', () => {
  it('refuses a CLI engine that is not ready, accepts api', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'claude-code');
    configureAgentCli(fakeDeps(home, [bin]));
    expect((await post('engine', { engine: 'claude-code' })).status).toBe(409);
    expect((await post('engine', { engine: 'nope' })).status).toBe(400);
    writeFileSync(join(home, 'signed-in'), '');
    invalidateCliStatus();
    expect((await post('engine', { engine: 'claude-code' })).body.engine).toBe(
      'claude-code',
    );
    expect((await post('engine', { engine: 'api' })).body.engine).toBe('api');
  });
});

describe('the assistant status reflects the engine', () => {
  it('ready, signed out and missing', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'claude-code');
    configureAgentCli(fakeDeps(home, [bin]));
    const routes = mountAssistantRoutes();
    const status = async () =>
      (await (
        await routes.status(event(h.owner, 'GET', '/api/assistant/status'))
      ).json()) as Record<string, any>;

    writeFileSync(join(home, 'signed-in'), '');
    await post('engine', { engine: 'claude-code' });
    expect(await status()).toMatchObject({
      configured: true,
      engine: 'claude-code',
      engineLabel: 'Claude Code',
    });

    // signed out later (cache expires or is dropped)
    const { rmSync } = await import('node:fs');
    rmSync(join(home, 'signed-in'));
    invalidateCliStatus();
    expect(await status()).toMatchObject({
      configured: false,
      code: 'agent_cli_signed_out',
      action: { href: '/welcome' },
    });

    // the turn refuses with the typed 503, never a crash
    const turn = await routes.turn(
      event(h.owner, 'POST', '/api/assistant/turn', { message: 'hi' }),
    );
    expect(turn.status).toBe(503);
    expect(await turn.json()).toMatchObject({
      type: 'unavailable',
      code: 'agent_cli_signed_out',
    });

    // not installed any more
    configureAgentCli(fakeDeps(home, [tempDir()]));
    expect(await status()).toMatchObject({
      configured: false,
      code: 'agent_cli_missing',
    });
    await post('engine', { engine: 'api' });
  });
});

describe('finishing onboarding', () => {
  it('Wizard is coming soon; Fresh needs a ready assistant; Skip always works', async () => {
    const home = tempDir();
    const bin = tempDir();
    installFakeCli(bin, 'codex');
    configureAgentCli(fakeDeps(home, [bin]));
    await post('engine', { engine: 'api' });

    const wizard = await post('complete', { start: 'wizard' });
    expect(wizard.status).toBe(400);
    expect(wizard.body.error).toMatch(/coming soon/i);
    expect((await post('complete', { start: 'other' })).status).toBe(400);

    // api engine with no key: not ready
    expect((await post('complete', { start: 'fresh' })).status).toBe(409);
    expect((await get()).body.onboarding).toBeNull();

    writeFileSync(join(home, 'signed-in'), '');
    await post('connect', { tool: 'codex' });
    expect((await post('complete', { start: 'fresh' })).body.onboarding).toBe(
      'fresh',
    );
    expect((await get()).body).toMatchObject({
      onboarding: 'fresh',
      engine: 'codex',
    });
  });

  it('skip persists too, without touching the engine', async () => {
    configureAgentCli(fakeDeps(tempDir(), [tempDir()]));
    await post('engine', { engine: 'api' });
    expect((await post('skip')).body.onboarding).toBe('skipped');
    expect((await get()).body).toMatchObject({
      onboarding: 'skipped',
      engine: 'api',
    });
  });
});
