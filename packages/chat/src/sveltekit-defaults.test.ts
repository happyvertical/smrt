/**
 * `mountAssistantRoutes` defaults (#3414): `allowedTools` alone offers the
 * manifest tools it names (fail-closed: empty is none, an unprovided name is
 * an error), `db` may be a per-request resolver, and an omitted `ai` comes
 * from the `smrt.config` `ai` block through the shared resolver.
 *
 * Real SQLite (a temp file) for users, tenants, memberships, permissions and
 * chat; the AI boundary (`getAI`) is mocked and scripted.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
} from '@happyvertical/ai';
import { clearRuntimeConfig, setConfig } from '@happyvertical/smrt-config';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantTurnEvent,
  readAssistantTurnStream,
} from './assistant-turn-events.js';
import {
  type AssistantMessageWire,
  type AssistantRoutes,
  type MountAssistantRoutesOptions,
  mountAssistantRoutes,
} from './sveltekit.js';

const getAI = vi.hoisted(() => vi.fn());
vi.mock('@happyvertical/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/ai')>()),
  getAI,
}));

// A dispatchable manifest object, declared in a `.test.ts` so it lands in
// the locally generated test manifest (its CRUD slugs join the catalog).
@smrt({
  api: { include: ['list', 'get', 'create'] },
  collection: 'assistant_route_tasks',
  tableName: 'assistant_route_tasks',
  tenantScoped: { field: 'tenantId', mode: 'optional' },
})
class AssistantRouteTask extends SmrtObject {
  tenantId: string | null = null;

  @field()
  title = '';
}
void AssistantRouteTask;

const ORIGIN = 'http://app.test';
const READ = 'assistant_route_tasks.read';
const CREATE = 'assistant_route_tasks.create';

type Round = (
  messages: AIMessage[],
  options: ChatOptions | undefined,
) => AIResponse;

function scriptedAI(rounds: Round[]): AIInterface & { offered: string[][] } {
  let call = 0;
  const offered: string[][] = [];
  return {
    offered,
    async chat(messages: AIMessage[], options?: ChatOptions) {
      offered.push(
        options?.toolChoice === 'none'
          ? []
          : (options?.tools ?? []).map((tool) => tool.function.name),
      );
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return round(messages, options);
    },
  } as unknown as AIInterface & { offered: string[][] };
}

const text =
  (content: string): Round =>
  () => ({ content, finishReason: 'stop' });

const callTool =
  (name: string): Round =>
  () => ({
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: `call_${name}`,
        type: 'function',
        function: { name, arguments: '{}' },
      },
    ],
  });

interface Actor {
  user: { id: string; profileId: string };
  tenantId: string;
}

const AI_ENV = [
  'SMRT_AI_PROVIDER',
  'SMRT_AI_API_KEY',
  'SMRT_AI_BASE_URL',
  'SMRT_AI_MODEL',
  'HAVE_AI_PROVIDER',
  'HAVE_AI_API_KEY',
  'HAVE_AI_BASE_URL',
  'HAVE_AI_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
];

describe('mountAssistantRoutes defaults (#3414)', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let ownerA: Actor;
  let memberB: Actor;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    for (const key of AI_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    getAI.mockReset();
    dbPath = join(
      tmpdir(),
      `smrt-assistant-defaults-${Date.now()}-${Math.random()}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const options = { db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const tenant = await tenants.create({ name: 'Defaults Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Task Reader' });
    await role.save();
    const permission = await permissions.create({ slug: READ, name: READ });
    await permission.save();
    await rolePermissions.addPermission(
      role.id as string,
      permission.id as string,
    );
    const makeActor = async (email: string, profileId: string) => {
      const user = await users.create({ email, profileId });
      await user.save();
      await (
        await memberships.create({
          userId: user.id,
          tenantId: tenant.id,
          roleId: role.id,
        })
      ).save();
      return {
        user: { id: user.id as string, profileId },
        tenantId: tenant.id as string,
      };
    };
    ownerA = await makeActor('a@example.com', 'profile-a');
    memberB = await makeActor('b@example.com', 'profile-b');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearRuntimeConfig();
    for (const key of AI_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  function mount(
    overrides: Partial<MountAssistantRoutesOptions> = {},
  ): AssistantRoutes {
    return mountAssistantRoutes({
      ai: scriptedAI([text('Hello.')]),
      db,
      audit: () => {},
      onError: () => {},
      ...overrides,
    });
  }

  function call(
    routes: AssistantRoutes,
    method: 'GET' | 'POST',
    path: string,
    actor: Actor,
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(`${ORIGIN}/api/assistant/${path}`);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') headers.origin = ORIGIN;
    const request = new Request(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return routes.handle({
      request,
      url,
      params: { path },
      locals: { user: actor.user, tenantId: actor.tenantId },
    });
  }

  async function createThread(routes: AssistantRoutes, actor: Actor) {
    const response = await call(routes, 'POST', 'threads', actor, {
      title: 'Tasks',
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { thread: { id: string } }).thread.id;
  }

  const send = (
    routes: AssistantRoutes,
    threadId: string,
    actor: Actor,
    clientRequestId: string,
  ) =>
    call(routes, 'POST', `threads/${threadId}/messages`, actor, {
      content: 'show my tasks',
      clientRequestId,
    });

  async function events(response: Response) {
    const seen: AssistantTurnEvent<AssistantMessageWire>[] = [];
    await readAssistantTurnStream<AssistantMessageWire>(response, (event) => {
      seen.push(event);
    });
    return seen;
  }

  async function storedMessages(
    routes: AssistantRoutes,
    threadId: string,
    actor: Actor,
  ) {
    const response = await call(
      routes,
      'GET',
      `threads/${threadId}/messages`,
      actor,
    );
    return ((await response.json()) as { items: AssistantMessageWire[] }).items;
  }

  // ---- allowedTools alone ---------------------------------------------------

  describe('allowedTools without tools', () => {
    it('offers and runs exactly the manifest tools it names', async () => {
      const ai = scriptedAI([
        callTool('assistant_route_tasks-read'),
        text('No tasks yet.'),
      ]);
      const routes = mount({ ai, allowedTools: [READ] });
      const threadId = await createThread(routes, ownerA);
      const seen = await events(await send(routes, threadId, ownerA, 'r1'));
      expect(ai.offered[0]).toEqual(['assistant_route_tasks-read']);
      expect(
        seen.some(
          (e) =>
            e.type === 'step' && e.step.kind === 'tool_result' && e.step.ok,
        ),
      ).toBe(true);
    });

    it('offers no tools when allowedTools is absent or empty', async () => {
      for (const allowedTools of [undefined, []]) {
        const ai = scriptedAI([text('ok')]);
        const routes = mount({
          ai,
          ...(allowedTools ? { allowedTools } : {}),
        });
        const threadId = await createThread(routes, ownerA);
        await events(await send(routes, threadId, ownerA, 'n1'));
        expect(ai.offered[0]).toEqual([]);
      }
    });

    it('builds the catalog from a per-request allow-list', async () => {
      const ai = scriptedAI([text('ok')]);
      const routes = mount({
        ai,
        allowedTools: ({ principal }) =>
          principal.profileId === ownerA.user.profileId ? [READ] : [],
      });
      const threadA = await createThread(routes, ownerA);
      await events(await send(routes, threadA, ownerA, 'a1'));
      const threadB = await createThread(routes, memberB);
      await events(await send(routes, threadB, memberB, 'b1'));
      expect(ai.offered).toEqual([['assistant_route_tasks-read'], []]);
    });

    it('keeps an explicit tools value (even []) instead of building one', async () => {
      const ai = scriptedAI([text('ok')]);
      const routes = mount({ ai, allowedTools: [READ, CREATE], tools: [] });
      const threadId = await createThread(routes, ownerA);
      await events(await send(routes, threadId, ownerA, 'e1'));
      expect(ai.offered[0]).toEqual([]);
    });

    it('refuses at mount a name its registered collection does not have', () => {
      expect(() =>
        mount({ allowedTools: [READ, 'assistant_route_tasks.reed'] }),
      ).toThrow(/assistant_route_tasks\.reed/);
    });

    it('refuses the turn, before storing it, for a name nothing provides', async () => {
      const errors: unknown[] = [];
      const ai = scriptedAI([text('should not run')]);
      // An unregistered collection is not provably wrong at import time
      // (SvelteKit analyses routes before hooks load the registry).
      const routes = mount({
        ai,
        allowedTools: [READ, 'ghosts.read'],
        onError: (error) => errors.push(error),
      });
      const threadId = await createThread(routes, ownerA);
      const response = await send(routes, threadId, ownerA, 'g1');
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'assistant_unavailable',
      });
      expect(ai.offered).toEqual([]);
      expect(String(errors[0])).toMatch(/ghosts\.read/);
      expect(await storedMessages(routes, threadId, ownerA)).toEqual([]);
    });
  });

  // ---- per-request db ----------------------------------------------------

  describe('db resolver', () => {
    it('is called once per request with that request', async () => {
      const resolver = vi.fn(
        (_context: { principal: { profileId: string } }) => db,
      );
      const routes = mount({ db: resolver });
      const threadId = await createThread(routes, ownerA);
      expect((await call(routes, 'GET', 'threads', memberB)).status).toBe(200);
      expect(resolver).toHaveBeenCalledTimes(2);
      await events(await send(routes, threadId, ownerA, 'd1'));
      expect(resolver).toHaveBeenCalledTimes(3);
      expect(
        resolver.mock.calls.map(([context]) => context.principal.profileId),
      ).toEqual(['profile-a', 'profile-b', 'profile-a']);
    });

    it('answers 500 without writing when the resolver fails', async () => {
      const errors: unknown[] = [];
      const routes = mount({
        db: () => {
          throw new Error('no request database');
        },
        onError: (error) => errors.push(error),
      });
      const response = await call(routes, 'POST', 'threads', ownerA, {
        title: 'x',
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: 'internal_error' });
      expect(String(errors[0])).toMatch(/no request database/);
      const fixed = mount();
      const list = await call(fixed, 'GET', 'threads', ownerA);
      expect(await list.json()).toEqual({ items: [] });
    });

    it('defaults to runtime.databaseConfig() and streams outside RLS unchanged', async () => {
      const runtime = {
        databaseConfig: vi.fn(() => db),
        runAsPrincipal: vi.fn(async <T>(_p: unknown, fn: () => Promise<T>) =>
          fn(),
        ),
      };
      const ai = scriptedAI([text('Streamed.')]);
      // No `db`: the runtime's request database is used.
      const routes = mount({ ai, db: undefined, runtime });
      const threadId = await createThread(routes, ownerA);
      expect(runtime.databaseConfig).toHaveBeenCalledTimes(1);
      const seen = await events(await send(routes, threadId, ownerA, 'rt1'));
      expect(seen.find((e) => e.type === 'done')).toMatchObject({
        message: { content: 'Streamed.' },
      });
      expect(runtime.databaseConfig).toHaveBeenCalledTimes(2);
      // SQLite has no request transaction: the turn needs no own lifetime.
      expect(runtime.runAsPrincipal).not.toHaveBeenCalled();
      expect(
        (await storedMessages(routes, threadId, ownerA)).map((m) => m.role),
      ).toEqual(['user', 'assistant']);
    });
  });

  // ---- ai from smrt.config -------------------------------------------------

  describe('ai default', () => {
    it('builds the client from the smrt.config ai block', async () => {
      setConfig({
        ai: {
          provider: 'openai',
          model: 'gpt-test',
          apiKeyEnv: 'OPENAI_API_KEY',
        },
      });
      process.env.OPENAI_API_KEY = 'k-config-test';
      const ai = scriptedAI([text('From config.')]);
      getAI.mockResolvedValue(ai);
      const routes = mountAssistantRoutes({ db, audit: () => {} });
      const threadId = await createThread(routes, ownerA);
      const seen = await events(await send(routes, threadId, ownerA, 'c1'));
      expect(getAI).toHaveBeenCalledWith({
        type: 'openai',
        provider: 'openai',
        apiKey: 'k-config-test',
        defaultModel: 'gpt-test',
      });
      const done = seen.find((e) => e.type === 'done');
      expect(done).toMatchObject({
        message: expect.objectContaining({ content: 'From config.' }),
      });
    });

    it('answers 503 with the clear, secret-free error when nothing is configured', async () => {
      const secret = 'sk-unbound-secret-value';
      // A key with no provider and no detectable provider key: unconfigured.
      process.env.SMRT_AI_API_KEY = secret;
      const errors: unknown[] = [];
      const routes = mountAssistantRoutes({
        db,
        onError: (error) => errors.push(error),
      });
      const threadId = await createThread(routes, ownerA);
      const response = await send(routes, threadId, ownerA, 'u1');
      expect(response.status).toBe(503);
      const raw = await response.text();
      expect(JSON.parse(raw)).toMatchObject({ code: 'assistant_unavailable' });
      expect(raw).not.toContain(secret);
      expect(getAI).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      const error = errors[0] as Error;
      expect(error.name).toBe('AIProviderNotConfiguredError');
      expect(error.message).toMatch(/smrt\.config\.ts/);
      expect(error.message).not.toContain(secret);
      expect(await storedMessages(routes, threadId, ownerA)).toEqual([]);
    });

    it('treats an explicitly empty ai as a mount error, not a fallback', () => {
      expect(() =>
        mountAssistantRoutes({ ai: null as unknown as AIInterface }),
      ).toThrow(/omit `ai`/);
    });
  });
});
