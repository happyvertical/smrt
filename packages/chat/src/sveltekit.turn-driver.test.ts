/**
 * External driver contract matrix (in-process SQLite; engines are fakes).
 * Send route: trusted actor/thread -> text + tools authored and streamed; foreign actor -> 404.
 * Resolution: per-user/request driver or model adapter; history and system guidance retained.
 * Failure: upstream error -> safe partial/error rows; unoffered call -> no tool row.
 * Abort: request signal -> driver cancellation even while run is pending.
 * Approval: missing host -> deny; host -> awaited decision + wire event.
 * No new SQL operations: ChatService owns its existing transaction/dialect behavior.
 * Commands: package test/typecheck/build; root lint/format-check/knowledge:check --strict.
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
import { InferenceUnavailableError } from '@happyvertical/smrt-core/inference-availability';
import {
  MembershipCollection,
  RoleCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantTurnDriverCallbacks,
  AssistantTurnDriverContext,
} from './assistant-turn-driver.js';
import {
  type AssistantTurnEvent,
  readAssistantTurnStream,
} from './assistant-turn-events.js';
import { ChatService } from './services/index.js';
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

describe('external assistant turn drivers', () => {
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
        expect(ctx.extraTools.map((tool: PrincipalTool) => tool.slug)).toEqual([
          'data.discover',
        ]);
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
      'data discover',
      'articles',
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

  it('persists partial output and a safe error before the error reaches the stream', async () => {
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
      'data discover',
      'not_found',
      'Partial answer',
      'The assistant ran into a problem. Please try again.',
    ]);
    expect(JSON.stringify(result.seen)).not.toContain('secret provider detail');
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
    const url = new URL(`${ORIGIN}/api/assistant/threads/${threadId}/messages`);
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
      await send(routes, threadId, { content: 'try', clientRequestId: 'deny' }),
    );
    expect(result.thrown).toBeTruthy();
    expect(
      result.seen.some((e) => e.type === 'step' && e.step.kind === 'tool_call'),
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
            await cb.toolResult({ id: 'missing', ok: false, error: 'invalid' });
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
