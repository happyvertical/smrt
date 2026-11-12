// "Sign in with ChatGPT": the connection service against a fake session
// manager (no network, no real sign-in) and the opt-in resolver.
import type {
  InferenceRequest,
  InferenceResolver,
  InferenceResolverContext,
} from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_SIGN_IN_WINDOW_MS,
  type ChatGPTSessionStore,
  ChatGPTSignedOutError,
  classifyChatGPTPlanFailure,
  createChatGPTPlanConnection,
  createChatGPTPlanResolver,
  isChatGPTAuthorizationUrl,
} from '../server.js';

const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SECRET = 'SECRET-ACCESS-TOKEN-do-not-leak';
const AUTH_URL =
  'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=s';

interface StoredSession {
  clientId: string;
  subject: string;
  email?: string;
  scopes: string[];
  expiresAt: number;
  accessToken: string;
  refreshToken: string;
}

/** A fake `LocalChatGPTSessionManager`: tokens live only in this closure. */
function fakeManager(initial: StoredSession[] = []) {
  const stored = [...initial];
  let finish: (() => void) | undefined;
  let fail: ((e: unknown) => void) | undefined;
  let url = AUTH_URL;
  const manager: ChatGPTSessionStore = {
    // Mirrors the SDK: `sessions()` strips every token.
    async sessions() {
      return stored.map(
        ({ accessToken: _a, refreshToken: _r, ...safe }) => safe,
      );
    },
    async begin() {
      const callback = new Promise<{ clientId: string }>((resolve, reject) => {
        finish = () => {
          const session: StoredSession = {
            clientId: 'client-new',
            subject: 'sub-1',
            email: 'owner@example.com',
            scopes: [PLAN_SCOPE],
            expiresAt: Date.now() + 3_600_000,
            accessToken: SECRET,
            refreshToken: 'SECRET-REFRESH',
          };
          stored.push(session);
          resolve(session);
        };
        fail = reject;
      });
      return { authorizationUrl: url, callback };
    },
    async accessToken(clientId) {
      if (!stored.some((s) => s.clientId === clientId))
        throw Object.assign(new Error('unknown'), { code: 'unknown_account' });
      return SECRET;
    },
    logout: vi.fn(async (clientId: string) => {
      const at = stored.findIndex((s) => s.clientId === clientId);
      if (at >= 0) stored.splice(at, 1);
      return { remoteRevocationConfirmed: true };
    }),
  };
  return {
    manager,
    stored,
    finish: () => finish?.(),
    fail: (e: unknown) => fail?.(e),
    setUrl: (next: string) => {
      url = next;
    },
  };
}

const connect = (fake: ReturnType<typeof fakeManager>, extra = {}) =>
  createChatGPTPlanConnection({
    appName: 'Test',
    credentialsPath: '/private/test/chatgpt.json',
    manager: fake.manager,
    ...extra,
  });

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the ChatGPT plan connection', () => {
  it('starts, reports and finishes a sign-in without ever exposing a token', async () => {
    const fake = fakeManager();
    const connection = connect(fake);
    expect(await connection.status()).toEqual({
      signedIn: false,
      signingIn: false,
    });

    const started = await connection.start();
    expect(started).toEqual({ authorizationUrl: AUTH_URL });
    expect(await connection.status()).toMatchObject({
      signedIn: false,
      signingIn: true,
    });
    // A second start while one is open hands back the same page.
    expect(await connection.start()).toEqual(started);

    fake.finish();
    await settle();
    const status = await connection.status();
    expect(status).toEqual({
      signedIn: true,
      signingIn: false,
      account: { label: 'owner@example.com' },
    });
    const everything = JSON.stringify([started, status]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain('REFRESH');
  });

  it('refuses an authorization URL that is not on OpenAI', async () => {
    const fake = fakeManager();
    fake.setUrl('https://evil.example.com/api/accounts/authorize');
    await expect(connect(fake).start()).rejects.toThrow(/not on OpenAI/);
    expect(isChatGPTAuthorizationUrl(AUTH_URL)).toBe(true);
    for (const bad of [
      'http://auth.openai.com/x',
      'https://auth.openai.com.evil.example/x',
      'https://user:pw@auth.openai.com/x',
      'https://auth.openai.com:8443/x',
      'https://auth.openai.com/x#frag',
      'javascript:alert(1)',
      'not a url',
      undefined,
    ])
      expect(isChatGPTAuthorizationUrl(bad)).toBe(false);
  });

  it('reports a declined sign-in once, then clears it on the next start', async () => {
    const fake = fakeManager();
    const connection = connect(fake);
    await connection.start();
    fake.fail(Object.assign(new Error('x'), { code: 'consent_declined' }));
    await settle();
    expect(await connection.status()).toMatchObject({
      signedIn: false,
      signingIn: false,
      error: { code: 'declined' },
    });
    await connection.start();
    expect((await connection.status()).error).toBeUndefined();
  });

  it('times out a sign-in nobody finished', async () => {
    const fake = fakeManager();
    let now = 1_000;
    const connection = connect(fake, { now: () => now });
    await connection.start();
    now += CHATGPT_SIGN_IN_WINDOW_MS + 1;
    expect(await connection.status()).toMatchObject({
      signingIn: false,
      error: { code: 'timed_out' },
    });
  });

  it('signs out: the local credentials go and so does the signed-in state', async () => {
    const fake = fakeManager();
    const connection = connect(fake);
    await connection.start();
    fake.finish();
    await settle();
    expect(await connection.signOut()).toEqual({
      remoteRevocationConfirmed: true,
    });
    expect((await connection.status()).signedIn).toBe(false);
    expect(fake.stored).toHaveLength(0);
  });

  it('keeps one registration per account', async () => {
    const fake = fakeManager([
      {
        clientId: 'client-old',
        subject: 'sub-1',
        email: 'owner@example.com',
        scopes: [PLAN_SCOPE],
        expiresAt: 1,
        accessToken: 'a',
        refreshToken: 'b',
      },
    ]);
    const connection = connect(fake);
    await connection.start();
    fake.finish();
    await settle();
    await settle();
    expect(fake.stored.map((s) => s.clientId)).toEqual(['client-new']);
  });

  it('ignores a stored session without the plan scope', async () => {
    const fake = fakeManager([
      {
        clientId: 'c',
        subject: 's',
        scopes: ['openid'],
        expiresAt: 1,
        accessToken: 'a',
        refreshToken: 'b',
      },
    ]);
    expect((await connect(fake).status()).signedIn).toBe(false);
  });

  it('ranks the signed-in catalog for automatic defaults and invalidates it after sign-out', async () => {
    const fake = fakeManager();
    const getModels = vi.fn(async () => [
      { id: 'gpt-6-luna' },
      { id: 'gpt-99-unknown' },
      { id: 'gpt-6-astra' },
      { id: 'gpt-6.1-sol' },
    ]);
    const connection = connect(fake, {
      createClient: async () => ({ getModels }),
    });
    await connection.start();
    fake.finish();
    await settle();
    expect(await connection.defaultModel()).toBe('gpt-6-astra');
    expect(
      (await connection.models()).find((model) => model.id === 'gpt-99-unknown')
        ?.intelligenceRank,
    ).toBeUndefined();
    expect(getModels).toHaveBeenCalledOnce();
    await connection.signOut();
    await expect(connection.models()).rejects.toBeInstanceOf(
      ChatGPTSignedOutError,
    );
    await connection.start();
    fake.finish();
    await settle();
    await connection.models();
    expect(getModels).toHaveBeenCalledTimes(2);
  });
  it('lists models and builds provider options that hold a token handle only', async () => {
    const fake = fakeManager();
    const connection = connect(fake, {
      createClient: async (options: Record<string, unknown>) => {
        expect(options.type).toBe('chatgpt-plan');
        return {
          getModels: async () => [
            { id: 'gpt-x', name: 'GPT X', intelligenceRank: 2 },
            { id: 'gpt-y' },
          ],
        };
      },
    });
    await expect(connection.models()).rejects.toBeInstanceOf(
      ChatGPTSignedOutError,
    );
    await connection.start();
    fake.finish();
    await settle();
    expect(await connection.models()).toEqual([
      { id: 'gpt-x', label: 'GPT X', intelligenceRank: 2 },
      { id: 'gpt-y', label: 'gpt-y' },
    ]);
    expect(await connection.defaultModel()).toBe('gpt-x');

    const options = await connection.clientOptions({
      model: 'gpt-y',
      toolNamespace: { name: 'shell_tools', description: 'd' },
    });
    expect(options).toMatchObject({
      type: 'chatgpt-plan',
      clientId: 'client-new',
      defaultModel: 'gpt-y',
      toolNamespace: { name: 'shell_tools' },
    });
    // The provider can ask for a token, and nothing else (no logout).
    const handle = options.sessionManager as Record<string, unknown>;
    expect(Object.keys(handle)).toEqual(['accessToken']);
    expect(
      await (handle.accessToken as (id: string) => Promise<string>)(
        'client-new',
      ),
    ).toBe(SECRET);
    expect(JSON.stringify(Object.keys(options))).not.toContain('Token');
  });
});

const request = (className: string): InferenceRequest =>
  ({ tier: 'good', className }) as InferenceRequest;
const context = {} as InferenceResolverContext;

function stubConnection(signedIn: boolean, model = 'gpt-x') {
  return {
    status: async () => ({ signedIn, signingIn: false }),
    defaultModel: async () => model,
  };
}

describe('the ChatGPT plan resolver', () => {
  const fallback: InferenceResolver = {
    resolve: vi.fn(async () => ({
      tierResolved: 'good' as const,
      target: { provider: 'anthropic', source: 'byo' as const },
      via: 'resolver' as const,
    })),
  };
  const appliesTo = (r: InferenceRequest) => r.className === 'Chosen';

  it('yields a chatgpt-plan target only for a call that asked, when signed in', async () => {
    const resolver = createChatGPTPlanResolver({
      connection: stubConnection(true),
      appliesTo,
      fallback,
    });
    const asked = await resolver.resolve(request('Chosen'), context);
    expect(asked?.target).toEqual({
      provider: 'chatgpt-plan',
      model: 'gpt-x',
      source: 'byo',
    });
    // Nobody else is moved onto the plan, and nothing is billed to it.
    const other = await resolver.resolve(request('Other'), context);
    expect(other?.target.provider).toBe('anthropic');
  });

  it('uses the owner’s model when one is chosen', async () => {
    const resolver = createChatGPTPlanResolver({
      connection: stubConnection(true),
      appliesTo,
      model: () => 'gpt-chosen',
    });
    expect(
      (await resolver.resolve(request('Chosen'), context))?.target.model,
    ).toBe('gpt-chosen');
  });

  it('never falls back to another provider when the call asked and nobody is signed in', async () => {
    const resolver = createChatGPTPlanResolver({
      connection: stubConnection(false),
      appliesTo,
      fallback,
    });
    const out = await resolver.resolve(request('Chosen'), context);
    expect(out).toMatchObject({ unavailable: 'unconfigured', target: {} });
    expect(fallback.resolve).not.toHaveBeenCalledWith(
      expect.objectContaining({ className: 'Chosen' }),
      context,
    );
  });
});

describe('classifyChatGPTPlanFailure', () => {
  const named = (name: string, code?: string) =>
    Object.assign(new Error('x'), { name, code });
  it('reads the SDK class and code, never the message', () => {
    expect(
      classifyChatGPTPlanFailure(named('ChatGPTPlanUsageLimitError')),
    ).toBe('usage_limit');
    expect(
      classifyChatGPTPlanFailure(named('ChatGPTPlanSessionRevokedError')),
    ).toBe('session_revoked');
    expect(classifyChatGPTPlanFailure(named('ChatGPTPlanWorkspaceError'))).toBe(
      'workspace',
    );
    expect(
      classifyChatGPTPlanFailure(named('ChatGPTPlanUsageUnavailableError')),
    ).toBe('unavailable');
    expect(
      classifyChatGPTPlanFailure(
        named(
          'ChatGPTPlanError',
          'subscription_sharing_unsupported_capability',
        ),
      ),
    ).toBe('unsupported_capability');
    expect(classifyChatGPTPlanFailure(new Error('usage limit'))).toBe('other');
    expect(classifyChatGPTPlanFailure(undefined)).toBe('other');
  });
});
