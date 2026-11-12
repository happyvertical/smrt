// Sign in with ChatGPT through the onboarding routes: owner only, the page it
// opens, the engine it selects, sign-out, and no token anywhere. The connection
// is a fake (no network, no real sign-in).
import type { ChatGPTPlanConnection } from '@happyvertical/smrt-inference/server';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { mountAssistantRoutes } from '../lib/server/assistant/routes.ts';
import { setChatGPTConnection } from '../lib/server/chatgpt.ts';
import { mountOnboardingRoutes } from '../lib/server/onboarding.ts';
import { openShell, type ShellHarness } from '../lib/server/test-support.ts';

const SECRET = 'SECRET-ACCESS-TOKEN-do-not-leak';
const AUTH_URL = 'https://auth.openai.com/api/accounts/authorize?state=s';
const opened: string[] = [];
let openResult = true;
const routes = mountOnboardingRoutes({
  config: { env: {} },
  openBrowser: async (url) => {
    opened.push(url);
    return openResult;
  },
});

let h: ShellHarness;
let signedIn = false;
let signingIn = false;
let started = 0;
let signedOut = 0;
let modelChoices: string[] = ['gpt-x', 'gpt-y'];

const connection: ChatGPTPlanConnection = {
  start: async () => {
    started += 1;
    signingIn = true;
    return { authorizationUrl: AUTH_URL };
  },
  status: async () => ({
    signedIn,
    signingIn,
    ...(signedIn ? { account: { label: 'owner@example.com' } } : {}),
  }),
  cancel: vi.fn(async () => undefined),
  signOut: async () => {
    signedOut += 1;
    signedIn = false;
    return { remoteRevocationConfirmed: true };
  },
  models: async () => modelChoices.map((id) => ({ id, label: id })),
  defaultModel: async () => modelChoices[0],
  clientOptions: async () => ({ type: 'chatgpt-plan', token: SECRET }),
};

beforeAll(async () => {
  h = await openShell();
  setChatGPTConnection(connection);
});
afterAll(async () => {
  setChatGPTConnection(undefined);
  delete process.env.SMRT_DESKTOP_OWNER_LINK_SECRET;
  await h.close();
});
beforeEach(async () => {
  signedIn = false;
  signingIn = false;
  started = 0;
  signedOut = 0;
  opened.length = 0;
  openResult = true;
  modelChoices = ['gpt-x', 'gpt-y'];
  delete process.env.SMRT_DESKTOP_OWNER_LINK_SECRET;
  await post('engine', { engine: 'api' });
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
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as any };
}

const state = (who: Who = h.owner) =>
  call(who, routes.state, 'GET', '/api/shell/onboarding');
const chatgpt = (body: unknown, who: Who = h.owner) =>
  call(who, routes.chatgpt, 'POST', '/api/shell/onboarding/chatgpt', body);
const chatgptState = (who: Who = h.owner) =>
  call(who, routes.chatgptState, 'GET', '/api/shell/onboarding/chatgpt');
const post = (name: 'engine' | 'complete', body: unknown, who: Who = h.owner) =>
  call(who, routes[name], 'POST', `/api/shell/onboarding/${name}`, body);

describe('owner only', () => {
  it('a member and a stranger get nothing and start nothing', async () => {
    expect((await chatgpt({ action: 'start' }, h.member)).status).toBe(403);
    expect((await chatgpt({ action: 'start' }, null)).status).toBe(401);
    expect((await chatgptState(h.member)).status).toBe(403);
    expect(started).toBe(0);
  });
});

describe('signing in', () => {
  it('a plain browser session gets the address for a normal link', async () => {
    const out = await chatgpt({ action: 'start' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({
      result: 'login_started',
      opened: false,
      authorizationUrl: AUTH_URL,
    });
    expect((await state()).body.chatgpt).toMatchObject({
      signedIn: false,
      signingIn: true,
    });
  });

  it('forwards pending sign-in cancellation through the shared owner route', async () => {
    await chatgpt({ action: 'start' });
    const out = await chatgpt({ action: 'cancel' });
    expect(out.status).toBe(200);
    expect(connection.cancel).toHaveBeenCalledTimes(1);
  });
  it('shows signed in once the sign-in finishes, and selects the engine', async () => {
    await chatgpt({ action: 'start' });
    signedIn = true;
    signingIn = false;
    const before = (await state()).body;
    expect(before.chatgpt).toMatchObject({
      signedIn: true,
      account: { label: 'owner@example.com' },
    });
    expect(before.engine).toBe('api');
    expect((await post('engine', { engine: 'chatgpt' })).body).toEqual({
      engine: 'chatgpt',
    });
    expect((await state()).body.engine).toBe('chatgpt');
    // "Fresh" now finishes onboarding on the ChatGPT engine.
    expect((await post('complete', { start: 'fresh' })).status).toBe(200);
  });

  it('refuses to select the engine while signed out', async () => {
    const out = await post('engine', { engine: 'chatgpt' });
    expect(out.status).toBe(409);
    expect(out.body.error).toMatch(/sign in with chatgpt/i);
    expect((await state()).body.engine).toBe('api');
    expect((await post('complete', { start: 'fresh' })).status).toBe(409);
  });

  it('the dock status follows the engine', async () => {
    const assistant = mountAssistantRoutes({ env: {} });
    const status = async () =>
      (
        await call(
          h.owner,
          assistant.status as never,
          'GET',
          '/api/assistant/status',
        )
      ).body;
    signedIn = true;
    await post('engine', { engine: 'chatgpt' });
    expect(await status()).toMatchObject({
      configured: true,
      engine: 'chatgpt',
      engineLabel: 'ChatGPT',
    });
    signedIn = false;
    expect(await status()).toMatchObject({
      configured: false,
      code: 'chatgpt_signed_out',
      action: { label: 'Sign in with ChatGPT' },
    });
  });
});

describe('under the desktop wrapper', () => {
  it('the app opens the system browser and returns no address', async () => {
    process.env.SMRT_DESKTOP_OWNER_LINK_SECRET = 'x'.repeat(40);
    const out = await chatgpt({ action: 'start' });
    expect(out.body).toEqual({ result: 'login_started', opened: true });
    expect(opened).toEqual([AUTH_URL]);
  });

  it('when the opener cannot start, the page gets the address instead', async () => {
    process.env.SMRT_DESKTOP_OWNER_LINK_SECRET = 'x'.repeat(40);
    openResult = false;
    const out = await chatgpt({ action: 'start' });
    expect(out.body).toEqual({
      result: 'login_started',
      opened: false,
      authorizationUrl: AUTH_URL,
    });
  });

  it('a plain browser session never has the app open anything', async () => {
    await chatgpt({ action: 'start' });
    expect(opened).toEqual([]);
  });
});

describe('sign out and the model', () => {
  it('signing out clears the sign-in and the engine that used it', async () => {
    signedIn = true;
    await post('engine', { engine: 'chatgpt' });
    const out = await chatgpt({ action: 'sign-out' });
    expect(out.body).toEqual({
      result: 'signed_out',
      remoteRevocationConfirmed: true,
    });
    expect(signedOut).toBe(1);
    const after = (await state()).body;
    expect(after.chatgpt.signedIn).toBe(false);
    expect(after.engine).toBe('api');
  });

  it('lists the account’s models and saves a known choice only', async () => {
    signedIn = true;
    const listed = (await chatgptState()).body;
    expect(listed.models).toEqual([
      { id: 'gpt-x', label: 'gpt-x' },
      { id: 'gpt-y', label: 'gpt-y' },
    ]);
    expect(listed.model).toBeNull();
    expect((await chatgpt({ action: 'model', model: 'gpt-y' })).body).toEqual({
      model: 'gpt-y',
    });
    expect((await chatgptState()).body.model).toBe('gpt-y');
    expect((await chatgpt({ action: 'model', model: 'nope' })).status).toBe(
      400,
    );
    expect((await chatgpt({ action: 'model', model: 'a b' })).status).toBe(400);
    expect((await chatgpt({ action: 'model', model: '' })).body).toEqual({
      model: null,
    });
    expect((await chatgptState()).body.model).toBeNull();
  });

  it('rejects an unknown action', async () => {
    expect((await chatgpt({ action: 'nope' })).status).toBe(400);
  });
});

describe('no token anywhere', () => {
  it('no response carries one', async () => {
    signedIn = true;
    const all = [
      await state(),
      await chatgptState(),
      await chatgpt({ action: 'start' }),
      await chatgpt({ action: 'sign-out' }),
    ];
    for (const r of all) expect(r.text).not.toContain(SECRET);
  });
});
