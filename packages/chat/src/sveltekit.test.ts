/**
 * Mountable AssistantDock routes (#3368).
 *
 * Real SQLite (a temp file) for users, tenants, memberships and chat; only the
 * AI boundary is scripted. The matrix: actor × thread ownership × active
 * tenant (allow and deny), unauthenticated and incomplete principals, a
 * principal with no tools, malformed/oversized input, upstream AI failure,
 * stale and foreign continuations, attachments, actions, origin, routing, and
 * the browser transport talking to these handlers unchanged.
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
import type { PrincipalRun, PrincipalTool } from '@happyvertical/smrt-agents';
import {
  MembershipCollection,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantTurnEvent,
  readAssistantTurnStream,
} from './assistant-turn-events.js';
import {
  ChatClientRequestConflictError,
  ChatService,
  clientRequestMessageId,
} from './services/index.js';
import { createAssistantHttpTransport } from './svelte/components/assistant/assistant-http-client.js';
import {
  type AssistantMessageWire,
  type AssistantRouteEvent,
  type AssistantRoutes,
  type MountAssistantRoutesOptions,
  mountAssistantRoutes,
} from './sveltekit.js';

const ORIGIN = 'http://app.test';

type Round = (
  messages: AIMessage[],
  options: ChatOptions | undefined,
) => AIResponse;

function scriptedAI(rounds: Round[]): AIInterface & {
  seen: AIMessage[][];
  offered: string[][];
  models: unknown[];
} {
  let call = 0;
  const seen: AIMessage[][] = [];
  const offered: string[][] = [];
  const models: unknown[] = [];
  return {
    seen,
    offered,
    models,
    async chat(messages: AIMessage[], options?: ChatOptions) {
      seen.push([...messages]);
      models.push(options?.model);
      offered.push(
        options?.toolChoice === 'none'
          ? []
          : (options?.tools ?? []).map((tool) => tool.function.name),
      );
      const round = rounds[Math.min(call, rounds.length - 1)];
      call += 1;
      return round(messages, options);
    },
  } as unknown as AIInterface & {
    seen: AIMessage[][];
    offered: string[][];
    models: unknown[];
  };
}

function text(content: string): Round {
  return (_messages, options) => {
    options?.onProgress?.(content);
    return { content, finishReason: 'stop' };
  };
}

function calls(
  ...entries: Array<[name: string, args: Record<string, unknown>, id?: string]>
): Round {
  return () => ({
    content: '',
    finishReason: 'tool_calls',
    toolCalls: entries.map(([name, args, id], index) => ({
      id: id ?? `call_${name}_${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    })),
  });
}

function discoverTool(ran: PrincipalRun[]): PrincipalTool {
  return {
    slug: 'data.discover',
    aiTool: {
      type: 'function',
      function: {
        name: 'data-discover',
        description: 'Discover data.',
        parameters: { type: 'object', properties: {} },
      },
    },
    async execute({ run }) {
      run.assertToolAllowed('data.discover');
      ran.push(run);
      return { surfaces: ['articles'] };
    },
  };
}

interface Actor {
  user: { id: string; profileId: string };
  tenantId: string;
}

const locals = (actor: Actor | null) =>
  actor ? { user: actor.user, tenantId: actor.tenantId } : { user: null };

async function events(response: Response) {
  const seen: AssistantTurnEvent<AssistantMessageWire>[] = [];
  let thrown: unknown = null;
  try {
    await readAssistantTurnStream<AssistantMessageWire>(response, (event) => {
      seen.push(event);
    });
  } catch (error) {
    thrown = error;
  }
  return { seen, thrown };
}

describe('mountAssistantRoutes', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let tenantId: string;
  let otherTenantId: string;
  let ownerA: Actor;
  let memberB: Actor;
  let ownerAElsewhere: Actor;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-assistant-routes-${Date.now()}-${Math.random()}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    const options = { db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const tenant = await tenants.create({ name: 'Routes Org' });
    await tenant.save();
    const other = await tenants.create({ name: 'Other Org' });
    await other.save();
    const role = await roles.create({ name: 'Member' });
    await role.save();
    const makeUser = async (email: string, profileId: string) => {
      const user = await users.create({ email, profileId });
      await user.save();
      return { id: user.id as string, profileId };
    };
    const a = await makeUser('a@example.com', 'profile-a');
    const b = await makeUser('b@example.com', 'profile-b');
    for (const [userId, tId] of [
      [a.id, tenant.id],
      [b.id, tenant.id],
      [a.id, other.id],
    ] as const) {
      await (
        await memberships.create({
          userId,
          tenantId: tId as string,
          roleId: role.id,
        })
      ).save();
    }
    tenantId = tenant.id as string;
    otherTenantId = other.id as string;
    ownerA = { user: a, tenantId };
    memberB = { user: b, tenantId };
    ownerAElsewhere = { user: a, tenantId: otherTenantId };
  });

  afterEach(() => {
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
      ai: scriptedAI([text('Hello there.')]),
      db,
      audit: () => {},
      onError: () => {},
      ...overrides,
    });
  }

  function call(
    routes: AssistantRoutes,
    method: string,
    path: string,
    init: {
      actor?: Actor | null;
      locals?: unknown;
      body?: unknown;
      rawBody?: BodyInit;
      headers?: Record<string, string>;
      origin?: string | null;
    } = {},
  ): Promise<Response> {
    const url = new URL(`${ORIGIN}/api/assistant/${path}`);
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (method !== 'GET' && origin) headers.origin = origin;
    Object.assign(headers, init.headers);
    const request = new Request(url, {
      method,
      headers,
      ...(init.rawBody !== undefined
        ? { body: init.rawBody }
        : init.body !== undefined
          ? { body: JSON.stringify(init.body) }
          : {}),
    });
    const event: AssistantRouteEvent = {
      request,
      url,
      params: { path },
      locals:
        init.locals !== undefined
          ? init.locals
          : locals(init.actor === undefined ? ownerA : init.actor),
    };
    return method === 'GET' ? routes.GET(event) : routes.POST(event);
  }

  async function createThread(
    routes: AssistantRoutes,
    actor: Actor = ownerA,
    title = 'Plans',
  ): Promise<string> {
    const response = await call(routes, 'POST', 'threads', {
      actor,
      body: { title },
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { thread: { id: string } };
    return body.thread.id;
  }

  async function listMessages(
    routes: AssistantRoutes,
    threadId: string,
    actor: Actor = ownerA,
  ): Promise<AssistantMessageWire[]> {
    const response = await call(routes, 'GET', `threads/${threadId}/messages`, {
      actor,
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { items: AssistantMessageWire[] }).items;
  }

  const send = (
    routes: AssistantRoutes,
    threadId: string,
    body: Record<string, unknown>,
    actor: Actor = ownerA,
  ) => call(routes, 'POST', `threads/${threadId}/messages`, { actor, body });

  // ---- 1. principal -----------------------------------------------------

  describe('principal', () => {
    it('refuses an unauthenticated caller on every route', async () => {
      const routes = mount();
      for (const [method, path, body] of [
        ['GET', 'threads', undefined],
        ['POST', 'threads', { title: 'x' }],
        ['GET', 'threads/t1/messages', undefined],
        ['POST', 'threads/t1/messages', { content: 'x', clientRequestId: 'r' }],
        ['POST', 'threads/t1/resume', { continuationId: 'c', results: [] }],
        ['POST', 'actions/preview', { phase: 'preview' }],
      ] as const) {
        const response = await call(routes, method, path, {
          actor: null,
          body,
        });
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(await response.json()).toMatchObject({
          code: 'unauthenticated',
        });
      }
    });

    it('refuses a user without a profile or without an active tenant', async () => {
      const routes = mount();
      const noProfile = await call(routes, 'GET', 'threads', {
        locals: { user: { id: ownerA.user.id }, tenantId },
      });
      expect(noProfile.status).toBe(403);
      expect(await noProfile.json()).toMatchObject({
        code: 'profile_required',
      });
      const noTenant = await call(routes, 'GET', 'threads', {
        locals: { user: ownerA.user, tenantId: null },
      });
      expect(noTenant.status).toBe(403);
      expect(await noTenant.json()).toMatchObject({ code: 'tenant_required' });
    });

    it('never takes identity from the body or headers', async () => {
      const routes = mount();
      const response = await call(routes, 'POST', 'threads', {
        actor: ownerA,
        body: {
          title: 'Mine',
          actorProfileId: memberB.user.profileId,
          tenantId: otherTenantId,
        },
        headers: { 'x-profile-id': memberB.user.profileId },
      });
      expect(response.status).toBe(201);
      const listB = await call(routes, 'GET', 'threads', { actor: memberB });
      expect((await listB.json()).items).toEqual([]);
      const listA = await call(routes, 'GET', 'threads', { actor: ownerA });
      expect((await listA.json()).items).toHaveLength(1);
    });

    it('uses an injected resolver instead of locals', async () => {
      const routes = mount({
        resolvePrincipal: () => ({
          userId: memberB.user.id,
          profileId: memberB.user.profileId,
          tenantId,
        }),
      });
      await createThread(routes, ownerA);
      // Locals said A; the resolver said B, so the thread is B's.
      const asB = mount();
      const list = await call(asB, 'GET', 'threads', { actor: memberB });
      expect((await list.json()).items).toHaveLength(1);
    });
  });

  // ---- 2-4. member-scoped reads and thread creation ----------------------

  describe('threads', () => {
    it('lists nothing and creates nothing before the first thread', async () => {
      const routes = mount();
      const response = await call(routes, 'GET', 'threads');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ items: [] });
      const chat = await ChatService.create({ tenantId, db });
      const sessions = await chat.findActiveAgentSessions({
        tenantId,
        agentId: 'smrt-assistant',
        participantProfileId: ownerA.user.profileId,
      });
      expect(sessions).toEqual([]);
    });

    it('scopes threads to the actor and the active tenant', async () => {
      const routes = mount();
      const threadId = await createThread(routes, ownerA, 'Roadmap');
      const mine = await call(routes, 'GET', 'threads', { actor: ownerA });
      expect((await mine.json()).items).toEqual([
        expect.objectContaining({
          id: threadId,
          title: 'Roadmap',
          isResolved: false,
          messageCount: 0,
        }),
      ]);
      const other = await call(routes, 'GET', 'threads', { actor: memberB });
      expect((await other.json()).items).toEqual([]);
      const elsewhere = await call(routes, 'GET', 'threads', {
        actor: ownerAElsewhere,
      });
      expect((await elsewhere.json()).items).toEqual([]);
    });

    it('validates the title', async () => {
      const routes = mount();
      for (const body of [{}, { title: '   ' }, { title: 'x'.repeat(201) }]) {
        const response = await call(routes, 'POST', 'threads', { body });
        expect(response.status).toBe(400);
      }
      const notJson = await call(routes, 'POST', 'threads', {
        rawBody: 'title=x',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      });
      expect(notJson.status).toBe(415);
      const malformed = await call(routes, 'POST', 'threads', {
        rawBody: '{"title":',
        headers: { 'content-type': 'application/json' },
      });
      expect(malformed.status).toBe(400);
      const array = await call(routes, 'POST', 'threads', { body: ['x'] });
      expect(array.status).toBe(400);
    });

    it('reads messages only from the actor’s own assistant room in the tenant', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      expect(await listMessages(routes, threadId)).toEqual([]);

      for (const actor of [memberB, ownerAElsewhere]) {
        const denied = await call(
          routes,
          'GET',
          `threads/${threadId}/messages`,
          { actor },
        );
        expect(denied.status).toBe(404);
      }
      const unknown = await call(routes, 'GET', 'threads/nope/messages');
      expect(unknown.status).toBe(404);

      // A room A belongs to that is not the assistant room stays out of reach.
      const chat = await ChatService.create({ tenantId, db });
      const room = await chat.createRoom({
        tenantId,
        name: 'General',
        roomType: 'public',
        actorProfileId: ownerA.user.profileId,
      });
      const side = await chat.startThread({
        tenantId,
        roomId: room.id as string,
        actorProfileId: ownerA.user.profileId,
        title: 'Side',
      });
      const sideRead = await call(routes, 'GET', `threads/${side.id}/messages`);
      expect(sideRead.status).toBe(404);
    });
  });

  // ---- 5-6. sends --------------------------------------------------------

  describe('send', () => {
    it('persists the user message, streams the turn, and persists the reply', async () => {
      const ai = scriptedAI([text('Here is the plan.')]);
      const routes = mount({ ai, systemPrompt: 'Be brief.' });
      const threadId = await createThread(routes);
      const response = await send(routes, threadId, {
        content: 'What next?',
        clientRequestId: 'req-1',
      });
      expect(response.headers.get('content-type')).toMatch(
        /^text\/event-stream/,
      );
      const { seen, thrown } = await events(response);
      expect(thrown).toBeNull();
      const persisted = seen.filter((e) => e.type === 'message') as Extract<
        AssistantTurnEvent<AssistantMessageWire>,
        { type: 'message' }
      >[];
      expect(persisted.map((e) => [e.message.role, e.message.content])).toEqual(
        [
          ['user', 'What next?'],
          ['assistant', 'Here is the plan.'],
        ],
      );
      expect(persisted[0].message.clientRequestId).toBe('req-1');
      expect(
        seen.at(-1)?.type === 'done' || seen.some((e) => e.type === 'done'),
      ).toBe(true);
      expect(ai.seen[0][0]).toMatchObject({
        role: 'system',
        content: 'Be brief.',
      });

      const reloaded = await listMessages(routes, threadId);
      expect(
        reloaded.map((m) => [m.role, m.content, m.clientRequestId]),
      ).toEqual([
        ['user', 'What next?', 'req-1'],
        ['assistant', 'Here is the plan.', undefined],
      ]);

      // The next turn carries the earlier exchange as history.
      await events(
        await send(routes, threadId, {
          content: 'And then?',
          clientRequestId: 'req-2',
        }),
      );
      expect(ai.seen[1].map((m) => [m.role, m.content])).toEqual([
        ['system', 'Be brief.'],
        ['user', 'What next?'],
        ['assistant', 'Here is the plan.'],
        ['user', 'And then?'],
      ]);
    });

    it('refuses another member’s or another tenant’s thread before any write or model call', async () => {
      const factory = vi.fn(() => scriptedAI([text('nope')]));
      const routes = mount({ ai: factory });
      const threadId = await createThread(routes, ownerA);
      for (const actor of [memberB, ownerAElsewhere]) {
        const response = await send(
          routes,
          threadId,
          {
            content: 'hi',
            clientRequestId: `x-${actor.tenantId}-${actor.user.id}`,
          },
          actor,
        );
        expect(response.status).toBe(404);
      }
      expect(factory).not.toHaveBeenCalled();
      expect(await listMessages(routes, threadId)).toEqual([]);
    });

    it('rejects malformed and oversized input', async () => {
      const routes = mount({ maxBodyBytes: 4096 });
      const threadId = await createThread(routes);
      const cases: Array<[Record<string, unknown>, number]> = [
        [{ content: '', clientRequestId: 'a' }, 400],
        [{ content: '   ', clientRequestId: 'a' }, 400],
        [{ content: 'hi' }, 400],
        [{ content: 'hi', clientRequestId: 'has space' }, 400],
        [{ content: 'hi', clientRequestId: 'x'.repeat(129) }, 400],
        [{ content: 'hi', clientRequestId: 'a', attachments: 'nope' }, 400],
        [{ content: 'x'.repeat(4100), clientRequestId: 'a' }, 413],
        [{ content: 'x'.repeat(5000), clientRequestId: 'a' }, 413],
      ];
      for (const [body, status] of cases) {
        const response = await send(routes, threadId, body);
        expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(status);
      }
      const longMessage = mount({ maxContentLength: 10 });
      const response = await send(longMessage, threadId, {
        content: 'x'.repeat(11),
        clientRequestId: 'a',
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ code: 'message_too_long' });
      expect(await listMessages(routes, threadId)).toEqual([]);
    });

    it('answers a repeated clientRequestId without a second user message', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      await events(
        await send(routes, threadId, { content: 'hi', clientRequestId: 'dup' }),
      );
      const again = await send(routes, threadId, {
        content: 'hi',
        clientRequestId: 'dup',
      });
      expect(again.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await again.json()).toMatchObject({
        duplicate: true,
        inProgress: false,
        userMessage: { content: 'hi', clientRequestId: 'dup' },
        assistantMessage: { role: 'assistant', content: 'Hello there.' },
      });
      const messages = await listMessages(routes, threadId);
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    });

    it('answers a duplicate that arrives while the first send is still running', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ai = {
        async chat() {
          await gate;
          return { content: 'late', finishReason: 'stop' };
        },
      } as unknown as AIInterface;
      const routes = mount({ ai });
      const threadId = await createThread(routes);
      const first = await send(routes, threadId, {
        content: 'hi',
        clientRequestId: 'busy',
      });
      const second = await send(routes, threadId, {
        content: 'hi',
        clientRequestId: 'busy',
      });
      expect(await second.json()).toMatchObject({
        duplicate: true,
        inProgress: true,
        userMessage: { clientRequestId: 'busy' },
      });
      release();
      await events(first);
      const messages = await listMessages(routes, threadId);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    });

    it('persists one user message when identical sends race before either is stored', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      const responses = await Promise.all(
        [1, 2, 3].map(() =>
          send(routes, threadId, {
            content: 'race',
            clientRequestId: 'race-1',
          }),
        ),
      );
      const streams = responses.filter((r) =>
        /^text\/event-stream/.test(r.headers.get('content-type') ?? ''),
      );
      expect(streams).toHaveLength(1);
      for (const response of responses) {
        if (streams.includes(response)) await events(response);
        else expect(await response.json()).toMatchObject({ duplicate: true });
      }
      const messages = await listMessages(routes, threadId);
      expect(messages.filter((m) => m.role === 'user')).toHaveLength(1);
    });
  });

  // ---- 6b. durable send reservation (review F1/F2) -------------------------

  describe('durable send reservation', () => {
    const userRows = (messages: AssistantMessageWire[], id: string) =>
      messages.filter((m) => m.role === 'user' && m.clientRequestId === id);

    it('runs one turn when two independently mounted handlers race on one clientRequestId', async () => {
      const ran: PrincipalRun[] = [];
      const errors: unknown[] = [];
      const ai = scriptedAI([calls(['data-discover', {}]), text('Done once.')]);
      // Both requests reach the AI factory (past any pre-write check) before
      // either is allowed to continue, so neither can see the other's row.
      let arrived = 0;
      let open: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        open = resolve;
      });
      const factory = async () => {
        arrived += 1;
        if (arrived >= 2) open();
        await Promise.race([
          barrier,
          new Promise((resolve) => setTimeout(resolve, 3000)),
        ]);
        return ai;
      };
      const shared = {
        ai: factory,
        allowedTools: ['data.discover'],
        extraTools: [discoverTool(ran)],
        onError: (error: unknown) => errors.push(error),
      };
      const replicaOne = mount(shared);
      const replicaTwo = mount(shared);
      const threadId = await createThread(replicaOne);
      const body = { content: 'once', clientRequestId: 'replica-1' };
      const responses = await Promise.all([
        send(replicaOne, threadId, body),
        send(replicaTwo, threadId, body),
      ]);
      const answers: unknown[] = [];
      for (const response of responses) {
        if (
          /^text\/event-stream/.test(response.headers.get('content-type') ?? '')
        ) {
          await events(response);
        } else {
          answers.push(await response.json());
        }
      }
      expect(arrived).toBe(2);
      expect(
        userRows(await listMessages(replicaOne, threadId), 'replica-1'),
      ).toHaveLength(1);
      expect(ran).toHaveLength(1);
      expect(answers).toEqual([expect.objectContaining({ duplicate: true })]);
      expect(errors.map(String)).toEqual([]);
    });

    it('recognises a replay after more than 200 later messages', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      await events(
        await send(routes, threadId, {
          content: 'first',
          clientRequestId: 'old-1',
        }),
      );
      const chat = await ChatService.create({ tenantId, db });
      const sessions = await chat.findActiveAgentSessions({
        tenantId,
        agentId: 'smrt-assistant',
        participantProfileId: ownerA.user.profileId,
      });
      const roomId = sessions[0].chatRoomId as string;
      for (let i = 0; i < 205; i += 1) {
        await chat.sendMessage({
          tenantId,
          roomId,
          threadId,
          actorProfileId: ownerA.user.profileId,
          content: `later ${i}`,
        });
      }
      const replay = await send(routes, threadId, {
        content: 'first',
        clientRequestId: 'old-1',
      });
      expect(replay.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await replay.json()).toMatchObject({
        duplicate: true,
        inProgress: false,
        userMessage: { clientRequestId: 'old-1', content: 'first' },
        assistantMessage: { content: 'Hello there.' },
      });
      const all = await chat.getThreadMessages({
        threadId,
        actorProfileId: ownerA.user.profileId,
        tenantId,
        limit: 1000,
      });
      expect(all.filter((m) => m.content === 'first')).toHaveLength(1);
    }, 180_000);

    it('answers a retry of a failed turn as failed without a second message or a second turn', async () => {
      let calls = 0;
      const ai = {
        async chat() {
          calls += 1;
          throw new Error('provider down');
        },
      } as unknown as AIInterface;
      const routes = mount({ ai });
      const threadId = await createThread(routes);
      const first = await events(
        await send(routes, threadId, {
          content: 'try',
          clientRequestId: 'fail-1',
        }),
      );
      expect(first.seen.some((e) => e.type === 'error')).toBe(true);
      const retry = await send(routes, threadId, {
        content: 'try',
        clientRequestId: 'fail-1',
      });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({ code: 'turn_failed' });
      expect(calls).toBe(1);
      expect(
        userRows(await listMessages(routes, threadId), 'fail-1'),
      ).toHaveLength(1);
    });

    it('derives a uuid reservation id scoped to tenant, room, thread, actor and request', () => {
      const base = {
        tenantId: 't',
        roomId: 'r',
        threadId: 'th',
        actorProfileId: 'p',
        clientRequestId: 'c',
      };
      const id = clientRequestMessageId(base);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(clientRequestMessageId({ ...base })).toBe(id);
      for (const key of Object.keys(base) as Array<keyof typeof base>) {
        expect(clientRequestMessageId({ ...base, [key]: 'other' })).not.toBe(
          id,
        );
      }
    });

    it('stores a client request once in ChatService and counts it once', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      const chat = await ChatService.create({ tenantId, db });
      const [session] = await chat.findActiveAgentSessions({
        tenantId,
        agentId: 'smrt-assistant',
        participantProfileId: ownerA.user.profileId,
      });
      const input = {
        tenantId,
        roomId: session.chatRoomId as string,
        threadId,
        actorProfileId: ownerA.user.profileId,
        content: 'hello',
        clientRequestId: 'svc-1',
      };
      const stored = await chat.sendMessage(input);
      expect(stored.id).toBe(clientRequestMessageId(input));
      await expect(chat.sendMessage(input)).rejects.toBeInstanceOf(
        ChatClientRequestConflictError,
      );
      const thread = await chat.getThread({ threadId, tenantId });
      expect(thread?.messageCount).toBe(1);
      // Without a clientRequestId nothing is reserved.
      await chat.sendMessage({ ...input, clientRequestId: undefined });
      await chat.sendMessage({ ...input, clientRequestId: undefined });
      const after = await chat.getThread({ threadId, tenantId });
      expect(after?.messageCount).toBe(3);
    });

    it('answers a send that never settled as failed once it is older than abandonedTurnMs', async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ai = {
        async chat() {
          await gate;
          return { content: 'late', finishReason: 'stop' };
        },
      } as unknown as AIInterface;
      const routes = mount({ ai });
      const threadId = await createThread(routes);
      const first = await send(routes, threadId, {
        content: 'slow',
        clientRequestId: 'slow-1',
      });
      // Within the window it is in progress ...
      const soon = await send(routes, threadId, {
        content: 'slow',
        clientRequestId: 'slow-1',
      });
      expect(await soon.json()).toMatchObject({
        duplicate: true,
        inProgress: true,
        outcome: 'in_progress',
      });
      // ... and past it (another replica with a short window), failed.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const strict = mount({ ai, abandonedTurnMs: 1 });
      const late = await send(strict, threadId, {
        content: 'slow',
        clientRequestId: 'slow-1',
      });
      expect(late.status).toBe(409);
      expect(await late.json()).toMatchObject({ code: 'turn_failed' });
      release();
      await events(first);
      // Once the reply exists the send is completed, whatever its age.
      const done = await send(strict, threadId, {
        content: 'slow',
        clientRequestId: 'slow-1',
      });
      expect(await done.json()).toMatchObject({
        outcome: 'completed',
        assistantMessage: { content: 'late' },
      });
    });

    it('records a stopped turn as cancelled', async () => {
      const controller = new AbortController();
      const ai = {
        async chat() {
          controller.abort();
          throw new Error('aborted');
        },
      } as unknown as AIInterface;
      const routes = mount({ ai });
      const threadId = await createThread(routes);
      const url = new URL(
        `${ORIGIN}/api/assistant/threads/${threadId}/messages`,
      );
      const response = await routes.POST({
        request: new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body: JSON.stringify({
            content: 'stop me',
            clientRequestId: 'stop-1',
          }),
          signal: controller.signal,
        }),
        url,
        params: { path: `threads/${threadId}/messages` },
        locals: locals(ownerA),
      });
      const { seen } = await events(response);
      expect(seen.find((e) => e.type === 'done')).toMatchObject({
        stoppedReason: 'cancelled',
      });
      const retry = await send(routes, threadId, {
        content: 'stop me',
        clientRequestId: 'stop-1',
      });
      expect(await retry.json()).toMatchObject({
        duplicate: true,
        inProgress: false,
        outcome: 'cancelled',
      });
    });

    it('runs both sends when one clientRequestId goes to two of the actor’s threads at once', async () => {
      const routes = mount();
      const one = await createThread(routes, ownerA, 'One');
      const two = await createThread(routes, ownerA, 'Two');
      const body = { content: 'same id', clientRequestId: 'shared-id' };
      // The first stream is not consumed yet: its turn is still running.
      const first = await send(routes, one, body);
      const second = await send(routes, two, body);
      for (const response of [first, second]) {
        expect(response.headers.get('content-type')).toMatch(
          /^text\/event-stream/,
        );
        await events(response);
      }
      for (const threadId of [one, two]) {
        const messages = await listMessages(routes, threadId);
        expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      }
    });
  });

  // ---- 6c. reservation outcomes (review 2: M1-M3) --------------------------

  describe('reservation outcomes', () => {
    const pageTools = [
      {
        name: 'page_read',
        description: 'Read the page.',
        inputSchema: { type: 'object', properties: {} },
        effect: 'read',
      },
    ];

    /** An AI whose answer depends on the turn's own user message: `call:`
     * asks for the browser tool once, anything else replies `reply <text>`. */
    function turnAI(gates: Map<string, Promise<void>> = new Map()) {
      return {
        async chat(messages: AIMessage[]) {
          const lastUser = [...messages]
            .reverse()
            .find((m) => m.role === 'user');
          const text = String(lastUser?.content ?? '');
          const sawTool = messages.some((m) => m.role === 'tool');
          await gates.get(text);
          if (text.startsWith('call:') && !sawTool) {
            return {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: `t-${text}`,
                  type: 'function',
                  function: { name: 'page_read', arguments: '{}' },
                },
              ],
            };
          }
          return { content: `reply ${text}`, finishReason: 'stop' };
        },
      } as unknown as AIInterface;
    }

    async function suspendSend(
      routes: AssistantRoutes,
      threadId: string,
      content: string,
      clientRequestId: string,
    ) {
      const { seen } = await events(
        await send(routes, threadId, {
          content,
          clientRequestId,
          clientTools: pageTools,
        }),
      );
      const last = seen.at(-1) as Extract<
        AssistantTurnEvent,
        { type: 'client_tool_calls' }
      >;
      expect(last.type).toBe('client_tool_calls');
      return last;
    }

    const resume = (
      routes: AssistantRoutes,
      threadId: string,
      body: Record<string, unknown>,
    ) =>
      call(routes, 'POST', `threads/${threadId}/resume`, {
        body: { results: [], ...body },
      });

    const retry = (
      routes: AssistantRoutes,
      threadId: string,
      content: string,
      clientRequestId: string,
    ) => send(routes, threadId, { content, clientRequestId });

    it('keeps a suspended send in progress past abandonedTurnMs while its continuation is valid (M1)', async () => {
      const routes = mount({
        ai: turnAI(),
        clientToolAllowList: ['page_*'],
        abandonedTurnMs: 1,
      });
      const threadId = await createThread(routes);
      const suspended = await suspendSend(routes, threadId, 'call:a', 'm1-a');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const waiting = await retry(routes, threadId, 'call:a', 'm1-a');
      expect(waiting.status).toBe(200);
      expect(await waiting.json()).toMatchObject({
        duplicate: true,
        inProgress: true,
        outcome: 'in_progress',
      });
      const resumed = await events(
        await resume(routes, threadId, {
          continuationId: suspended.continuationId,
          results: [{ id: 't-call:a', ok: true, result: 'page' }],
        }),
      );
      expect(resumed.seen.some((e) => e.type === 'done')).toBe(true);
      expect(
        await (await retry(routes, threadId, 'call:a', 'm1-a')).json(),
      ).toMatchObject({
        outcome: 'completed',
        assistantMessage: { content: 'reply call:a' },
      });
    });

    it('settles the send that owns the consumed continuation, not the one the request names (M2)', async () => {
      const routes = mount({ ai: turnAI(), clientToolAllowList: ['page_*'] });
      const threadId = await createThread(routes);
      await suspendSend(routes, threadId, 'call:a', 'm2-a');
      // One suspension per thread: B's replaces A's continuation.
      const b = await suspendSend(routes, threadId, 'call:b', 'm2-b');
      const resumed = await events(
        await resume(routes, threadId, {
          clientRequestId: 'm2-a',
          continuationId: b.continuationId,
          results: [{ id: 't-call:b', ok: true, result: 'page' }],
        }),
      );
      expect(resumed.seen.some((e) => e.type === 'done')).toBe(true);
      expect(
        await (await retry(routes, threadId, 'call:b', 'm2-b')).json(),
      ).toMatchObject({
        outcome: 'completed',
        assistantMessage: { content: 'reply call:b' },
      });
      // A never completed: its continuation is gone, so it has failed.
      const a = await retry(routes, threadId, 'call:a', 'm2-a');
      expect(a.status).toBe(409);
      expect(await a.json()).toMatchObject({ code: 'turn_failed' });
    });

    it('changes no send when a resume names an invalid continuation (M2)', async () => {
      const routes = mount({ ai: turnAI(), clientToolAllowList: ['page_*'] });
      const threadId = await createThread(routes);
      const a = await suspendSend(routes, threadId, 'call:a', 'm2i-a');
      const bogus = await events(
        await resume(routes, threadId, {
          clientRequestId: 'm2i-a',
          continuationId: 'not-a-continuation',
        }),
      );
      expect(bogus.seen.find((e) => e.type === 'error')).toMatchObject({
        code: 'continuation_expired',
      });
      expect(
        await (await retry(routes, threadId, 'call:a', 'm2i-a')).json(),
      ).toMatchObject({ outcome: 'in_progress' });
      const resumed = await events(
        await resume(routes, threadId, {
          continuationId: a.continuationId,
          results: [{ id: 't-call:a', ok: true, result: 'page' }],
        }),
      );
      expect(resumed.seen.some((e) => e.type === 'done')).toBe(true);
      expect(
        await (await retry(routes, threadId, 'call:a', 'm2i-a')).json(),
      ).toMatchObject({
        outcome: 'completed',
        assistantMessage: { content: 'reply call:a' },
      });
    });

    it('answers each overlapping send with its own reply when turns finish out of order (M3)', async () => {
      let releaseA: () => void = () => {};
      let releaseB: () => void = () => {};
      const gates = new Map<string, Promise<void>>([
        ['first', new Promise((resolve) => (releaseA = resolve))],
        ['second', new Promise((resolve) => (releaseB = resolve))],
      ]);
      const routes = mount({ ai: turnAI(gates) });
      const threadId = await createThread(routes);
      const streamA = await retry(routes, threadId, 'first', 'm3-a');
      const streamB = await retry(routes, threadId, 'second', 'm3-b');
      const readA = events(streamA);
      const readB = events(streamB);
      releaseB();
      await readB;
      releaseA();
      await readA;
      const a = await (await retry(routes, threadId, 'first', 'm3-a')).json();
      const b = await (await retry(routes, threadId, 'second', 'm3-b')).json();
      expect(a).toMatchObject({
        outcome: 'completed',
        assistantMessage: { content: 'reply first' },
      });
      expect(b).toMatchObject({
        outcome: 'completed',
        assistantMessage: { content: 'reply second' },
      });
      expect(JSON.stringify(a.messages)).not.toContain('reply second');
      expect(JSON.stringify(b.messages)).not.toContain('reply first');
    });

    it('marks a send failed when sendMessage throws after storing it', async () => {
      const original = ChatService.prototype.sendMessage;
      const spy = vi
        .spyOn(ChatService.prototype, 'sendMessage')
        .mockImplementationOnce(async function (
          this: ChatService,
          ...args: Parameters<ChatService['sendMessage']>
        ) {
          await original.apply(this, args);
          throw new Error('room save failed after insert');
        });
      try {
        const routes = mount();
        const threadId = await createThread(routes);
        const first = await retry(routes, threadId, 'hi', 'after-store');
        expect(first.status).toBe(500);
        const again = await retry(routes, threadId, 'hi', 'after-store');
        expect(again.status).toBe(409);
        expect(await again.json()).toMatchObject({ code: 'turn_failed' });
        const rows = (await listMessages(routes, threadId)).filter(
          (m) => m.clientRequestId === 'after-store',
        );
        expect(rows).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
    });

    it('marks a send failed when the turn cannot start after storing it', async () => {
      const spy = vi
        .spyOn(ChatService.prototype, 'getThreadMessages')
        .mockRejectedValueOnce(new Error('history read failed'));
      try {
        const routes = mount();
        const threadId = await createThread(routes);
        const first = await retry(routes, threadId, 'hi', 'no-start');
        expect(first.status).toBe(500);
        const again = await retry(routes, threadId, 'hi', 'no-start');
        expect(again.status).toBe(409);
      } finally {
        spy.mockRestore();
      }
    });

    // ---- review 3 (N1/N2): the runner, not the reader, settles a send ----

    /** Read SSE frames until `stop` matches; the stream stays open. */
    async function readUntil(
      response: Response,
      stop: (event: AssistantTurnEvent<AssistantMessageWire>) => boolean,
    ) {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const seen: AssistantTurnEvent<AssistantMessageWire>[] = [];
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return { seen, reader, ended: true };
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          const event = JSON.parse(
            data,
          ) as AssistantTurnEvent<AssistantMessageWire>;
          seen.push(event);
          if (stop(event)) return { seen, reader, ended: false };
        }
      }
    }

    const isReply = (event: AssistantTurnEvent<AssistantMessageWire>) =>
      event.type === 'message' && event.message.role === 'assistant';

    /** The send's recorded `metadata.turnOutcome`. */
    async function outcomeOf(threadId: string, clientRequestId: string) {
      const chat = await ChatService.create({ tenantId, db });
      const messages = await chat.getThreadMessages({
        threadId,
        actorProfileId: ownerA.user.profileId,
        tenantId,
        limit: 200,
      });
      const send = messages.find(
        (m) => m.getMetadata().clientRequestId === clientRequestId,
      );
      return send?.getMetadata().turnOutcome;
    }

    async function waitForOutcome(
      threadId: string,
      clientRequestId: string,
      outcome: string,
    ) {
      for (let i = 0; i < 100; i += 1) {
        if ((await outcomeOf(threadId, clientRequestId)) === outcome) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        `outcome stayed ${String(await outcomeOf(threadId, clientRequestId))}`,
      );
    }

    async function waitForReply(threadId: string, content: string) {
      const chat = await ChatService.create({ tenantId, db });
      for (let i = 0; i < 100; i += 1) {
        const messages = await chat.getThreadMessages({
          threadId,
          actorProfileId: ownerA.user.profileId,
          tenantId,
          limit: 200,
        });
        if (
          messages.some((m) => m.role === 'assistant' && m.content === content)
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`no reply ${content}`);
    }

    /** Slow every `suspended` write, widening any race with a resume. */
    async function withSlowSuspension<T>(fn: () => Promise<T>): Promise<T> {
      const original = ChatService.prototype.recordClientRequestOutcome;
      const spy = vi
        .spyOn(ChatService.prototype, 'recordClientRequestOutcome')
        .mockImplementation(async function (
          this: ChatService,
          ...args: Parameters<ChatService['recordClientRequestOutcome']>
        ) {
          if (args[0].outcome === 'suspended') {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          return original.apply(this, args);
        });
      try {
        return await fn();
      } finally {
        spy.mockRestore();
      }
    }

    it('completes a send whose reader left after the reply but before done, first leg and resumed leg (N1)', async () => {
      const routes = mount({ ai: turnAI(), clientToolAllowList: ['page_*'] });
      const strict = mount({
        ai: turnAI(),
        clientToolAllowList: ['page_*'],
        abandonedTurnMs: 1,
      });
      const threadId = await createThread(routes);

      // The reader takes one frame, stalls while the turn stores its reply,
      // then leaves without ever reading `done`.
      const first = await readUntil(
        await retry(routes, threadId, 'plain', 'n1-a'),
        () => true,
      );
      await waitForReply(threadId, 'reply plain');
      await first.reader.cancel();

      const suspended = await suspendSend(routes, threadId, 'call:n1', 'n1-b');
      const resumed = await readUntil(
        await resume(routes, threadId, {
          continuationId: suspended.continuationId,
          results: [{ id: 't-call:n1', ok: true, result: 'page' }],
        }),
        () => true,
      );
      expect(resumed.ended).toBe(false);
      await waitForReply(threadId, 'reply call:n1');
      await resumed.reader.cancel();

      for (const [content, id] of [
        ['plain', 'n1-a'],
        ['call:n1', 'n1-b'],
      ]) {
        expect(
          await (await retry(routes, threadId, content, id)).json(),
        ).toMatchObject({ outcome: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        const late = await retry(strict, threadId, content, id);
        expect(late.status).toBe(200);
        expect(await late.json()).toMatchObject({
          outcome: 'completed',
          assistantMessage: { content: `reply ${content}` },
        });
        await waitForOutcome(threadId, id, 'completed');
      }
    });

    it('keeps the resumed leg’s outcome when the original stream closes after the resume (N2)', () =>
      withSlowSuspension(async () => {
        const routes = mount({ ai: turnAI(), clientToolAllowList: ['page_*'] });
        const threadId = await createThread(routes);
        const original = await readUntil(
          await send(routes, threadId, {
            content: 'call:held',
            clientRequestId: 'n2-held',
            clientTools: pageTools,
          }),
          (event) => event.type === 'client_tool_calls',
        );
        const suspension = original.seen.at(-1) as Extract<
          AssistantTurnEvent,
          { type: 'client_tool_calls' }
        >;
        const resumed = await events(
          await resume(routes, threadId, {
            continuationId: suspension.continuationId,
            results: [{ id: 't-call:held', ok: true, result: 'page' }],
          }),
        );
        expect(resumed.seen.some((e) => e.type === 'done')).toBe(true);
        // Now drain and close the original stream.
        for (;;) {
          const { done } = await original.reader.read();
          if (done) break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await outcomeOf(threadId, 'n2-held')).toBe('completed');
        const strict = mount({
          ai: turnAI(),
          clientToolAllowList: ['page_*'],
          abandonedTurnMs: 1,
        });
        expect(
          await (await retry(strict, threadId, 'call:held', 'n2-held')).json(),
        ).toMatchObject({ outcome: 'completed' });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(await outcomeOf(threadId, 'n2-held')).toBe('completed');
      }));

    it('records a suspension the reader never finished reading, paused or cancelled (N2)', () =>
      withSlowSuspension(async () => {
        const strict = mount({
          ai: turnAI(),
          clientToolAllowList: ['page_*'],
          abandonedTurnMs: 1,
        });
        const threadId = await createThread(strict);
        for (const [content, id, leave] of [
          ['call:paused', 'n2-paused', 'pause'],
          ['call:cancelled', 'n2-cancelled', 'cancel'],
        ] as const) {
          const original = await readUntil(
            await send(strict, threadId, {
              content,
              clientRequestId: id,
              clientTools: pageTools,
            }),
            (event) => event.type === 'client_tool_calls',
          );
          if (leave === 'cancel') await original.reader.cancel();
          const suspension = original.seen.at(-1) as Extract<
            AssistantTurnEvent,
            { type: 'client_tool_calls' }
          >;
          await new Promise((resolve) => setTimeout(resolve, 10));
          const waiting = await retry(strict, threadId, content, id);
          expect(waiting.status).toBe(200);
          expect(await waiting.json()).toMatchObject({
            outcome: 'in_progress',
          });
          const resumed = await events(
            await resume(strict, threadId, {
              continuationId: suspension.continuationId,
              results: [{ id: `t-${content}`, ok: true, result: 'page' }],
            }),
          );
          expect(resumed.seen.some((e) => e.type === 'done')).toBe(true);
          expect(
            await (await retry(strict, threadId, content, id)).json(),
          ).toMatchObject({
            outcome: 'completed',
            assistantMessage: { content: `reply ${content}` },
          });
          if (leave === 'pause') await original.reader.cancel();
        }
      }));

    it('treats a stored linked reply as completion when the outcome write was lost (crash)', async () => {
      const original = ChatService.prototype.recordClientRequestOutcome;
      const spy = vi
        .spyOn(ChatService.prototype, 'recordClientRequestOutcome')
        .mockImplementation(async function (
          this: ChatService,
          ...args: Parameters<ChatService['recordClientRequestOutcome']>
        ) {
          // The process "dies" between storing the reply and recording it.
          if (args[0].outcome === 'completed') return false;
          return original.apply(this, args);
        });
      try {
        const routes = mount({
          ai: turnAI(),
          clientToolAllowList: ['page_*'],
        });
        const threadId = await createThread(routes);
        const suspended = await suspendSend(
          routes,
          threadId,
          'call:crash',
          'crash-1',
        );
        await events(
          await resume(routes, threadId, {
            continuationId: suspended.continuationId,
            results: [{ id: 't-call:crash', ok: true, result: 'page' }],
          }),
        );
        expect(await outcomeOf(threadId, 'crash-1')).toBe('running');
        await new Promise((resolve) => setTimeout(resolve, 10));
        const strict = mount({ ai: turnAI(), abandonedTurnMs: 1 });
        expect(
          await (await retry(strict, threadId, 'call:crash', 'crash-1')).json(),
        ).toMatchObject({
          outcome: 'completed',
          assistantMessage: { content: 'reply call:crash' },
        });
      } finally {
        spy.mockRestore();
      }
    });

    // ---- review 4 (P1/P2) ----------------------------------------------

    it('cancels the turn when the response body is cancelled without aborting the request (P1 probe)', async () => {
      const ran: PrincipalRun[] = [];
      let entered: () => void = () => {};
      const inFirstCall = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const ai = {
        async chat() {
          calls += 1;
          if (calls === 1) {
            entered();
            await gate;
            // Released with a SERVER tool call.
            return {
              content: '',
              finishReason: 'tool_calls',
              toolCalls: [
                {
                  id: 'srv-1',
                  type: 'function',
                  function: { name: 'data-discover', arguments: '{}' },
                },
              ],
            };
          }
          return { content: 'should not be reached', finishReason: 'stop' };
        },
      } as unknown as AIInterface;
      const routes = mount({
        ai,
        allowedTools: ['data.discover'],
        extraTools: [discoverTool(ran)],
      });
      const threadId = await createThread(routes);
      const response = await retry(routes, threadId, 'probe', 'p1-probe');
      const opened = await readUntil(response, () => true);
      await inFirstCall;
      // The client leaves; the adapter never aborts `request.signal`.
      await opened.reader.cancel();
      release();
      await waitForOutcome(threadId, 'p1-probe', 'cancelled');
      expect(ran).toHaveLength(0);
      expect(calls).toBe(1);
      expect(
        await (await retry(routes, threadId, 'probe', 'p1-probe')).json(),
      ).toMatchObject({ outcome: 'cancelled', inProgress: false });
    });

    it('keeps a resuming send in progress between taking its continuation and recording running (P2)', async () => {
      const routes = mount({ ai: turnAI(), clientToolAllowList: ['page_*'] });
      const threadId = await createThread(routes);
      const suspended = await suspendSend(routes, threadId, 'call:p2', 'p2-a');
      const original = ChatService.prototype.recordClientRequestOutcome;
      let blocked: () => void = () => {};
      const reached = new Promise<void>((resolve) => {
        blocked = resolve;
      });
      let proceed: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const spy = vi
        .spyOn(ChatService.prototype, 'recordClientRequestOutcome')
        .mockImplementation(async function (
          this: ChatService,
          ...args: Parameters<ChatService['recordClientRequestOutcome']>
        ) {
          if (args[0].outcome === 'running' && args[0].resumedFrom) {
            blocked();
            await gate;
          }
          return original.apply(this, args);
        });
      try {
        const resumeResponse = await resume(routes, threadId, {
          continuationId: suspended.continuationId,
          results: [{ id: 't-call:p2', ok: true, result: 'page' }],
        });
        const reading = events(resumeResponse);
        // `take` has run: the runner is now recording `running`.
        await reached;
        expect(await outcomeOf(threadId, 'p2-a')).toBe('suspended');
        const poll = await retry(routes, threadId, 'call:p2', 'p2-a');
        expect(poll.status).toBe(200);
        expect(await poll.json()).toMatchObject({ outcome: 'in_progress' });
        // The claimed continuation is single-use meanwhile.
        const second = await events(
          await resume(routes, threadId, {
            continuationId: suspended.continuationId,
            results: [{ id: 't-call:p2', ok: true, result: 'page' }],
          }),
        );
        expect(second.seen.find((e) => e.type === 'error')).toMatchObject({
          code: 'continuation_expired',
        });
        proceed();
        const done = await reading;
        expect(done.seen.some((e) => e.type === 'done')).toBe(true);
        expect(
          await (await retry(routes, threadId, 'call:p2', 'p2-a')).json(),
        ).toMatchObject({
          outcome: 'completed',
          assistantMessage: { content: 'reply call:p2' },
        });
      } finally {
        proceed();
        spy.mockRestore();
      }
    });

    it('refuses out-of-order and stale outcome writes, compare-and-set', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      const chat = await ChatService.create({ tenantId, db });
      const [session] = await chat.findActiveAgentSessions({
        tenantId,
        agentId: 'smrt-assistant',
        participantProfileId: ownerA.user.profileId,
      });
      const stored = await chat.sendMessage({
        tenantId,
        roomId: session.chatRoomId as string,
        threadId,
        actorProfileId: ownerA.user.profileId,
        content: 'cas',
        clientRequestId: 'cas-1',
      });
      const record = (
        outcome: Parameters<
          ChatService['recordClientRequestOutcome']
        >[0]['outcome'],
        resumedFrom: string | null,
        continuationId?: string,
      ) =>
        chat.recordClientRequestOutcome({
          tenantId,
          threadId,
          messageId: String(stored.id),
          actorProfileId: ownerA.user.profileId,
          outcome,
          resumedFrom,
          continuationId: continuationId ?? null,
        });
      expect(await record('suspended', null)).toBe(false); // needs an id
      expect(await record('running', null)).toBe(true);
      expect(await record('running', null)).toBe(false); // already running
      expect(await record('suspended', null, 'c1')).toBe(true);
      expect(await record('running', 'c0')).toBe(false); // wrong continuation
      expect(await record('completed', null)).toBe(false); // not running
      // Two resumes of c1 race: exactly one consumes it.
      const raced = await Promise.all([
        record('running', 'c1'),
        record('running', 'c1'),
      ]);
      expect(raced.filter(Boolean)).toHaveLength(1);
      // The first leg's late writes are stale now.
      expect(await record('suspended', null, 'c1')).toBe(false);
      expect(await record('failed', null)).toBe(false);
      expect(await record('completed', 'c1')).toBe(true);
      expect(await record('running', 'c1')).toBe(false);
      expect(await record('failed', 'c1')).toBe(false);
      expect(await outcomeOf(threadId, 'cas-1')).toBe('completed');
    });
  });

  // ---- 7. tools ------------------------------------------------------------

  describe('tools', () => {
    it('offers no tools to a principal without an allow-list', async () => {
      const ran: PrincipalRun[] = [];
      const ai = scriptedAI([text('No tools here.')]);
      const routes = mount({ ai, extraTools: [discoverTool(ran)] });
      const threadId = await createThread(routes);
      await events(
        await send(routes, threadId, {
          content: 'look',
          clientRequestId: 'n1',
        }),
      );
      expect(ai.offered[0]).toEqual([]);
      expect(ran).toEqual([]);
    });

    it('runs allow-listed tools under the request principal', async () => {
      const ran: PrincipalRun[] = [];
      const ai = scriptedAI([calls(['data-discover', {}]), text('Found it.')]);
      const routes = mount({
        ai,
        allowedTools: ({ principal }) =>
          principal.profileId === ownerA.user.profileId
            ? ['data.discover']
            : [],
        extraTools: [discoverTool(ran)],
      });
      const threadId = await createThread(routes);
      const { seen } = await events(
        await send(routes, threadId, {
          content: 'look',
          clientRequestId: 't1',
        }),
      );
      expect(ai.offered[0]).toContain('data-discover');
      expect(ran).toHaveLength(1);
      expect(ran[0].allowedTools).toEqual(['data.discover']);
      expect(ran[0].context).toBeDefined();
      expect(
        seen.some(
          (e) =>
            e.type === 'step' && e.step.kind === 'tool_result' && e.step.ok,
        ),
      ).toBe(true);
    });

    it('drops browser tools that are not on the allow-list', async () => {
      const ai = scriptedAI([text('ok')]);
      const routes = mount({ ai, clientToolAllowList: ['page_*'] });
      const threadId = await createThread(routes);
      await events(
        await send(routes, threadId, {
          content: 'hi',
          clientRequestId: 'c1',
          clientTools: [
            {
              name: 'page_read',
              description: 'Read.',
              inputSchema: { type: 'object' },
              effect: 'read',
            },
            {
              name: 'admin_delete',
              description: 'Delete.',
              inputSchema: { type: 'object' },
              effect: 'destructive',
            },
          ],
        }),
      );
      expect(ai.offered[0]).toEqual(['page_read']);
    });
  });

  // ---- 8. suspension and resume -------------------------------------------

  describe('resume', () => {
    const pageTools = [
      {
        name: 'page_read',
        description: 'Read the page.',
        inputSchema: { type: 'object', properties: {} },
        effect: 'read',
      },
    ];

    async function suspend(
      routes: AssistantRoutes,
      threadId: string,
      id: string,
    ) {
      const { seen } = await events(
        await send(routes, threadId, {
          content: 'read the page',
          clientRequestId: id,
          clientTools: pageTools,
        }),
      );
      const suspended = seen.at(-1) as Extract<
        AssistantTurnEvent,
        { type: 'client_tool_calls' }
      >;
      expect(suspended.type).toBe('client_tool_calls');
      return suspended;
    }

    it('suspends on a browser tool and resumes once', async () => {
      const ai = scriptedAI([
        calls(['page_read', {}, 'p1']),
        text('The page lists three items.'),
      ]);
      const routes = mount({ ai, clientToolAllowList: ['page_*'] });
      const threadId = await createThread(routes);
      const suspended = await suspend(routes, threadId, 's1');
      expect(suspended.calls).toEqual([
        { id: 'p1', name: 'page_read', args: {}, effect: 'read' },
      ]);

      const resumed = await events(
        await call(routes, 'POST', `threads/${threadId}/resume`, {
          body: {
            clientRequestId: 's1',
            continuationId: suspended.continuationId,
            results: [{ id: 'p1', ok: true, result: 'three items' }],
          },
        }),
      );
      expect(resumed.thrown).toBeNull();
      expect(resumed.seen.find((e) => e.type === 'done')).toMatchObject({
        message: { role: 'assistant', content: 'The page lists three items.' },
      });

      // Stale: the continuation was consumed.
      const replay = await events(
        await call(routes, 'POST', `threads/${threadId}/resume`, {
          body: {
            continuationId: suspended.continuationId,
            results: [{ id: 'p1', ok: true, result: 'again' }],
          },
        }),
      );
      expect(replay.seen.find((e) => e.type === 'error')).toMatchObject({
        code: 'continuation_expired',
      });
    });

    it('refuses a foreign actor and a resume under another thread', async () => {
      const ai = scriptedAI([calls(['page_read', {}, 'p1']), text('done')]);
      const routes = mount({ ai, clientToolAllowList: ['page_*'] });
      const threadId = await createThread(routes);
      const otherThread = await createThread(routes, ownerA, 'Other');
      const suspended = await suspend(routes, threadId, 'f1');
      const body = {
        continuationId: suspended.continuationId,
        results: [{ id: 'p1', ok: true, result: 'x' }],
      };
      for (const actor of [memberB, ownerAElsewhere]) {
        const response = await call(
          routes,
          'POST',
          `threads/${threadId}/resume`,
          { actor, body },
        );
        expect(response.status).toBe(404);
      }
      const crossThread = await events(
        await call(routes, 'POST', `threads/${otherThread}/resume`, { body }),
      );
      expect(crossThread.seen.find((e) => e.type === 'error')).toMatchObject({
        code: 'continuation_expired',
      });
      // The owner's real continuation is still intact after those attempts.
      const ok = await events(
        await call(routes, 'POST', `threads/${threadId}/resume`, { body }),
      );
      expect(ok.seen.some((e) => e.type === 'done')).toBe(true);
    });

    it('rejects malformed resume input', async () => {
      const routes = mount();
      const threadId = await createThread(routes);
      for (const body of [
        { results: [] },
        { continuationId: 'c', results: 'x' },
        { continuationId: 'c', results: [null] },
        { continuationId: 'c', results: [{ id: 'p1' }] },
        { continuationId: 'c', results: [{ ok: true }] },
        {
          continuationId: 'c',
          results: Array.from({ length: 65 }, (_, i) => ({
            id: `p${i}`,
            ok: true,
          })),
        },
      ]) {
        const response = await call(
          routes,
          'POST',
          `threads/${threadId}/resume`,
          { body },
        );
        expect(response.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
    });
  });

  // ---- 9-10. upstream failure and models ----------------------------------

  describe('upstream failure', () => {
    it('redacts a model failure mid-turn and logs the detail server-side', async () => {
      const logged: unknown[] = [];
      const ai = {
        async chat() {
          throw new Error('provider key sk-secret rejected');
        },
      } as unknown as AIInterface;
      const routes = mount({ ai, onError: (error) => logged.push(error) });
      const threadId = await createThread(routes);
      const { seen, thrown } = await events(
        await send(routes, threadId, { content: 'hi', clientRequestId: 'e1' }),
      );
      expect(thrown).toBeInstanceOf(Error);
      const error = seen.find((e) => e.type === 'error') as {
        error: string;
        code: string;
      };
      expect(error.code).toBe('internal_error');
      expect(error.error).not.toContain('sk-secret');
      expect(String(logged[0])).toContain('sk-secret');
    });

    it('answers 503 and writes nothing when the AI factory fails', async () => {
      const routes = mount({
        ai: () => {
          throw new Error('no credentials');
        },
      });
      const threadId = await createThread(routes);
      const response = await send(routes, threadId, {
        content: 'hi',
        clientRequestId: 'f1',
      });
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({ code: 'assistant_unavailable' });
      expect(JSON.stringify(body)).not.toContain('credentials');
      expect(await listMessages(routes, threadId)).toEqual([]);
    });

    it('allows only listed models, and ignores a model when none are listed', async () => {
      const ai = scriptedAI([text('ok')]);
      const listed = mount({ ai, models: [{ id: 'm1' }] });
      const threadId = await createThread(listed);
      const refused = await send(listed, threadId, {
        content: 'hi',
        clientRequestId: 'm-a',
        model: 'm2',
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ code: 'model_not_allowed' });
      await events(
        await send(listed, threadId, {
          content: 'hi',
          clientRequestId: 'm-b',
          model: 'm1',
        }),
      );
      expect(ai.models.at(-1)).toBe('m1');

      const unlisted = mount({ ai, defaultModel: 'fallback' });
      await events(
        await send(unlisted, threadId, {
          content: 'hi',
          clientRequestId: 'm-c',
          model: 'm9',
        }),
      );
      expect(ai.models.at(-1)).toBe('fallback');
    });
  });

  // ---- 11. attachments ----------------------------------------------------

  describe('attachments', () => {
    const upload = (
      routes: AssistantRoutes,
      file: File,
      actor: Actor = ownerA,
    ) => {
      const form = new FormData();
      form.set('file', file);
      return call(routes, 'POST', 'attachments', { actor, rawBody: form });
    };

    it('fails closed without host storage', async () => {
      const routes = mount();
      const response = await upload(routes, new File(['x'], 'a.txt'));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: 'attachments_unsupported',
      });
      const threadId = await createThread(routes);
      const sent = await send(routes, threadId, {
        content: 'see file',
        clientRequestId: 'a1',
        attachments: [{ id: 'att-1', name: 'a.txt' }],
      });
      expect(sent.status).toBe(400);
      expect(await listMessages(routes, threadId)).toEqual([]);
    });

    it('stores uploads through the host and persists verified references', async () => {
      const stored = new Map<
        string,
        { owner: string; name: string; size: number }
      >();
      const routes = mount({
        attachments: {
          maxBytes: 16,
          async upload(file, { principal }) {
            const id = `att-${stored.size + 1}`;
            stored.set(id, {
              owner: principal.profileId,
              name: file.name,
              size: file.size,
            });
            return {
              id,
              name: file.name,
              contentType: 'text/plain',
              size: file.size,
            };
          },
          async verify(references, { principal }) {
            const out = [];
            for (const ref of references) {
              const id = (ref as { id?: unknown })?.id;
              const entry = typeof id === 'string' ? stored.get(id) : undefined;
              if (!entry || entry.owner !== principal.profileId) return null;
              out.push({
                id: id as string,
                name: entry.name,
                contentType: 'text/plain',
                size: entry.size,
              });
            }
            return out;
          },
        },
      });
      const response = await upload(routes, new File(['hello'], 'note.txt'));
      expect(response.status).toBe(201);
      const { attachment } = await response.json();
      expect(attachment).toMatchObject({
        id: 'att-1',
        name: 'note.txt',
        size: 5,
      });

      const tooBig = await upload(
        routes,
        new File(['x'.repeat(17)], 'big.txt'),
      );
      expect(tooBig.status).toBe(413);

      const threadId = await createThread(routes);
      // B cannot attach A's upload.
      const threadB = await createThread(routes, memberB);
      const stolen = await send(
        routes,
        threadB,
        {
          content: 'mine now',
          clientRequestId: 'b1',
          attachments: [attachment],
        },
        memberB,
      );
      expect(stolen.status).toBe(400);

      await events(
        await send(routes, threadId, {
          content: 'see note',
          clientRequestId: 'a2',
          attachments: [
            { ...attachment, size: 999_999, url: 'https://evil.test/x' },
          ],
        }),
      );
      const [userMessage] = await listMessages(routes, threadId);
      expect(userMessage.attachments).toEqual([
        { id: 'att-1', name: 'note.txt', contentType: 'text/plain', size: 5 },
      ]);
    });
  });

  // ---- 12. actions --------------------------------------------------------

  describe('actions', () => {
    const request = (phase: 'preview' | 'apply') => ({
      version: 1,
      requestId: 'r1',
      identity: { surfaceId: 'articles', kind: 'table' },
      actionId: 'archive',
      phase,
      selection: { scope: 'explicit-ids', rowIds: ['a1'] },
      expectedRevision: 3,
      ...(phase === 'apply' ? { idempotencyKey: 'k1' } : {}),
    });

    it('answers 404 without an adapter', async () => {
      const routes = mount();
      const response = await call(routes, 'POST', 'actions/preview', {
        body: request('preview'),
      });
      expect(response.status).toBe(404);
    });

    it('passes the server-resolved principal to the adapter', async () => {
      const preview = vi.fn(async (req: { requestId: string }) => ({
        version: 1 as const,
        requestId: req.requestId,
        identity: { surfaceId: 'articles', kind: 'table' as const },
        actionId: 'archive',
        phase: 'preview' as const,
        ok: true,
        confirmationToken: 'tok',
      }));
      const apply = vi.fn(async () => {
        throw new Error('db exploded');
      });
      const routes = mount({
        allowedTools: ['articles.archive'],
        actions: { adapter: { preview, apply } as never },
      });
      const previewed = await call(routes, 'POST', 'actions/preview', {
        body: { ...request('preview'), principal: { runAsUserId: 'attacker' } },
      });
      expect(previewed.status).toBe(200);
      expect((await previewed.json()).result).toMatchObject({
        ok: true,
        confirmationToken: 'tok',
      });
      const [, context] = preview.mock.calls[0] as unknown as [
        unknown,
        {
          principal: {
            principal: Record<string, unknown>;
            onBehalfOfUserId: string;
          };
        },
      ];
      expect(context.principal.principal).toEqual({
        runAsUserId: ownerA.user.id,
        tenantId,
        allowedTools: ['articles.archive'],
      });
      expect(context.principal.onBehalfOfUserId).toBe(ownerA.user.id);

      const failed = await call(routes, 'POST', 'actions/apply', {
        body: request('apply'),
      });
      expect(failed.status).toBe(500);
      const failedBody = await failed.json();
      expect(failedBody).toMatchObject({ code: 'outcome_unknown' });
      expect(JSON.stringify(failedBody)).not.toContain('exploded');

      const mismatch = await call(routes, 'POST', 'actions/apply', {
        body: request('preview'),
      });
      expect(mismatch.status).toBe(400);
      const unauth = await call(routes, 'POST', 'actions/preview', {
        actor: null,
        body: request('preview'),
      });
      expect(unauth.status).toBe(401);
      expect(preview).toHaveBeenCalledTimes(1);
    });
  });

  // ---- 15-16. origin and routing -----------------------------------------

  describe('origin and routing', () => {
    it('requires a same-origin mutation unless disabled', async () => {
      const routes = mount();
      const foreign = await call(routes, 'POST', 'threads', {
        body: { title: 'x' },
        origin: 'https://evil.test',
      });
      expect(foreign.status).toBe(403);
      const none = await call(routes, 'POST', 'threads', {
        body: { title: 'x' },
        origin: null,
      });
      expect(none.status).toBe(403);
      const sameSite = await call(routes, 'POST', 'threads', {
        body: { title: 'x' },
        origin: null,
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(sameSite.status).toBe(201);
      const trusted = mount({ trustedOrigins: ['https://proxy.test'] });
      const viaProxy = await call(trusted, 'POST', 'threads', {
        body: { title: 'x' },
        origin: 'https://proxy.test',
      });
      expect(viaProxy.status).toBe(201);
      const open = mount({ checkOrigin: false });
      const unchecked = await call(open, 'POST', 'threads', {
        body: { title: 'x' },
        origin: null,
      });
      expect(unchecked.status).toBe(201);
    });

    it('answers unknown paths 404 and wrong methods 405', async () => {
      const routes = mount();
      expect((await call(routes, 'GET', 'nope')).status).toBe(404);
      expect((await call(routes, 'GET', 'threads/a/b/c')).status).toBe(404);
      const wrong = await call(routes, 'GET', 'threads/t1/resume');
      expect(wrong.status).toBe(405);
      expect(wrong.headers.get('allow')).toBe('POST');
    });

    it('serves a route mounted without a rest parameter via basePath', async () => {
      const routes = mount({ basePath: '/api/assistant' });
      const url = new URL(`${ORIGIN}/api/assistant/threads`);
      const response = await routes.GET({
        request: new Request(url),
        url,
        locals: locals(ownerA),
      });
      expect(response.status).toBe(200);
    });

    it('requires an AI client at mount time', () => {
      expect(() =>
        mountAssistantRoutes({ ai: undefined as unknown as AIInterface }),
      ).toThrow(/ai/);
    });
  });

  // ---- 14. the browser transport against these routes ---------------------

  describe('browser transport contract', () => {
    it('drives list, create, send, load and resume through the real handlers', async () => {
      const ai = scriptedAI([
        text('First answer.'),
        calls(['page_read', {}, 'p9']),
        text('Read it.'),
      ]);
      const routes = mount({ ai, clientToolAllowList: ['page_*'] });
      const fetchImpl = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const url = new URL(String(input), ORIGIN);
        const path = url.pathname.replace(/^\/api\/assistant\/?/, '');
        const headers = new Headers(init?.headers);
        headers.set('origin', ORIGIN);
        expect(headers.has('authorization')).toBe(false);
        const request = new Request(url, { ...init, headers });
        return routes.handle({
          request,
          url,
          params: { path },
          locals: locals(ownerA),
        });
      }) as typeof fetch;
      const transport = createAssistantHttpTransport({
        endpoint: '/api/assistant/',
        fetchImpl,
      });
      expect(await transport.listThreads()).toEqual([]);
      const thread = await transport.createThread('Contract');
      expect(thread).toMatchObject({ title: 'Contract', messageCount: 0 });
      expect((await transport.listThreads()).map((t) => t.id)).toEqual([
        thread.id,
      ]);

      const streamed: string[] = [];
      const sent = await transport.sendMessage({
        threadId: thread.id,
        content: 'Hello',
        clientRequestId: 'contract-1',
        onEvent: (event) => streamed.push(event.type),
      });
      expect(sent.inProgress).toBe(false);
      expect(sent.userMessage).toMatchObject({
        content: 'Hello',
        clientRequestId: 'contract-1',
      });
      expect(sent.assistantMessage).toMatchObject({ content: 'First answer.' });
      expect(streamed).toContain('done');

      const repeat = await transport.sendMessage({
        threadId: thread.id,
        content: 'Hello',
        clientRequestId: 'contract-1',
      });
      expect(repeat).toMatchObject({
        inProgress: false,
        assistantMessage: { content: 'First answer.' },
      });

      const suspended = await transport.sendMessage({
        threadId: thread.id,
        content: 'Read the page',
        clientRequestId: 'contract-2',
        clientTools: [
          {
            name: 'page_read',
            description: 'Read.',
            inputSchema: { type: 'object', properties: {} },
            effect: 'read',
          },
        ],
      });
      expect(suspended.clientToolCalls?.calls).toEqual([
        { id: 'p9', name: 'page_read', args: {}, effect: 'read' },
      ]);
      const resumed = await transport.resumeTurn?.({
        threadId: thread.id,
        clientRequestId: 'contract-2',
        continuationId: suspended.clientToolCalls?.continuationId as string,
        results: [{ id: 'p9', ok: true, result: 'page text' }],
      });
      expect(resumed?.assistantMessage).toMatchObject({ content: 'Read it.' });

      const loaded = await transport.loadMessages(thread.id);
      expect(loaded.map((m) => [m.role, m.content])).toEqual([
        ['user', 'Hello'],
        ['assistant', 'First answer.'],
        ['user', 'Read the page'],
        ['assistant', 'Read it.'],
      ]);
      expect(loaded[0].clientRequestId).toBe('contract-1');

      await expect(transport.loadMessages('missing')).rejects.toThrow(/404/);
      await expect(
        transport.uploadAttachment(new File(['x'], 'x.txt')),
      ).rejects.toThrow(/does not accept attachments/);
    });
  });
});
