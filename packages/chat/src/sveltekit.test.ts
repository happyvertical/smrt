import { AssistantTurnUserError } from './assistant-turn.js';
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
  createSqliteOwnerApprovalStore,
  OwnerApprovalAuthority,
  OwnerApprovalContinuations,
} from '@happyvertical/smrt-app-runtime';
import { ObjectRegistry, resolveDatabase } from '@happyvertical/smrt-core';
import { createCookbookEngine } from '@happyvertical/smrt-core/cookbook/engine';
import { InferenceUnavailableError } from '@happyvertical/smrt-core/inference-availability';
import {
  createCookbookRuntimeExposure,
  setRuntimeExposureGate,
} from '@happyvertical/smrt-core/runtime-exposure';
import { resolveWorkProfile } from '@happyvertical/smrt-inference';
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
  type AssistantContinuationStore,
  CONTINUATION_CLAIM_TTL_MS,
  createMemoryContinuationStore,
} from './assistant-turn.js';
import type {
  AssistantTurnDriverCallbacks,
  AssistantTurnDriverContext,
} from './assistant-turn-driver.js';
import {
  type AssistantTurnEvent,
  readAssistantTurnStream,
} from './assistant-turn-events.js';
import { sendAgentReply } from './services/ChatService.js';
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
import {
  DEFAULT_EMPTY_ANSWER_FALLBACK,
  FALLBACK_HISTORY_PLACEHOLDER,
} from './tool-loop.js';

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

// The real ChatService methods, captured once before any test spies on them.
// Spy helpers must delegate to these, never to `ChatService.prototype.x` read
// at spy time: an attempt that times out never reaches its `finally`, so its
// spy is still installed when the retry starts, `vi.spyOn` returns that same
// spy, and a helper that captured it as "the original" calls itself forever
// (an unbounded async loop that exhausted the CI worker's heap).
const realSendMessage = ChatService.prototype.sendMessage;
const realRecordOutcome = ChatService.prototype.recordClientRequestOutcome;

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
    setRuntimeExposureGate(undefined);
    // Runs after a timed-out attempt too, so no spy outlives its test.
    vi.restoreAllMocks();
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

  it.each([
    'unknown',
    'zero',
    'partial',
  ] as const)('preserves %s provider usage in stored turn metadata', async (mode) => {
    const answer: Round = () => ({
      content: 'Done',
      model: 'reported-model',
      finishReason: 'stop',
      ...(mode === 'zero'
        ? { usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }
        : {}),
    });
    const knownCall: Round = () => ({
      ...calls(['data-discover', {}])([], undefined),
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    });
    const ai = scriptedAI(mode === 'partial' ? [knownCall, answer] : [answer]);
    const routes = mount({
      ai,
      resolveWorkProfile: async () => resolveWorkProfile({ engine: 'api' }),
      allowedTools: mode === 'partial' ? ['data.discover'] : [],
      extraTools: mode === 'partial' ? [discoverTool([])] : [],
      onWorkRun: () => {},
    });
    const threadId = await createThread(routes);
    expect(
      (
        await events(
          await send(routes, threadId, {
            content: 'Help',
            clientRequestId: `usage-${mode}`,
          }),
        )
      ).thrown,
    ).toBeNull();
    const stored = await listMessages(routes, threadId);
    const metadata = stored.at(-1)?.metadata?.workRun;
    expect(metadata).toMatchObject({
      profile: 'assist',
      toolCalls: mode === 'partial' ? 1 : 0,
    });
    if (mode === 'zero') expect(metadata).toHaveProperty('tokens', 0);
    else expect(metadata).not.toHaveProperty('tokens');
    expect(metadata).toHaveProperty('durationMs');
    // Unknown usage must not prevent the other execution facts being recorded.
    expect(metadata).toHaveProperty('model', 'reported-model');
  });

  it.each([
    true,
    false,
  ])('stores assist handoff accounting before durable design (usage known: %s)', async (known) => {
    const ran: PrincipalRun[] = [];
    const ai = scriptedAI([
      () => ({
        ...calls(['data-discover', {}])([], undefined),
        model: 'reported-assist',
        ...(known
          ? {
              usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
            }
          : {}),
      }),
    ]);
    const accounting = vi.fn();
    const routes = mount({
      ai,
      resolveWorkProfile: async () => resolveWorkProfile({ engine: 'api' }),
      allowedTools: ['data.discover'],
      extraTools: [discoverTool(ran)],
      designTools: ['data.discover'],
      onDesignEscalation: async () => ({ runId: 'queued-design' }),
      onWorkRun: accounting,
    });
    const threadId = await createThread(routes);
    const response = await events(
      await send(routes, threadId, {
        content: 'Build',
        clientRequestId: 'handoff',
      }),
    );
    expect(response.thrown).toBeNull();
    expect(ran).toHaveLength(0);
    const stored = (await listMessages(routes, threadId)).at(-1);
    expect(stored).toMatchObject({
      role: 'assistant',
      content: 'Thinking this through',
      metadata: {
        designRunId: 'queued-design',
        workRun: { profile: 'assist', model: 'reported-assist', toolCalls: 0 },
      },
    });
    if (known) expect(stored?.metadata?.workRun).toHaveProperty('tokens', 12);
    else expect(stored?.metadata?.workRun).not.toHaveProperty('tokens');
    expect(accounting).toHaveBeenCalledTimes(1);
    const messageIndex = response.seen.findIndex(
      (event) => event.type === 'message' && event.message.role === 'assistant',
    );
    const doneIndex = response.seen.findIndex((event) => event.type === 'done');
    expect(messageIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThan(messageIndex);
  });

  it('runs a trusted internal pass without authoring a technical user message and preserves structured output', async () => {
    const routes = mount();
    const threadId = await createThread(routes);
    await events(
      await send(routes, threadId, {
        content: 'Build my app',
        clientRequestId: 'original',
      }),
    );
    const original = (await listMessages(routes, threadId)).find(
      (message) => message.role === 'user',
    )!;
    const ai = scriptedAI([text('{"summary":"A readable plan","models":[]}')]);
    const internal = mount({
      ai,
      internalTurn: () => ({
        userMessage: 'PRIVATE PASS PROMPT',
        originMessageId: original.id,
      }),
      formatAssistantReply: (content) => ({
        content: JSON.parse(content).summary,
        metadata: {
          designOutput: JSON.parse(content),
          privateHostDetail: 'never on wire',
        },
      }),
    });
    const response = await events(
      await send(internal, threadId, {
        content: 'Build my app',
        clientRequestId: 'internal',
      }),
    );
    expect(response.thrown).toBeNull();
    const stored = await listMessages(routes, threadId);
    expect(stored.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(
      stored.some((message) => message.content.includes('PRIVATE PASS PROMPT')),
    ).toBe(false);
    expect(stored.map((message) => message.content)).toEqual([
      'Build my app',
      'Hello there.',
    ]);
    expect(response.seen).toContainEqual(
      expect.objectContaining({
        type: 'done',
        message: expect.objectContaining({
          metadata: {
            designOutput: { summary: 'A readable plan', models: [] },
          },
        }),
      }),
    );
    expect(ai.seen.at(-1)?.at(-1)?.content).toBe('PRIVATE PASS PROMPT');
  });

  it.each([
    false,
    true,
  ])('keeps trusted internal tool and pass rows private while preserving the host SSE handoff (external %s)', async (external) => {
    const routes = mount();
    const threadId = await createThread(routes);
    const source = JSON.stringify({
      summary: 'PRIVATE @fixture/models:Member TenantId ProfileId',
      operations: [],
    });
    const internal = mount({
      allowedTools: ['data.discover'],
      extraTools: [discoverTool([])],
      internalTurn: () => ({ userMessage: 'PRIVATE PASS INPUT' }),
      formatAssistantReply: (content) => ({
        content: JSON.parse(content).summary,
        metadata: { designOutput: JSON.parse(content) },
      }),
      ...(external
        ? {
            turnDriver: {
              async run(_context, cb) {
                await cb.toolCall({
                  id: 'private-tool',
                  name: 'data.discover',
                  args: { model: '@fixture/models:Member' },
                });
                await cb.toolResult({
                  id: 'private-tool',
                  ok: true,
                  result: { summary: 'PRIVATE TOOL OUTPUT' },
                });
                cb.done({ text: source });
              },
            },
          }
        : {
            ai: scriptedAI([
              calls(['data-discover', {}, 'private-tool']),
              text(source),
            ]),
          }),
    });
    const response = await events(
      await send(internal, threadId, {
        content: 'PRIVATE BODY',
        clientRequestId: 'private-pass',
      }),
    );
    expect(response.thrown).toBeNull();
    expect(response.seen).toContainEqual(
      expect.objectContaining({
        type: 'done',
        message: expect.objectContaining({
          metadata: expect.objectContaining({
            designOutput: JSON.parse(source),
          }),
        }),
      }),
    );
    const chat = await ChatService.create({ db });
    const raw = await chat.getThreadMessages({
      tenantId,
      threadId,
      actorProfileId: ownerA.user.profileId,
    });
    expect(raw.some((row) => row.role === 'tool')).toBe(true);
    expect(
      raw
        .filter((row) => row.role !== 'user')
        .every((row) => row.getMetadata().assistantInternalTurn === true),
    ).toBe(true);
    const hidden = raw.find((row) => row.role === 'assistant')!;
    expect(
      await chat.getThreadMessageReplies({
        tenantId,
        threadId,
        messageId: String(hidden.id),
        actorProfileId: ownerA.user.profileId,
        visibility: 'conversation',
      }),
    ).toBeNull();
    const hiddenRoute = await call(
      routes,
      'GET',
      `threads/${threadId}/messages/${hidden.id}`,
    );
    expect(hiddenRoute.status).toBe(404);
    expect(await hiddenRoute.text()).not.toMatch(/PRIVATE|designOutput/);
    expect(await listMessages(routes, threadId)).toEqual([]);
    expect(await listMessages(mount(), threadId)).toEqual([]);
    const ordinary = await events(
      await send(routes, threadId, {
        content: 'Ordinary human message',
        clientRequestId: 'ordinary-with-forged-flags',
        internalTurn: true,
        assistantInternalTurn: true,
        metadata: {
          assistantInternalTurn: true,
          designOutput: { summary: 'forged' },
        },
      }),
    );
    expect(ordinary.thrown).toBeNull();
    expect(
      (await listMessages(routes, threadId)).map((row) => row.content),
    ).toEqual(['Ordinary human message', 'Hello there.']);
    const forgedHeader = await events(
      await call(routes, 'POST', `threads/${threadId}/messages`, {
        headers: { 'x-internal-turn': 'true', 'x-assistant-private': 'true' },
        body: {
          content: 'Ordinary header message',
          clientRequestId: 'forged-header',
        },
      }),
    );
    expect(forgedHeader.thrown).toBeNull();
    expect(
      (await listMessages(routes, threadId)).some(
        (row) => row.content === 'Ordinary header message',
      ),
    ).toBe(true);
  });

  it('uses only the trusted canonical approval presenter for a meaningful business preview', async () => {
    const authority = await durableApprovals();
    const presentApproval = vi.fn(async (record: { tool: string }) =>
      record.tool === 'app.addField'
        ? { summary: 'Add Licence plate to Members' }
        : undefined,
    );
    const routes = mount({
      approvals: authority,
      toolPresentation: 'generic',
      presentApproval,
    });
    const threadId = await createThread(routes);
    const hold = await authority.request({
      tenantId,
      requestedBy: ownerA.user.id,
      tool: 'app.addField',
      callId: 'PRIVATE',
      summary: 'PRIVATE raw summary TenantId',
      args: { label: 'PRIVATE' },
      context: {
        threadId,
        principal: {
          userId: ownerA.user.id,
          profileId: ownerA.user.profileId,
          tenantId,
        },
      },
      continuation: {
        executor: 'fixture',
        principal: {
          id: ownerA.user.id,
          tenantId,
          permissions: [],
          allowedTools: [],
        },
        consumption: 'continuation',
      },
    });
    const rows = await listMessages(routes, threadId);
    expect(rows[0]).toMatchObject({
      id: `approval:${hold.id}`,
      content: 'Add Licence plate to Members',
      toolCallData: {
        approval: {
          summary: 'Add Licence plate to Members',
          presentation: { summary: 'Add Licence plate to Members' },
        },
      },
    });
    expect(JSON.stringify(rows)).not.toMatch(
      /PRIVATE|TenantId|app\.addField|"args"/,
    );
    expect(presentApproval).toHaveBeenCalledWith(
      expect.objectContaining({ id: hold.id, args: { label: 'PRIVATE' } }),
    );
  });

  it('pages public conversation rows past internal and legacy pass rows without hiding human or ordinary tool rows', async () => {
    const routes = mount({
      toolPresentation: 'generic',
      allowedTools: ['app_describe', 'record_update'],
      extraTools: [
        deleteTool([], 'app_describe'),
        deleteTool([], 'record_update'),
      ],
    });
    const threadId = await createThread(routes);
    const chat = await ChatService.create({ db });
    const [session] = await chat.findActiveAgentSessions({
      tenantId,
      agentId: 'smrt-assistant',
      participantProfileId: ownerA.user.profileId,
    });
    const user = await chat.sendMessage({
      tenantId,
      roomId: session.chatRoomId!,
      threadId,
      actorProfileId: ownerA.user.profileId,
      content: 'Keep this human text',
    });
    user.setMetadata({
      assistantInternalTurn: true,
      designOutput: { summary: 'forged' },
    });
    await user.save();
    for (const name of ['app_describe', 'record_update'])
      await sendAgentReply(chat, {
        tenantId,
        agentSessionId: String(session.id),
        threadId,
        kind: 'tool',
        messageType: 'tool_result',
        content:
          'PRIVATE TenantId ProfileId @fixture/models:Member {"args":true}',
        toolCallData: {
          name,
          args: { id: 'PRIVATE' },
          summary: 'PRIVATE raw result summary',
          status: 'success',
        },
      });
    await sendAgentReply(chat, {
      tenantId,
      agentSessionId: String(session.id),
      threadId,
      content: 'Keep this ordinary answer',
    });
    await sendAgentReply(chat, {
      tenantId,
      agentSessionId: String(session.id),
      threadId,
      content: 'PRIVATE LEGACY SUMMARY',
      metadata: { designOutput: { summary: 'PRIVATE LEGACY PLAN' } },
    });
    for (let i = 0; i < 201; i++)
      await sendAgentReply(chat, {
        tenantId,
        agentSessionId: String(session.id),
        threadId,
        content: `PRIVATE PASS ${i}`,
        metadata: { assistantInternalTurn: true },
      });
    const rows = await listMessages(routes, threadId);
    expect(rows.map((row) => row.content)).toEqual([
      'Keep this human text',
      'Checked the app structure',
      'Completed this action',
      'Keep this ordinary answer',
    ]);
    expect(JSON.stringify(rows)).not.toMatch(
      /PRIVATE|TenantId|ProfileId|@fixture|designOutput|"args"|"name"/,
    );
    const raw = await chat.getThreadMessages({
      tenantId,
      threadId,
      actorProfileId: ownerA.user.profileId,
      limit: 500,
    });
    expect(raw).toHaveLength(206);
    expect(
      raw.some((row) => row.content.includes('PRIVATE LEGACY SUMMARY')),
    ).toBe(true);
  });

  it.each([
    false,
    true,
  ])('projects generic tool activity on live public SSE without raw labels or observations (external %s)', async (external) => {
    const routes = mount({
      toolPresentation: 'generic',
      describeTool: () => 'PRIVATE TenantId ProfileId @fixture/models:Member',
      allowedTools: ['data.discover'],
      extraTools: [discoverTool([])],
      ...(external
        ? {
            turnDriver: {
              async run(_context, cb) {
                cb.text('PRIVATE provisional planning token');
                await cb.toolCall({
                  id: 'generic-call',
                  name: 'data.discover',
                  args: { schema: 'PRIVATE' },
                });
                await cb.toolResult({
                  id: 'generic-call',
                  ok: true,
                  result: { summary: 'PRIVATE observation' },
                });
                cb.done({ text: 'Here is your answer.' });
              },
            },
          }
        : {
            ai: scriptedAI([
              (messages, options) => {
                options?.onProgress?.('PRIVATE provisional planning token');
                return calls(['data-discover', {}, 'generic-call'])(
                  messages,
                  options,
                );
              },
              text('Here is your answer.'),
            ]),
          }),
    });
    const threadId = await createThread(routes);
    const response = await events(
      await send(routes, threadId, {
        content: 'Check records',
        clientRequestId: 'generic-public',
      }),
    );
    expect(response.thrown).toBeNull();
    expect(JSON.stringify(response.seen)).not.toMatch(
      /PRIVATE|TenantId|ProfileId|@fixture|data\.discover|"args"/,
    );
    expect(
      (await listMessages(routes, threadId))
        .filter((row) => row.role === 'tool')
        .every((row) => row.content === 'Completed this action'),
    ).toBe(true);
  });

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

    it('keeps the default session key, and adopts an unkeyed or custom-keyed session when configured', async () => {
      const chat = await ChatService.create({ tenantId, db });
      const seed = async (sessionKey?: string) => {
        const { session } = await chat.createAgentSession({
          tenantId,
          agentId: 'smrt-assistant',
          actorProfileId: ownerA.user.profileId,
          ...(sessionKey ? { sessionKey } : {}),
        });
        const thread = await chat.startThread({
          tenantId,
          roomId: session.chatRoomId as string,
          actorProfileId: ownerA.user.profileId,
          title: sessionKey ?? 'unkeyed',
        });
        return thread.id as string;
      };
      const unkeyed = await seed();
      const custom = await seed('legacy-dock');
      const titles = async (routes: AssistantRoutes) =>
        (
          (await (await call(routes, 'GET', 'threads')).json()) as {
            items: Array<{ title: string }>;
          }
        ).items.map((item) => item.title);

      // Default: neither pre-existing session is the dock's.
      expect(await titles(mount())).toEqual([]);
      expect(await titles(mount({ sessionKey: null }))).toEqual(['unkeyed']);
      expect(await titles(mount({ sessionKey: 'legacy-dock' }))).toEqual([
        'legacy-dock',
      ]);

      // An adopted thread is readable and writable, and a thread of another
      // session is still not.
      const adopted = mount({ sessionKey: null });
      expect(await listMessages(adopted, unkeyed)).toEqual([]);
      const events1 = await events(
        await send(adopted, unkeyed, {
          content: 'hi',
          clientRequestId: 'adopt-1',
        }),
      );
      expect(events1.thrown).toBeNull();
      expect(
        (await call(adopted, 'GET', `threads/${custom}/messages`)).status,
      ).toBe(404);

      // A new thread lands in the adopted session, not a new one.
      const created = await createThread(adopted, ownerA, 'Fresh');
      expect(created).toBeTruthy();
      expect(await titles(adopted)).toEqual(
        expect.arrayContaining(['unkeyed', 'Fresh']),
      );
      const sessions = await chat.findActiveAgentSessions({
        tenantId,
        agentId: 'smrt-assistant',
        participantProfileId: ownerA.user.profileId,
      });
      expect(sessions).toHaveLength(2);
    });

    it('refuses an empty sessionKey at mount', () => {
      expect(() => mount({ sessionKey: '  ' })).toThrow(/sessionKey/);
    });

    it('hands a send or resume body’s context to the per-request callbacks', async () => {
      const seen: unknown[] = [];
      const routes = mount({
        allowedTools: ['data.discover'],
        extraTools: (context) => {
          seen.push(context.requestContext);
          return [discoverTool([])];
        },
      });
      const threadId = await createThread(routes);
      const ok = await send(routes, threadId, {
        content: 'hi',
        clientRequestId: 'ctx-1',
        context: { surfaces: ['a', 'b'] },
      });
      expect((await events(ok)).thrown).toBeNull();
      expect(seen).toContainEqual({ surfaces: ['a', 'b'] });

      seen.length = 0;
      await events(
        await send(routes, threadId, {
          content: 'hi',
          clientRequestId: 'ctx-2',
        }),
      );
      expect(seen.every((value) => value === undefined)).toBe(true);

      for (const [index, context] of [
        'text',
        ['x'],
        { big: 'x'.repeat(9 * 1024) },
      ].entries()) {
        const refused = await send(routes, threadId, {
          content: 'hi',
          clientRequestId: `ctx-bad-${index}`,
          context,
        });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({ code: 'invalid_context' });
      }
      const resume = await call(routes, 'POST', `threads/${threadId}/resume`, {
        body: { continuationId: 'c', results: [], context: 'text' },
      });
      expect(resume.status).toBe(400);
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

    it('never replays a stored fallback reply as history (#4379)', async () => {
      // Turn 1: blank, and its retry blank -> the fallback is stored.
      const ai = scriptedAI([text(''), text(''), text('Four.')]);
      const routes = mount({ ai });
      const threadId = await createThread(routes);
      await events(
        await send(routes, threadId, {
          content: 'How many?',
          clientRequestId: 'f-1',
        }),
      );
      const stored = await listMessages(routes, threadId);
      expect(stored.map((m) => [m.role, m.content])).toEqual([
        ['user', 'How many?'],
        ['assistant', DEFAULT_EMPTY_ANSWER_FALLBACK],
      ]);
      await events(
        await send(routes, threadId, {
          content: 'Try again',
          clientRequestId: 'f-2',
        }),
      );
      // The fallback is not replayed; a marker keeps roles alternating.
      expect(ai.seen[2].map((m) => [m.role, m.content])).toEqual([
        ['user', 'How many?'],
        ['assistant', FALLBACK_HISTORY_PLACEHOLDER],
        ['user', 'Try again'],
      ]);
    });

    it('counts historyLimit in replayed turns, not persisted tool rows (#4458)', async () => {
      const toolRound = (turn: number) =>
        calls(
          ['data-discover', { turn, n: 1 }, `t${turn}-1`],
          ['data-discover', { turn, n: 2 }, `t${turn}-2`],
          ['data-discover', { turn, n: 3 }, `t${turn}-3`],
        );
      const ai = scriptedAI([
        toolRound(1),
        text('A1'),
        toolRound(2),
        text('A2'),
        text('A3'),
      ]);
      const read = vi.spyOn(ChatService.prototype, 'getThreadMessages');
      const routes = mount({
        ai,
        historyLimit: 2,
        allowedTools: ['data.discover'],
        extraTools: [discoverTool([])],
        authorInvocation: (invocation) => ({
          content: `ran ${invocation.slug}`,
          toolCallData: { name: invocation.slug },
        }),
      });
      const threadId = await createThread(routes);
      for (const [index, content] of ['Q1', 'Q2', 'Q3'].entries()) {
        await events(
          await send(routes, threadId, {
            content,
            clientRequestId: `h-${index}`,
          }),
        );
      }
      // The tool rows are stored between each question and its answer.
      const stored = await listMessages(routes, threadId);
      expect(stored.filter((m) => m.role === 'tool')).toHaveLength(6);
      // Turn 3 replays exactly the last 2 turns, roles alternating.
      expect(ai.seen[4].map((m) => [m.role, m.content])).toEqual([
        ['user', 'Q2'],
        ['assistant', 'A2'],
        ['user', 'Q3'],
      ]);
      // The read is role-filtered in SQL and bounded by the limit (+ the
      // stored send), whatever the thread holds.
      const historyReads = read.mock.calls.flatMap(([params], index) =>
        params.roles ? [{ params, result: read.mock.results[index] }] : [],
      );
      expect(historyReads).toHaveLength(3);
      for (const { params, result } of historyReads) {
        expect(params).toMatchObject({
          limit: 3,
          roles: ['user', 'assistant'],
        });
        expect((await result.value).length).toBeLessThanOrEqual(3);
      }
    });

    it('keeps historyLimit history unchanged on a thread without tool rows (#4458)', async () => {
      const ai = scriptedAI([text('A1'), text('A2'), text('A3')]);
      const routes = mount({ ai, historyLimit: 2 });
      const threadId = await createThread(routes);
      for (const [index, content] of ['Q1', 'Q2', 'Q3'].entries()) {
        await events(
          await send(routes, threadId, {
            content,
            clientRequestId: `n-${index}`,
          }),
        );
      }
      expect(ai.seen[2].map((m) => [m.role, m.content])).toEqual([
        ['user', 'Q2'],
        ['assistant', 'A2'],
        ['user', 'Q3'],
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
      const spy = vi
        .spyOn(ChatService.prototype, 'sendMessage')
        .mockImplementationOnce(async function (
          this: ChatService,
          ...args: Parameters<ChatService['sendMessage']>
        ) {
          await realSendMessage.apply(this, args);
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
      const spy = vi
        .spyOn(ChatService.prototype, 'recordClientRequestOutcome')
        .mockImplementation(async function (
          this: ChatService,
          ...args: Parameters<ChatService['recordClientRequestOutcome']>
        ) {
          if (args[0].outcome === 'suspended') {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
          return realRecordOutcome.apply(this, args);
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
      const spy = vi
        .spyOn(ChatService.prototype, 'recordClientRequestOutcome')
        .mockImplementation(async function (
          this: ChatService,
          ...args: Parameters<ChatService['recordClientRequestOutcome']>
        ) {
          // The process "dies" between storing the reply and recording it.
          if (args[0].outcome === 'completed') return false;
          return realRecordOutcome.apply(this, args);
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
          return realRecordOutcome.apply(this, args);
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

    // ---- review 5 (Q1/Q2) ----------------------------------------------

    /** Block (or replace) the resumed leg's `running` write. */
    function onResumedRunning(
      handle: (apply: () => Promise<boolean>) => Promise<boolean>,
    ) {
      return vi
        .spyOn(ChatService.prototype, 'recordClientRequestOutcome')
        .mockImplementation(async function (
          this: ChatService,
          ...args: Parameters<ChatService['recordClientRequestOutcome']>
        ) {
          const apply = () => realRecordOutcome.apply(this, args);
          return args[0].outcome === 'running' && args[0].resumedFrom
            ? handle(apply)
            : apply();
        });
    }

    it('keeps a claimed continuation alive past its original lifetime while the claim holds (Q1)', async () => {
      // A virtual clock anchored on the continuation's own `createdAt`, so the
      // test never depends on how fast the runner is (on a slow CI machine a
      // real-time clock let the continuation expire before the take).
      let savedAt: number | undefined;
      let offset = 0;
      const inner = createMemoryContinuationStore({
        ttlMs: 1_000,
        now: () => (savedAt ?? Date.now()) + offset,
      });
      const store: AssistantContinuationStore = {
        ...inner,
        async save(key, continuation) {
          savedAt = continuation.createdAt;
          await inner.save(key, continuation);
        },
      };
      const routes = mount({
        ai: turnAI(),
        clientToolAllowList: ['page_*'],
        continuations: () => store,
      });
      const threadId = await createThread(routes);
      const suspended = await suspendSend(routes, threadId, 'call:q1', 'q1-a');
      offset = 900; // just before the 1 s lifetime
      let reached: () => void = () => {};
      const atRunning = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let proceed: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const spy = onResumedRunning(async (apply) => {
        reached();
        await gate;
        return apply();
      });
      try {
        const reading = events(
          await resume(routes, threadId, {
            continuationId: suspended.continuationId,
            results: [{ id: 't-call:q1', ok: true, result: 'page' }],
          }),
        );
        await atRunning; // taken and claimed at ~900 ms
        offset = 2_000; // past the lifetime, far inside the 60 s claim
        expect(await store.has?.(threadId, suspended.continuationId)).toBe(
          true,
        );
        const poll = await retry(routes, threadId, 'call:q1', 'q1-a');
        expect(poll.status).toBe(200);
        expect(await poll.json()).toMatchObject({ outcome: 'in_progress' });
        proceed();
        expect((await reading).seen.some((e) => e.type === 'done')).toBe(true);
        expect(
          await (await retry(routes, threadId, 'call:q1', 'q1-a')).json(),
        ).toMatchObject({
          outcome: 'completed',
          assistantMessage: { content: 'reply call:q1' },
        });
      } finally {
        proceed();
        spy.mockRestore();
      }
    });

    for (const failure of ['returns false', 'throws'] as const) {
      it(`never runs a resumed leg whose running write ${failure}, and keeps the claim (Q2)`, async () => {
        let offset = 0;
        const store = createMemoryContinuationStore({
          now: () => Date.now() + offset,
        });
        const ran: PrincipalRun[] = [];
        const base = turnAI();
        let modelCalls = 0;
        const ai = {
          async chat(...args: Parameters<AIInterface['chat']>) {
            modelCalls += 1;
            return base.chat(...args);
          },
        } as unknown as AIInterface;
        const routes = mount({
          ai,
          clientToolAllowList: ['page_*'],
          allowedTools: ['data.discover'],
          extraTools: [discoverTool(ran)],
          continuations: () => store,
        });
        const threadId = await createThread(routes);
        const suspended = await suspendSend(
          routes,
          threadId,
          'call:q2',
          `q2-${failure.replace(' ', '-')}`,
        );
        const callsAtSuspension = modelCalls;
        const spy = onResumedRunning(async () => {
          if (failure === 'throws') throw new Error('db unavailable');
          return false;
        });
        const body = {
          continuationId: suspended.continuationId,
          results: [{ id: 't-call:q2', ok: true, result: 'page' }],
        };
        try {
          const refused = await events(await resume(routes, threadId, body));
          expect(refused.seen.find((e) => e.type === 'error')).toMatchObject({
            code: 'resume_not_recorded',
          });
          expect(modelCalls).toBe(callsAtSuspension);
          expect(ran).toHaveLength(0);
          // The claim is retained: the send is still in progress.
          expect(await store.has?.(threadId, suspended.continuationId)).toBe(
            true,
          );
          expect(
            await outcomeOf(threadId, `q2-${failure.replace(' ', '-')}`),
          ).toBe('suspended');
          const poll = await retry(
            routes,
            threadId,
            'call:q2',
            `q2-${failure.replace(' ', '-')}`,
          );
          expect(poll.status).toBe(200);
          expect(await poll.json()).toMatchObject({ outcome: 'in_progress' });
        } finally {
          spy.mockRestore();
        }
        // While the claim holds, no other resume can take it ...
        const early = await events(await resume(routes, threadId, body));
        expect(early.seen.find((e) => e.type === 'error')).toMatchObject({
          code: 'continuation_expired',
        });
        // ... once it lapses, a later resume activates and completes.
        offset = CONTINUATION_CLAIM_TTL_MS + 1_000;
        const later = await events(await resume(routes, threadId, body));
        expect(later.seen.find((e) => e.type === 'done')).toMatchObject({
          message: { content: 'reply call:q2' },
        });
        expect(
          await (
            await retry(
              routes,
              threadId,
              'call:q2',
              `q2-${failure.replace(' ', '-')}`,
            )
          ).json(),
        ).toMatchObject({ outcome: 'completed' });
      });
    }

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
  describe('tool summary parity', () => {
    for (const external of [false, true]) {
      it.each([
        ['customers.create', { name: 'Ada' }, 'Added customer Ada'],
        ['customers.update', { name: 'Ada' }, 'Updated customer Ada'],
        ['customers.delete', {}, 'Deleted customer'],
        ['invoices.list', [{}, {}, {}], 'Looked up 3 invoices'],
        [
          'custom.unknown',
          { secret: 'sk-not-for-display' },
          'Completed this action',
        ],
      ])(`${external ? 'external' : 'built-in'} %s labels and persists the same summary`, async (name, observation, expected) => {
        const extra: PrincipalTool = {
          slug: name,
          aiTool: {
            type: 'function',
            function: {
              name: name.replaceAll('.', '-'),
              description: 'Test operation',
              parameters: { type: 'object', properties: {} },
            },
          },
          async execute({ run }) {
            run.assertToolAllowed(name);
            return observation;
          },
        };
        const routes = mount({
          allowedTools: [name],
          extraTools: [extra],
          // This fixture explicitly permits the test delete; real defaults still hold.
          approvalPolicy: { tools: { [name]: false } },
          ...(external
            ? {
                turnDriver: {
                  async run(_ctx, cb) {
                    await cb.toolCall({ id: 'summary-call', name, args: {} });
                    await cb.toolResult({
                      id: 'summary-call',
                      ok: true,
                      result: JSON.stringify(observation),
                    });
                    cb.done({ text: 'Finished.' });
                  },
                },
              }
            : {
                ai: scriptedAI([
                  calls([name.replaceAll('.', '-'), {}, 'summary-call']),
                  text('Finished.'),
                ]),
              }),
        });
        const threadId = await createThread(routes);
        const result = await events(
          await send(routes, threadId, {
            content: 'Do it',
            clientRequestId: 'summary',
          }),
        );
        expect(result.thrown).toBeNull();
        expect(result.seen).toContainEqual(
          expect.objectContaining({
            type: 'step',
            step: expect.objectContaining({
              kind: 'tool_result',
              label: expected,
              ok: true,
            }),
          }),
        );
        const rows = await listMessages(routes, threadId);
        expect(rows.filter((row) => row.role === 'tool').at(-1)).toMatchObject({
          content: expected,
          toolCallData: expect.objectContaining({ label: expected }),
        });
        expect(
          rows.some((row) => row.content.includes('sk-not-for-display')),
        ).toBe(false);
      });
    }
  });

  describe('external turn drivers', () => {
    it.each([
      'enabled',
      'disabled',
      'unreadable',
      'closed-call',
      'closed-result',
      'closed-approval',
    ] as const)('applies live manifest exposure to external drivers: %s', async (state) => {
      let enabled = state !== 'disabled';
      const model = '@happyvertical/smrt-profiles:Profile';
      const checked = vi.fn((identity, context) => {
        expect(identity.qualifiedName).toBe(model);
        expect(context).toMatchObject({ tenantId, surface: 'assistant' });
        if (state === 'unreadable') throw new Error('store offline');
        return enabled;
      });
      setRuntimeExposureGate({ isEnabled: checked });
      try {
        const decision = vi.fn();
        const routes = mount({
          allowedTools: ['profiles.read'],
          tools: [
            {
              slug: 'profiles.read',
              collection: 'profiles',
              className: 'Profile',
              qualifiedName: model,
              action: 'read',
            },
          ],
          waitForApproval: async () => {
            enabled = false;
            return { approved: true };
          },
          turnDriver: {
            async run(ctx, cb) {
              if (state === 'disabled' || state === 'unreadable') {
                expect(ctx.tools).toEqual([]);
                cb.done({ text: 'No model tools.' });
                return;
              }
              expect(ctx.tools.map((tool) => tool.slug)).toEqual([
                'profiles.read',
              ]);
              if (state === 'closed-call') enabled = false;
              await cb.toolCall({
                id: 'live',
                name: 'profiles.read',
                args: {},
              });
              if (state === 'closed-approval') {
                decision(
                  await cb.approvalNeeded({
                    id: 'hold',
                    callId: 'live',
                    tool: 'profiles.read',
                    summary: 'Look up profiles',
                  }),
                );
                cb.done({ text: 'Stopped.' });
                return;
              }
              if (state === 'closed-result') enabled = false;
              await cb.toolResult({
                id: 'live',
                ok: true,
                result: '[{"name":"Ada"}]',
              });
              cb.done({ text: 'Found Ada.' });
            },
          },
        });
        const threadId = await createThread(routes);
        const result = await events(
          await send(routes, threadId, {
            content: 'Look up profiles',
            clientRequestId: crypto.randomUUID(),
          }),
        );
        const rows = await listMessages(routes, threadId);
        const successes = rows.filter(
          (row) =>
            (row.toolCallData as { status?: string })?.status === 'success',
        );
        if (state === 'enabled') {
          expect(successes.map((row) => row.content)).toEqual([
            'Looked up 1 profile',
          ]);
          expect(result.seen).toContainEqual(
            expect.objectContaining({ type: 'done', stoppedReason: 'stop' }),
          );
        } else {
          expect(successes).toEqual([]);
          if (state === 'closed-approval')
            expect(decision).toHaveBeenCalledWith({
              approved: false,
              reason: 'model_disabled',
            });
          if (state === 'closed-call' || state === 'closed-result')
            expect(result.seen).toContainEqual(
              expect.objectContaining({
                type: 'error',
                code: 'internal_error',
              }),
            );
        }
        expect(checked).toHaveBeenCalled();
      } finally {
        setRuntimeExposureGate(undefined);
      }
    });

    it('streams and authors external text and tool calls using the same thread and principal', async () => {
      const ai = vi.fn(() => {
        throw new Error('external drivers do not need a model');
      });
      const usage = vi.fn();
      const run = vi.fn(
        async (
          ctx: AssistantTurnDriverContext,
          cb: AssistantTurnDriverCallbacks,
        ) => {
          expect(ctx.thread?.id).toBe(threadId);
          expect(ctx.principal).toMatchObject({
            runAsUserId: ownerA.user.id,
            tenantId,
          });
          expect(ctx.principal.allowedTools).toEqual(['data.discover']);
          expect(
            ctx.extraTools.map((tool: PrincipalTool) => tool.slug),
          ).toEqual(['data.discover']);
          expect(ctx.systemPrompt).toBe('Act as the studio assistant.');
          expect(ctx.userMessage).toBe('look around');
          cb.text('Found ');
          await cb.toolCall({ id: 'c1', name: 'data.discover', args: {} });
          await cb.toolResult({ id: 'c1', ok: true, result: 'articles' });
          cb.text('articles.');
          cb.done({
            text: 'Found articles.',
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          });
        },
      );
      const routes = mount({
        ai,
        turnDriver: { run },
        onUsage: usage,
        systemPrompt: 'Act as the studio assistant.',
        allowedTools: ['data.discover'],
        extraTools: [discoverTool([])],
      });
      const threadId = await createThread(routes);
      const result = await events(
        await send(routes, threadId, {
          content: 'look around',
          clientRequestId: 'external',
        }),
      );
      expect(result.thrown).toBeNull();
      expect(ai).not.toHaveBeenCalled();
      expect(result.seen.filter((e) => e.type === 'token')).toEqual([
        { type: 'token', text: 'Found ' },
        { type: 'token', text: 'articles.' },
      ]);
      expect(result.seen).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'step',
            step: expect.objectContaining({
              kind: 'tool_call',
              tool: 'data.discover',
              location: 'server',
            }),
          }),
          expect.objectContaining({
            type: 'step',
            step: expect.objectContaining({ kind: 'tool_result', ok: true }),
          }),
          expect.objectContaining({ type: 'done', stoppedReason: 'stop' }),
        ]),
      );
      const rows = await listMessages(routes, threadId);
      expect(rows.map((r) => r.role)).toEqual([
        'user',
        'tool',
        'tool',
        'assistant',
      ]);
      expect(rows.map((r) => r.content)).toEqual([
        'look around',
        'Working on this action',
        'Completed this action',
        'Found articles.',
      ]);
      const chat = await ChatService.create({ db });
      const stored = await chat.getThreadMessages({
        threadId,
        actorProfileId: ownerA.user.profileId,
        tenantId,
      });
      expect(
        stored.slice(1).every((r) => r.replyToMessageId === rows[0].id),
      ).toBe(true);
      expect(stored.map((r) => r.messageType)).toEqual([
        'text',
        'tool_call',
        'tool_result',
        'text',
      ]);
      expect(usage).toHaveBeenCalledWith(
        expect.objectContaining({ totalTokens: 5 }),
        expect.anything(),
      );
    });

    it('persists partial output and sends one safe error without a duplicate fallback bubble', async () => {
      const routes = mount({
        allowedTools: ['data.discover'],
        extraTools: [discoverTool([])],
        turnDriver: {
          async run(
            _ctx: AssistantTurnDriverContext,
            cb: AssistantTurnDriverCallbacks,
          ) {
            await cb.toolCall({
              id: 'failed-call',
              name: 'data.discover',
              args: {},
            });
            await cb.toolResult({
              id: 'failed-call',
              ok: false,
              error: 'not_found',
            });
            cb.text('Partial answer');
            cb.error(new Error('secret provider detail'));
          },
        },
      });
      const threadId = await createThread(routes);
      const result = await events(
        await send(routes, threadId, {
          content: 'fail',
          clientRequestId: 'fail',
        }),
      );
      expect(result.thrown).toBeTruthy();
      expect(result.seen).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'internal_error' }),
      );
      expect(result.seen).toContainEqual(
        expect.objectContaining({
          type: 'step',
          step: expect.objectContaining({
            kind: 'tool_result',
            ok: false,
            error: 'not_found',
          }),
        }),
      );
      const rows = await listMessages(routes, threadId);
      expect(rows.map((r) => r.content)).toEqual([
        'fail',
        'Working on this action',
        'Could not complete this action',
        'Partial answer',
      ]);
      expect(
        result.seen.filter((event) => event.type === 'error'),
      ).toHaveLength(1);
      expect(
        rows.some(
          (row) =>
            (row.metadata as { fallback?: string })?.fallback ===
            'provider_error',
        ),
      ).toBe(false);
      expect(JSON.stringify(result.seen)).not.toContain(
        'secret provider detail',
      );
    });

    it('resolves per request and user, supplies prior messages, and falls back to the model adapter', async () => {
      const resolveTurnDriver = vi.fn(
        ({
          principal,
          requestContext,
        }: import('./sveltekit.js').AssistantRequestContext) =>
          requestContext?.engine === 'external'
            ? {
                async run(
                  ctx: AssistantTurnDriverContext,
                  cb: AssistantTurnDriverCallbacks,
                ) {
                  cb.done({
                    text: `external:${principal.userId}:${ctx.history.length}`,
                  });
                },
              }
            : undefined,
      );
      const ai = vi.fn(
        ({
          principal,
          model,
          requestContext,
        }: import('./sveltekit.js').AssistantRequestContext & {
          model?: string;
        }) => {
          expect(model).toBe('plan');
          expect(requestContext?.engine).toBe('plan');
          return scriptedAI([text(`adapter:${principal.userId}`)]);
        },
      );
      const routes = mount({ ai, resolveTurnDriver, models: [{ id: 'plan' }] });
      for (const actor of [ownerA, memberB]) {
        const threadId = await createThread(routes, actor);
        await events(
          await send(
            routes,
            threadId,
            {
              content: 'first',
              clientRequestId: 'first',
              context: { engine: 'plan' },
              model: 'plan',
            },
            actor,
          ),
        );
        const result = await events(
          await send(
            routes,
            threadId,
            {
              content: 'second',
              clientRequestId: 'second',
              context: { engine: 'external' },
            },
            actor,
          ),
        );
        expect(result.thrown).toBeNull();
        expect(
          (await listMessages(routes, threadId, actor)).map((r) => r.content),
        ).toEqual([
          'first',
          `adapter:${actor.user.id}`,
          'second',
          `external:${actor.user.id}:2`,
        ]);
      }
      expect(ai).toHaveBeenCalledTimes(2);
      expect(resolveTurnDriver).toHaveBeenCalledTimes(4);
    });

    it('forwards abort to the external driver and stops even if the driver never settles', async () => {
      let driverSignal: AbortSignal | undefined;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const routes = mount({
        turnDriver: {
          async run(ctx) {
            driverSignal = ctx.signal;
            started();
            await new Promise(() => {});
          },
        },
      });
      const threadId = await createThread(routes);
      const abort = new AbortController();
      const url = new URL(
        `${ORIGIN}/api/assistant/threads/${threadId}/messages`,
      );
      const response = await routes.POST({
        request: new Request(url, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'wait', clientRequestId: 'abort' }),
          signal: abort.signal,
        }),
        url,
        params: { path: `threads/${threadId}/messages` },
        locals: locals(ownerA),
      });
      const result = events(response);
      await ready;
      abort.abort();
      expect((await result).seen).toContainEqual({
        type: 'done',
        stoppedReason: 'cancelled',
      });
      expect(driverSignal?.aborted).toBe(true);
    });

    it('fails closed for unoffered calls and preserves thread ownership', async () => {
      const run = vi.fn(
        async (
          _ctx: AssistantTurnDriverContext,
          cb: AssistantTurnDriverCallbacks,
        ) => {
          await cb.toolCall({ id: 'bad', name: 'private.delete', args: {} });
          cb.done({ text: 'not reached' });
        },
      );
      const routes = mount({ turnDriver: { run } });
      const threadId = await createThread(routes);
      expect(
        (
          await send(
            routes,
            threadId,
            { content: 'steal', clientRequestId: 'foreign' },
            memberB,
          )
        ).status,
      ).toBe(404);
      expect(run).not.toHaveBeenCalled();
      const result = await events(
        await send(routes, threadId, {
          content: 'try',
          clientRequestId: 'deny',
        }),
      );
      expect(result.thrown).toBeTruthy();
      expect(
        result.seen.some(
          (e) => e.type === 'step' && e.step.kind === 'tool_call',
        ),
      ).toBe(false);
      expect(
        (await listMessages(routes, threadId)).every((r) => r.role !== 'tool'),
      ).toBe(true);
    });

    it('emits approval requests, denies without a bridge, and waits for the host decision', async () => {
      const decisions: unknown[] = [];
      const driver = {
        async run(
          _ctx: AssistantTurnDriverContext,
          cb: AssistantTurnDriverCallbacks,
        ) {
          await cb.toolCall({ id: 'c1', name: 'data.discover', args: {} });
          decisions.push(
            await cb.approvalNeeded({
              id: 'approval-1',
              callId: 'c1',
              tool: 'data.discover',
              summary: 'Inspect data',
            }),
          );
          cb.done({ text: 'Decision recorded' });
        },
      };
      const waiter = vi.fn(
        async (
          _request: import('./assistant-turn-events.js').AssistantApprovalRequest,
          ctx: AssistantTurnDriverContext,
        ) => {
          expect(ctx.signal.aborted).toBe(false);
          return { approved: true };
        },
      );
      for (const waitForApproval of [undefined, waiter]) {
        const routes = mount({
          turnDriver: driver,
          waitForApproval,
          allowedTools: ['data.discover'],
          extraTools: [discoverTool([])],
        });
        const threadId = await createThread(routes);
        const result = await events(
          await send(routes, threadId, {
            content: 'inspect',
            clientRequestId: crypto.randomUUID(),
          }),
        );
        expect(result.thrown).toBeNull();
        expect(result.seen).toContainEqual(
          expect.objectContaining({
            type: 'approval_needed',
            approval: expect.objectContaining({ id: 'approval-1' }),
          }),
        );
      }
      expect(decisions).toEqual([
        { approved: false, reason: 'approval_unavailable' },
        { approved: true },
      ]);
      expect(waiter).toHaveBeenCalledTimes(1);
    });
    it('preserves a typed startup cause before storing a user message', async () => {
      const routes = mount({
        resolveTurnDriver() {
          throw new AssistantTurnUserError(
            'Codex needs a writable temporary directory. Reference: test-reference',
            'agent_cli_startup',
          );
        },
      });
      const threadId = await createThread(routes);
      const response = await send(routes, threadId, {
        content: 'hello',
        clientRequestId: 'startup-refusal',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'agent_cli_startup',
        error:
          'Codex needs a writable temporary directory. Reference: test-reference',
      });
      expect(await listMessages(routes, threadId)).toEqual([]);
    });

    it('preserves structured engine status and stores no message when resolution refuses', async () => {
      const routes = mount({
        resolveTurnDriver() {
          throw new InferenceUnavailableError({ reason: 'unconfigured' });
        },
      });
      const threadId = await createThread(routes);
      const response = await send(routes, threadId, {
        content: 'hello',
        clientRequestId: 'unconfigured',
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        type: 'unavailable',
        code: 'ai_unavailable',
        unavailable: { available: false, reason: 'unconfigured' },
      });
      expect(await listMessages(routes, threadId)).toEqual([]);
    });

    it.each([
      'missing_done',
      'unmatched_result',
      'duplicate_call',
    ] as const)('sanitizes malformed driver behavior: %s', async (mode) => {
      const routes = mount({
        allowedTools: ['data.discover'],
        extraTools: [discoverTool([])],
        turnDriver: {
          async run(_ctx, cb) {
            if (mode === 'missing_done') return;
            if (mode === 'unmatched_result')
              await cb.toolResult({
                id: 'missing',
                ok: false,
                error: 'invalid',
              });
            if (mode === 'duplicate_call') {
              const call = { id: 'duplicate', name: 'data.discover', args: {} };
              await cb.toolCall(call);
              await cb.toolCall(call);
            }
            cb.done({ text: 'not reached' });
          },
        },
      });
      const threadId = await createThread(routes);
      const result = await events(
        await send(routes, threadId, {
          content: 'check',
          clientRequestId: 'malformed',
        }),
      );
      expect(result.thrown).toBeTruthy();
      expect(result.seen).toContainEqual(
        expect.objectContaining({ type: 'error', code: 'internal_error' }),
      );
      expect(
        (await listMessages(routes, threadId)).filter((r) => r.toolCallData),
      ).toHaveLength(mode === 'duplicate_call' ? 1 : 0);
    });

    it('stops an approval wait on response-body cancellation and ignores late callbacks', async () => {
      let cb: AssistantTurnDriverCallbacks | undefined;
      let signal: AbortSignal | undefined;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let denied!: (value: unknown) => void;
      const decision = new Promise((resolve) => {
        denied = resolve;
      });
      const routes = mount({
        allowedTools: ['data.discover'],
        extraTools: [discoverTool([])],
        waitForApproval: async () => {
          entered();
          return new Promise(() => {});
        },
        turnDriver: {
          async run(ctx, progress) {
            cb = progress;
            signal = ctx.signal;
            await progress.toolCall({
              id: 'c1',
              name: 'data.discover',
              args: {},
            });
            denied(
              await progress.approvalNeeded({
                id: 'a1',
                callId: 'c1',
                tool: 'data.discover',
                summary: 'Inspect',
              }),
            );
            progress.done({ text: 'too late' });
          },
        },
      });
      const threadId = await createThread(routes);
      const response = await send(routes, threadId, {
        content: 'wait',
        clientRequestId: 'body-abort',
      });
      await ready;
      await response.body?.cancel();
      expect(signal?.aborted).toBe(true);
      expect(await decision).toEqual({ approved: false, reason: 'cancelled' });
      cb?.text('late text');
      cb?.done({ text: 'late final' });
      const rows = await listMessages(routes, threadId);
      expect(rows.map((r) => r.content)).not.toContain('late text');
      expect(rows.map((r) => r.content)).not.toContain('late final');
      expect(rows.map((r) => r.content)).not.toContain('too late');
    });
  });
  async function durableApprovals() {
    const database = await resolveDatabase(db);
    return new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(database),
      async (actor) =>
        actor.id === ownerA.user.id && actor.tenantId === tenantId,
    );
  }

  it('projects native continuation holds into the owned thread without recovery envelopes or duplicate cards', async () => {
    const authority = await durableApprovals();
    let routes = mount({
      approvals: authority,
      allowedTools: ['app.addField'],
      extraTools: [deleteTool([], 'app.addField')],
    });
    const threadId = await createThread(routes);
    const otherThread = await createThread(
      routes,
      ownerA,
      'Other conversation',
    );
    const principal = {
      userId: ownerA.user.id,
      profileId: ownerA.user.profileId,
      tenantId,
    };
    const input = {
      tenantId,
      requestedBy: ownerA.user.id,
      tool: 'app.addField',
      callId: 'private-recovery-call',
      requestKey: 'private-recovery-key',
      args: { internal: 'private-arguments' },
      summary: 'Add Licence plate to Members',
      context: { threadId, principal, designAction: { runId: 'private-run' } },
      continuation: {
        executor: 'fixture',
        principal: {
          id: ownerA.user.id,
          tenantId,
          permissions: [],
          allowedTools: [],
        },
        consumption: 'continuation' as const,
      },
    };
    const hold = await authority.request(input);
    for (const context of [
      { threadId, principal: { ...principal, userId: memberB.user.id } },
      {
        threadId,
        principal: { ...principal, profileId: memberB.user.profileId },
      },
      { threadId, principal: { ...principal, tenantId: otherTenantId } },
      { threadId },
      { threadId: otherThread, principal },
    ])
      await authority.request({
        ...input,
        callId: crypto.randomUUID(),
        requestKey: crypto.randomUUID(),
        context,
      });
    await authority.request({
      ...input,
      requestedBy: memberB.user.id,
      callId: crypto.randomUUID(),
      requestKey: crypto.randomUUID(),
    });
    const rows = await listMessages(routes, threadId);
    expect(rows).toEqual([
      {
        id: `approval:${hold.id}`,
        threadId,
        role: 'tool',
        content: hold.summary,
        createdAt: new Date(hold.createdAt).toISOString(),
        toolCallData: {
          approval: {
            id: hold.id,
            tool: hold.tool,
            callId: hold.id,
            summary: hold.summary,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
          },
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(
      /private-|requestedBy|designAction|permission/,
    );
    const status = await call(routes, 'GET', `threads/${threadId}/approvals`);
    expect((await status.json()).approvals).toHaveLength(1);
    routes = mount({ approvals: await durableApprovals() });
    expect(await listMessages(routes, threadId)).toEqual(rows);
    const revoked = mount({
      approvals: new OwnerApprovalAuthority(
        await createSqliteOwnerApprovalStore(await resolveDatabase(db)),
        async () => false,
      ),
    });
    expect(await listMessages(revoked, threadId)).toEqual([]);
    const memberThread = await createThread(routes, memberB);
    expect(await listMessages(routes, memberThread, memberB)).toEqual([]);
    expect(await listMessages(routes, otherThread)).toHaveLength(1);
    expect(
      (
        await call(routes, 'GET', `threads/${threadId}/messages`, {
          actor: memberB,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call(routes, 'GET', `threads/${threadId}/messages`, {
          actor: ownerAElsewhere,
        })
      ).status,
    ).toBe(404);
    const chat = await ChatService.create({ tenantId, db });
    const [session] = await chat.findActiveAgentSessions({
      tenantId,
      agentId: 'smrt-assistant',
      participantProfileId: ownerA.user.profileId,
    });
    const persisted = await sendAgentReply(chat, {
      tenantId,
      agentSessionId: String(session.id),
      threadId,
      kind: 'tool',
      messageType: 'tool_call',
      content: hold.summary,
      toolCallData: {
        name: 'app.addField',
        approval: {
          id: hold.id,
          tool: hold.tool,
          callId: hold.id,
          summary: hold.summary,
        },
      },
    });
    expect((await listMessages(routes, threadId)).map((row) => row.id)).toEqual(
      [String(persisted.id)],
    );
    const completed = await authority.request({
      ...input,
      callId: 'private-result-call',
      requestKey: 'private-result-key',
    });
    await authority.decide(
      { id: ownerA.user.id, tenantId },
      completed.id,
      true,
    );
    await authority.consume(tenantId, completed.id);
    await authority.complete(tenantId, completed.id, true, {
      args: 'private-result-envelope',
      requestKey: 'private-result-key',
    });
    const finished = await call(routes, 'GET', `threads/${threadId}/approvals`);
    expect(JSON.stringify(await finished.json())).not.toMatch(
      /private-|"result"|"args"/,
    );
    await authority.decide({ id: ownerA.user.id, tenantId }, hold.id, false);
    const terminalRows = await listMessages(routes, threadId);
    expect(terminalRows.map((row) => row.id)).toContain(String(persisted.id));
    expect(terminalRows).toContainEqual(
      expect.objectContaining({
        id: `approval:${completed.id}`,
        toolCallData: {
          approval: expect.objectContaining({
            id: completed.id,
            status: 'succeeded',
          }),
        },
      }),
    );
    expect(
      await listMessages(
        mount({ approvals: await durableApprovals() }),
        threadId,
      ),
    ).toEqual(terminalRows);
  });

  it('projects native holds with continuation-only configuration through the default live-owner authority', async () => {
    const roles = await RoleCollection.create({ db });
    // The route fixture's application role must not impersonate a built-in slug.
    const fixtureRole = await roles.findBySlug('member');
    if (!fixtureRole) throw new Error('Missing fixture role');
    fixtureRole.slug = 'fixture-member';
    await fixtureRole.save();
    await roles.seedSystemRoles();
    const ownerRole = await roles.findSystemRoleBySlug('owner');
    if (!ownerRole?.id) throw new Error('Missing canonical owner role');
    const memberships = await MembershipCollection.create({ db });
    const membership = await memberships.findByUserAndTenant(
      ownerA.user.id,
      tenantId,
    );
    if (!membership) throw new Error('Missing owner fixture membership');
    const originalRole = membership.roleId;
    membership.roleId = ownerRole.id;
    await membership.save();
    const authority = await durableApprovals();
    const routes = mount({
      approvalContinuations: new OwnerApprovalContinuations(authority, {}),
    });
    const threadId = await createThread(routes);
    const hold = await authority.request({
      tenantId,
      requestedBy: ownerA.user.id,
      tool: 'app.addField',
      callId: 'private-default-call',
      args: {},
      summary: 'Add Licence plate',
      context: {
        threadId,
        principal: {
          userId: ownerA.user.id,
          profileId: ownerA.user.profileId,
          tenantId,
        },
      },
      continuation: {
        executor: 'fixture',
        principal: {
          id: ownerA.user.id,
          tenantId,
          permissions: [],
          allowedTools: [],
        },
        consumption: 'continuation',
      },
    });
    const pending = await call(routes, 'GET', `threads/${threadId}/approvals`);
    expect(pending.status).toBe(200);
    expect((await pending.json()).approvals).toHaveLength(1);
    expect(await listMessages(routes, threadId)).toContainEqual(
      expect.objectContaining({
        id: `approval:${hold.id}`,
        toolCallData: {
          approval: expect.objectContaining({
            id: hold.id,
            callId: hold.id,
            status: 'pending',
          }),
        },
      }),
    );
    membership.roleId = originalRole;
    await membership.save();
    expect(await listMessages(routes, threadId)).toEqual([]);
  });

  it('keeps an older unsettled native hold beside the last 200 messages without adding historical terminal holds', async () => {
    const database = await resolveDatabase(db);
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(database),
      async () => true,
      () => Date.now() - 60_000,
    );
    const routes = mount({ approvals: authority });
    const threadId = await createThread(routes);
    const chat = await ChatService.create({ tenantId, db });
    const [session] = await chat.findActiveAgentSessions({
      tenantId,
      agentId: 'smrt-assistant',
      participantProfileId: ownerA.user.profileId,
    });
    const input = {
      tenantId,
      requestedBy: ownerA.user.id,
      tool: 'app.addField',
      callId: 'native-page',
      args: {},
      summary: 'Review field',
      context: {
        threadId,
        principal: {
          userId: ownerA.user.id,
          profileId: ownerA.user.profileId,
          tenantId,
        },
      },
      continuation: {
        executor: 'fixture',
        principal: {
          id: ownerA.user.id,
          tenantId,
          permissions: [],
          allowedTools: [],
        },
        consumption: 'continuation' as const,
      },
    };
    const hold = await authority.request(input);
    const terminal = await authority.request({
      ...input,
      callId: 'terminal-page',
    });
    await authority.decide(
      { id: ownerA.user.id, tenantId },
      terminal.id,
      false,
    );
    for (let i = 0; i < 201; i++)
      await chat.sendMessage({
        tenantId,
        roomId: session.chatRoomId!,
        threadId,
        actorProfileId: ownerA.user.profileId,
        content: `Message ${i}`,
      });
    const rows = await listMessages(routes, threadId);
    expect(rows).toHaveLength(201);
    expect(rows[0].id).toBe(`approval:${hold.id}`);
    expect(rows.filter((row) => row.role === 'user')).toHaveLength(200);
    expect(rows.some((row) => row.id === `approval:${terminal.id}`)).toBe(
      false,
    );
    expect(rows.map((row) => Date.parse(row.createdAt))).toEqual(
      rows.map((row) => Date.parse(row.createdAt)).sort((a, b) => a - b),
    );
    const freshAuthority = await durableApprovals();
    const recent = await freshAuthority.request({
      ...input,
      callId: 'recent-denied',
    });
    await freshAuthority.decide(
      { id: ownerA.user.id, tenantId },
      recent.id,
      false,
    );
    const capped = await listMessages(routes, threadId);
    expect(capped).toHaveLength(201);
    expect(capped.filter((row) => row.role === 'user')).toHaveLength(199);
    expect(capped).toContainEqual(
      expect.objectContaining({
        id: `approval:${recent.id}`,
        toolCallData: {
          approval: expect.objectContaining({ status: 'denied' }),
        },
      }),
    );
    expect(capped.some((row) => row.id === `approval:${terminal.id}`)).toBe(
      false,
    );
  });

  function deleteTool(
    ran: Array<unknown>,
    slug = 'records.delete',
  ): PrincipalTool {
    return {
      slug,
      aiTool: {
        type: 'function',
        function: {
          name: slug.replaceAll('.', '-'),
          description: 'Delete one record',
          parameters: { type: 'object', properties: {} },
        },
      },
      async execute({ run, args }) {
        run.assertToolAllowed(slug);
        ran.push({
          userId: run.context.userId,
          tenantId: run.context.tenantId,
          args,
        });
        return { deleted: args.id };
      },
    };
  }

  it('runs an owner-opted-out built-in chat removal once and persists its human tool result', async () => {
    const ran: unknown[] = [];
    const tool = deleteTool(ran);
    const policy = vi.fn(async () => ({ allowRemovalsInChat: true }));
    const routes = mount({
      ai: scriptedAI([
        calls(['records-delete', { id: 'scratch' }]),
        text('Done.'),
      ]),
      approvals: await durableApprovals(),
      approvalPolicy: policy,
      allowedTools: [tool.slug],
      extraTools: [tool],
    });
    const threadId = await createThread(routes);
    const result = await events(
      await send(routes, threadId, {
        content: 'Delete scratch',
        clientRequestId: crypto.randomUUID(),
      }),
    );
    expect(result.thrown).toBeNull();
    expect(policy).toHaveBeenCalledTimes(1);
    expect(result.seen.some((event) => event.type === 'approval_needed')).toBe(
      false,
    );
    expect(ran).toHaveLength(1);
    expect(
      (await listMessages(routes, threadId)).some(
        (message) => message.content === 'Deleted record',
      ),
    ).toBe(true);
  });
  it('holds a built-in server delete durably, then approves once with the original principal and authors the result', async () => {
    const authority = await durableApprovals();
    const ran: unknown[] = [];
    const tool = deleteTool(ran);
    const ai = scriptedAI([
      () => ({
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'delete-1',
            type: 'function',
            function: {
              name: 'records-delete',
              arguments: JSON.stringify({ id: 'invoice-1', approved: true }),
            },
          },
        ],
      }),
    ]);
    const options = {
      ai,
      approvals: authority,
      allowedTools: [tool.slug],
      extraTools: [tool],
    };
    let routes = mount(options);
    const threadId = await createThread(routes);
    const result = await events(
      await send(routes, threadId, {
        content: 'Delete invoice 1',
        clientRequestId: crypto.randomUUID(),
      }),
    );
    expect(result.thrown).toBeNull();
    expect(ran).toEqual([]);
    expect(
      result.seen.some(
        (event) =>
          event.type === 'step' &&
          event.step.kind === 'tool_result' &&
          event.step.tool === 'records.delete',
      ),
    ).toBe(false);
    expect(result.seen).toContainEqual(
      expect.objectContaining({ type: 'done', stoppedReason: 'approval' }),
    );
    const needed = result.seen.find(
      (event) => event.type === 'approval_needed',
    );
    if (needed?.type !== 'approval_needed') throw new Error('expected hold');
    expect(
      (await listMessages(routes, threadId)).some(
        (message) =>
          (message.toolCallData as { approval?: { id: string } })?.approval
            ?.id === needed.approval.id,
      ),
    ).toBe(true);
    // A new route instance/authority must recover the saved arguments and thread.
    routes = mount({ ...options, approvals: await durableApprovals() });
    const listing = await call(routes, 'GET', `threads/${threadId}/approvals`);
    expect((await listing.json()).approvals).toContainEqual(
      expect.objectContaining({ id: needed.approval.id, status: 'pending' }),
    );
    const decision = await call(
      routes,
      'POST',
      `approvals/${needed.approval.id}/decide`,
      { body: { approve: true, args: { id: 'another-invoice' } } },
    );
    expect(decision.status).toBe(200);
    expect((await decision.json()).approval.status).toBe('succeeded');
    expect(ran).toEqual([
      {
        userId: ownerA.user.id,
        tenantId,
        args: { id: 'invoice-1', approved: true },
      },
    ]);
    expect(
      (await listMessages(routes, threadId)).some(
        (message) =>
          message.content === 'Deleted record' &&
          (message.toolCallData as { label?: string })?.label ===
            'Deleted record',
      ),
    ).toBe(true);
    expect(
      (
        await call(routes, 'POST', `approvals/${needed.approval.id}/decide`, {
          body: { approve: true },
        })
      ).status,
    ).toBe(409);
    expect(ran).toHaveLength(1);
  });

  it.each([
    'disabled',
    'unreadable',
  ] as const)('refuses a saved manifest delete after its cookbook becomes %s without expanding the approval projection', async (state) => {
    const model = '@happyvertical/smrt-profiles:Profile';
    const catalog = {
      models: [
        { id: model, name: 'Profile', packageId: 'profiles', exposed: true },
      ],
      recipes: [],
    };
    const engine = createCookbookEngine({ catalog });
    expect(
      engine.run({ name: 'add_features', input: { ids: [model] } }).ok,
    ).toBe(true);
    let readable = true;
    const gate = createCookbookRuntimeExposure({
      catalog,
      engineFor: ({ tenantId: requested }) =>
        requested === tenantId && readable ? engine : null,
    });
    const collection = await ObjectRegistry.getCollection(model, { db });
    const types = await ObjectRegistry.getCollection(
      '@happyvertical/smrt-profiles:ProfileType',
      { db },
    );
    const profileType = await types.create({ name: 'Held type' });
    const profile = await collection.create({
      name: 'Held record',
      typeId: profileType.id,
    });
    await profile.save();
    const membership = await (
      await MembershipCollection.create({ db })
    ).findByUserAndTenant(ownerA.user.id, tenantId);
    if (!membership) throw new Error('missing membership');
    const permission = await (await PermissionCollection.create({ db })).create(
      { slug: 'profiles.delete', name: 'Delete profiles' },
    );
    await permission.save();
    await (await RolePermissionCollection.create({ db })).addPermission(
      membership.roleId,
      String(permission.id),
    );
    const authority = await durableApprovals();
    const routes = mount({
      approvals: authority,
      allowedTools: ['profiles.delete'],
      tools: [
        {
          slug: 'profiles.delete',
          collection: 'profiles',
          className: 'Profile',
          qualifiedName: model,
          action: 'delete',
        },
      ],
      ai: scriptedAI([
        () => ({
          content: '',
          toolCalls: [
            {
              id: 'disabled-hold',
              type: 'function',
              function: {
                name: 'profiles-delete',
                arguments: JSON.stringify({ id: profile.id }),
              },
            },
          ],
        }),
      ]),
    });
    setRuntimeExposureGate(gate);
    try {
      const threadId = await createThread(routes);
      const turn = await events(
        await send(routes, threadId, {
          content: 'Delete',
          clientRequestId: crypto.randomUUID(),
        }),
      );
      expect(turn.seen).toContainEqual(
        expect.objectContaining({ type: 'done', stoppedReason: 'approval' }),
      );
      const [record] = await authority.list({ id: ownerA.user.id, tenantId });
      expect(record).toBeDefined();
      const before = (await (await call(routes, 'GET', 'approvals')).json())
        .approvals;
      if (state === 'disabled') {
        expect(
          engine.run({ name: 'remove_features', input: { ids: [model] } }).ok,
        ).toBe(true);
      } else readable = false;
      for (const path of ['approvals', `threads/${threadId}/approvals`]) {
        const listing = (await (await call(routes, 'GET', path)).json())
          .approvals;
        expect(listing).toEqual(before);
        expect(Object.keys(listing[0]).sort()).toEqual(
          [
            'id',
            'tool',
            'callId',
            'summary',
            'status',
            'decidedBy',
            'decidedAt',
          ].sort(),
        );
      }
      const response = await call(
        routes,
        'POST',
        `approvals/${record.id}/decide`,
        { body: { approve: true } },
      );
      expect(response.status).toBe(200);
      expect((await response.json()).approval.status).toBe('failed');
      // A new authority recovers a terminal refusal, not a replayable effect.
      expect(
        await (await durableApprovals()).get(tenantId, record.id),
      ).toMatchObject({ status: 'failed', result: { status: 'refused' } });
      expect(await collection.get(String(profile.id))).not.toBeNull();
      expect(
        (await listMessages(routes, threadId)).some(
          (message) =>
            (message.toolCallData as { status?: string })?.status === 'refused',
        ),
      ).toBe(true);
      expect(
        (
          await call(routes, 'POST', `approvals/${record.id}/decide`, {
            body: { approve: true },
          })
        ).status,
      ).toBe(409);
    } finally {
      setRuntimeExposureGate(undefined);
      gate.dispose();
    }
  });

  it('denies without execution, refuses non-owners, foreign tenants, foreign origins and malformed decisions', async () => {
    const authority = await durableApprovals();
    const ran: unknown[] = [];
    const tool = deleteTool(ran);
    const routes = mount({
      approvals: authority,
      allowedTools: [tool.slug],
      extraTools: [tool],
      ai: scriptedAI([
        () => ({
          content: '',
          toolCalls: [
            {
              id: 'delete-2',
              type: 'function',
              function: {
                name: 'records-delete',
                arguments: '{"id":"invoice-2"}',
              },
            },
          ],
        }),
      ]),
    });
    const threadId = await createThread(routes);
    await events(
      await send(routes, threadId, {
        content: 'Delete invoice 2',
        clientRequestId: crypto.randomUUID(),
      }),
    );
    const [record] = await authority.list({ id: ownerA.user.id, tenantId });
    const path = `approvals/${record.id}/decide`;
    expect(
      (
        await call(routes, 'POST', path, {
          actor: memberB,
          body: { approve: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(routes, 'POST', path, {
          actor: ownerAElsewhere,
          body: { approve: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(routes, 'POST', path, {
          body: { approve: true },
          origin: 'https://attacker.test',
        })
      ).status,
    ).toBe(403);
    expect(
      (await call(routes, 'POST', path, { body: { approve: 'yes' } })).status,
    ).toBe(400);
    expect(
      (await call(routes, 'POST', path, { body: { approve: false } })).status,
    ).toBe(200);
    expect(ran).toEqual([]);
    expect(
      (await listMessages(routes, threadId)).some((message) =>
        message.content.includes('owner denied'),
      ),
    ).toBe(true);
    expect(
      (await call(routes, 'POST', path, { body: { approve: true } })).status,
    ).toBe(409);
  });

  it.each([
    'enabled',
    'disabled',
    'unreadable',
  ] as const)('resolves an external-driver wait from the same durable authority with a %s model', async (state) => {
    let enabled = true;
    let readable = true;
    setRuntimeExposureGate({
      isEnabled() {
        if (!readable) throw new Error('unreadable');
        return enabled;
      },
    });
    const authority = await durableApprovals();
    let requestId: string | undefined;
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const ran: unknown[] = [];
    const routes = mount({
      approvals: authority,
      allowedTools: ['profiles.delete'],
      tools: [
        {
          slug: 'profiles.delete',
          className: 'Profile',
          qualifiedName: '@happyvertical/smrt-profiles:Profile',
          collection: 'profiles',
          action: 'delete',
        },
      ],
      turnDriver: {
        async run(ctx, cb) {
          await cb.toolCall({
            id: 'external-delete',
            name: 'profiles.delete',
            args: { id: 'invoice-3' },
          });
          const decision = cb.approvalNeeded({
            id: 'engine-cannot-select-id',
            callId: 'external-delete',
            tool: 'profiles.delete',
            summary: 'engine text is not authority',
          });
          // Signal after the request is durably visible; the caller reads the live SSE concurrently.
          const poll = async () => {
            const records = await authority.list({
              id: ownerA.user.id,
              tenantId,
            });
            if (records[0]) {
              requestId = records[0].id;
              ready();
            } else
              setTimeout(() => {
                void poll();
              }, 10);
          };
          void poll();
          const allowed = await decision;
          if (allowed.approved)
            ran.push({ userId: ctx.principal.runAsUserId, id: 'invoice-3' });
          await cb.toolResult({
            id: 'external-delete',
            ok: allowed.approved,
            result: allowed.approved ? 'deleted invoice-3' : 'owner refused',
          });
          cb.done({ text: 'Decision handled.' });
        },
      },
    });
    const threadId = await createThread(routes);
    const response = await send(routes, threadId, {
      content: 'Delete 3',
      clientRequestId: crypto.randomUUID(),
    });
    const streamResult = events(response);
    await waiting;
    expect(ran).toEqual([]);
    expect(requestId).not.toBe('engine-cannot-select-id');
    enabled = state !== 'disabled';
    readable = state !== 'unreadable';
    const decide = await call(routes, 'POST', `approvals/${requestId}/decide`, {
      body: { approve: true },
    });
    expect(decide.status).toBe(200);
    expect((await streamResult).thrown).toBeNull();
    expect(ran).toEqual(
      state === 'enabled' ? [{ userId: ownerA.user.id, id: 'invoice-3' }] : [],
    );
    expect(await authority.get(tenantId, requestId!)).toMatchObject(
      state === 'enabled'
        ? {
            status: 'succeeded',
          }
        : { status: 'failed', result: { status: 'refused' } },
    );
    expect(
      (await listMessages(routes, threadId)).some(
        (message) => message.content === 'Deleted profile',
      ),
    ).toBe(state === 'enabled');
    setRuntimeExposureGate(undefined);
  });

  it('keeps reads immediate and supports host per-tool and per-operation approval policy', async () => {
    const authority = await durableApprovals();
    const ran: unknown[] = [];
    const tool = deleteTool(ran, 'records.update');
    const routes = mount({
      approvals: authority,
      allowedTools: [tool.slug],
      extraTools: [tool],
      approvalPolicy: { tools: { 'records.update': true } },
      ai: scriptedAI([
        () => ({
          content: '',
          toolCalls: [
            {
              id: 'update-1',
              type: 'function',
              function: {
                name: 'records-update',
                arguments: '{"id":"invoice-4"}',
              },
            },
          ],
        }),
      ]),
    });
    const threadId = await createThread(routes);
    await events(
      await send(routes, threadId, {
        content: 'Update',
        clientRequestId: crypto.randomUUID(),
      }),
    );
    expect(ran).toEqual([]);
    expect(await authority.list({ id: ownerA.user.id, tenantId })).toHaveLength(
      1,
    );
  });
  it('refuses a tool removed from the live host offering after approval was requested', async () => {
    const authority = await durableApprovals();
    const ran: unknown[] = [];
    const tool = deleteTool(ran);
    let allowed = [tool.slug];
    const routes = mount({
      approvals: authority,
      allowedTools: () => allowed,
      extraTools: [tool],
      ai: scriptedAI([
        () => ({
          content: '',
          toolCalls: [
            {
              id: 'revoked',
              type: 'function',
              function: {
                name: 'records-delete',
                arguments: '{"id":"revoked-invoice"}',
              },
            },
          ],
        }),
      ]),
    });
    const threadId = await createThread(routes);
    await events(
      await send(routes, threadId, {
        content: 'Delete',
        clientRequestId: crypto.randomUUID(),
      }),
    );
    const [record] = await authority.list({ id: ownerA.user.id, tenantId });
    allowed = [];
    const response = await call(
      routes,
      'POST',
      `approvals/${record.id}/decide`,
      { body: { approve: true } },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).approval.status).toBe('failed');
    expect(ran).toEqual([]);
    expect(await authority.get(tenantId, record.id)).toMatchObject({
      status: 'failed',
    });
  });
  it('allows a tenant owner to approve a colleague hold while executing as that colleague', async () => {
    const authority = await durableApprovals();
    const ran: unknown[] = [];
    const tool = deleteTool(ran);
    const routes = mount({
      approvals: authority,
      allowedTools: [tool.slug],
      extraTools: [tool],
      ai: scriptedAI([
        () => ({
          content: '',
          toolCalls: [
            {
              id: 'colleague',
              type: 'function',
              function: {
                name: 'records-delete',
                arguments: '{"id":"colleague-invoice"}',
              },
            },
          ],
        }),
      ]),
    });
    const threadId = await createThread(routes, memberB);
    await events(
      await send(
        routes,
        threadId,
        { content: 'Delete', clientRequestId: crypto.randomUUID() },
        memberB,
      ),
    );
    expect(
      (await call(routes, 'GET', 'approvals', { actor: memberB })).status,
    ).toBe(403);
    const listing = await call(routes, 'GET', 'approvals');
    expect(listing.status).toBe(200);
    const [record] = (await listing.json()).approvals;
    expect(record).not.toHaveProperty('context');
    const response = await call(
      routes,
      'POST',
      `approvals/${record.id}/decide`,
      { body: { approve: true } },
    );
    expect(response.status).toBe(200);
    expect(ran).toEqual([
      { userId: memberB.user.id, tenantId, args: { id: 'colleague-invoice' } },
    ]);
    expect(
      (await listMessages(routes, threadId, memberB)).some(
        (message) =>
          message.content === 'Deleted record' &&
          (message.toolCallData as { label?: string })?.label ===
            'Deleted record',
      ),
    ).toBe(true);
    expect(
      (await call(routes, 'GET', `threads/${threadId}/messages`)).status,
    ).toBe(404);
  });
  it.each([
    'revoke',
    'grant',
  ] as const)('keeps the captured permission ceiling when permissions change: %s', async (change) => {
    const authority = await durableApprovals();
    const permissions = await PermissionCollection.create({ db });
    const grants = await RolePermissionCollection.create({ db });
    const membership = await (
      await MembershipCollection.create({ db })
    ).findByUserAndTenant(ownerA.user.id, tenantId);
    if (!membership) throw new Error('missing fixture membership');
    const permission = await permissions.create({
      slug: 'profiles.read',
      name: 'Read profiles',
    });
    await permission.save();
    if (change === 'revoke')
      await grants.addPermission(membership.roleId, String(permission.id));
    const ran = vi.fn();
    const tool = deleteTool([]);
    tool.execute = async ({ run }) => {
      await run.assertOperation('profiles', 'read');
      ran();
      return { deleted: true };
    };
    const routes = mount({
      approvals: authority,
      allowedTools: [tool.slug],
      extraTools: [tool],
      ai: scriptedAI([
        () => ({
          content: '',
          toolCalls: [
            {
              id: 'permission-change',
              type: 'function',
              function: {
                name: 'records-delete',
                arguments: '{"id":"invoice-permission"}',
              },
            },
          ],
        }),
      ]),
    });
    const threadId = await createThread(routes);
    await events(
      await send(routes, threadId, {
        content: 'Delete',
        clientRequestId: crypto.randomUUID(),
      }),
    );
    const [record] = await authority.list({ id: ownerA.user.id, tenantId });
    if (change === 'revoke')
      await grants.removePermission(membership.roleId, String(permission.id));
    else await grants.addPermission(membership.roleId, String(permission.id));
    const response = await call(
      routes,
      'POST',
      `approvals/${record.id}/decide`,
      { body: { approve: true } },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).approval.status).toBe('failed');
    expect(ran).not.toHaveBeenCalled();
  });
});
