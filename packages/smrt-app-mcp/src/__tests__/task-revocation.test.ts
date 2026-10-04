/**
 * Task lifecycle calls are gated by the effective bound principal
 * (#3373 combined review E1). A bearer principal whose live permissions were
 * revoked (the binder hands back empty effective scopes) must not read,
 * resume or cancel its existing task; restoring the permission restores
 * access. The check is principal-level, so it needs no originating tool.
 *
 * Isolation: the binder's narrowing is isolation-independent — under
 * `database-rls` it also opens the principal's RLS transaction, under
 * `application` it does not, but the scopes it hands dispatch are the same.
 * Both shapes are exercised below (`rls` runs dispatch inside a recorded
 * request-database scope; `application` does not).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  type JobExecutionContext,
  McpTaskStore,
  TaskRunner,
} from '@happyvertical/smrt-jobs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAppServer, type McpAppPrincipal } from '../server.js';
import {
  type McpRouteResourceAuth,
  mountMcpAppRoute,
  mountMcpRoute,
} from '../sveltekit.js';

@smrt({ mcp: { include: ['purge'], tasks: ['purge'] } })
class LaneRevocableVault extends SmrtObject {
  name = '';

  @backgroundEligible()
  async purge(
    _options: Record<string, never>,
    context?: JobExecutionContext,
  ): Promise<{ confirmed: unknown }> {
    const response = await context?.task?.requestInput({
      confirm: { type: 'string', description: 'Type purge to confirm' },
    });
    return { confirmed: response?.confirm };
  }
}
class LaneRevocableVaultCollection extends SmrtCollection<LaneRevocableVault> {
  static readonly _itemClass = LaneRevocableVault;
}

const SCOPE = 'vault.purge';
const TOOL = 'lanerevocablevault_purge';
const bearer = {
  id: 'bearer-user',
  tenantId: 'tenant-a',
  kind: 'human',
  scopes: [SCOPE],
};
const ownerId = JSON.stringify(['tenant-a', 'bearer-user']);

let db: Awaited<ReturnType<typeof getTestDatabase>>;
let vaultId = '';
let runner: TaskRunner;
/** The principal's live permissions; revocation empties it. */
let live = new Set<string>([SCOPE]);
const requestDatabase = new AsyncLocalStorage<string>();

const auth: McpRouteResourceAuth = {
  metadataUrl:
    'https://app.example/.well-known/oauth-protected-resource/api/mcp',
  metadataResponse: () => Response.json({}),
  authenticate: async () => ({ ok: true, principal: { ...bearer } }),
};

/** Mirrors `runtime.runAsPrincipal`: effective scopes = token ∩ live. */
function binder(isolation: 'rls' | 'application') {
  return async <T>(
    principal: McpAppPrincipal & { id: string },
    run: (bound?: McpAppPrincipal & { id: string }) => Promise<T>,
  ): Promise<T> => {
    const effective = {
      ...principal,
      scopes: (principal.scopes ?? []).filter((scope) => live.has(scope)),
    };
    return isolation === 'rls'
      ? requestDatabase.run(`tx:${principal.id}`, () => run(effective))
      : run(effective);
  };
}

function route(isolation: 'rls' | 'application') {
  return mountMcpAppRoute({
    models: [LaneRevocableVault],
    requiredScopes: [SCOPE],
    smrtOptions: () => ({ db }),
    auth,
    bindPrincipal: binder(isolation),
  });
}

function event(method: string, params: Record<string, unknown>) {
  const url = new URL('https://app.example/api/mcp');
  return {
    locals: {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        authorization: 'Bearer token',
        ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': { name: 'e1', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { 'io.modelcontextprotocol/tasks': {} },
            },
          },
        },
      }),
    }),
  };
}

async function json(response: Response) {
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

/** Task status straight from the store, bypassing the route under test. */
async function storedStatus(taskId: string) {
  const store = await McpTaskStore.create(db, {
    ownerId,
    tenantId: 'tenant-a',
    requireAuthorization: true,
  });
  return (await store.getTask(taskId)).status;
}

async function waitStored(taskId: string, status: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await storedStatus(taskId)) === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

async function createWaitingTask(handler: ReturnType<typeof route>) {
  const created = await json(
    await handler(
      event('tools/call', {
        name: TOOL,
        arguments: { id: vaultId, _options: {} },
      }),
    ),
  );
  const taskId = created.result?.taskId as string;
  expect(taskId).toBeTruthy();
  await waitStored(taskId, 'input_required');
  return taskId;
}

const UNKNOWN = { code: -32602, message: 'Unknown MCP task.' };

beforeAll(async () => {
  ObjectRegistry.registerCollection(
    'LaneRevocableVault',
    LaneRevocableVaultCollection,
  );
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['LaneRevocableVault', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
  });
  vaultId = (
    await (
      await LaneRevocableVaultCollection.create({ db })
    ).create({
      name: 'vault',
    })
  ).id as string;
  runner = new TaskRunner({
    authorizeMcpTask: async (authority) =>
      authority.ownerId === ownerId && authority.tenantId === 'tenant-a',
    queues: ['mcp-tasks'],
    pollInterval: 5,
    concurrency: 1,
  });
  await runner.initialize(db);
  await runner.start();
});
afterAll(async () => {
  await runner?.stop();
  await db?.close?.();
});

describe.each([
  'rls',
  'application',
] as const)('task lifecycle after live revocation (%s isolation shape)', (isolation) => {
  it('hides get/update from a revoked principal, keeps the task suspended, and restores access', async () => {
    live = new Set([SCOPE]);
    const handler = route(isolation);
    const taskId = await createWaitingTask(handler);

    live = new Set();
    for (const [method, params] of [
      ['tasks/get', { taskId }],
      ['tasks/update', { taskId, inputResponses: { confirm: 'purge' } }],
    ] as const) {
      expect((await json(await handler(event(method, params)))).error).toEqual(
        expect.objectContaining(UNKNOWN),
      );
    }
    // The awaited input was never delivered: the destructive work is still
    // suspended, not resumed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storedStatus(taskId)).toBe('input_required');

    live = new Set([SCOPE]);
    expect(
      (await json(await handler(event('tasks/get', { taskId })))).result,
    ).toMatchObject({ status: 'input_required' });
    expect(
      (
        await json(
          await handler(
            event('tasks/update', {
              taskId,
              inputResponses: { confirm: 'purge' },
            }),
          ),
        )
      ).result,
    ).toEqual({ resultType: 'complete' });
    await waitStored(taskId, 'completed');
  });

  it('hides cancel from a revoked principal and restores it', async () => {
    live = new Set([SCOPE]);
    const handler = route(isolation);
    const taskId = await createWaitingTask(handler);

    live = new Set();
    expect(
      (await json(await handler(event('tasks/cancel', { taskId })))).error,
    ).toEqual(expect.objectContaining(UNKNOWN));
    expect(await storedStatus(taskId)).toBe('input_required');

    live = new Set([SCOPE]);
    expect(
      (await json(await handler(event('tasks/cancel', { taskId })))).result,
    ).toEqual({ resultType: 'complete' });
    expect(await storedStatus(taskId)).toBe('cancelled');
  });
});

describe('custom createMcpAppServer lifecycle hook', () => {
  it('lets a custom server gate lifecycle calls with a principal-level predicate', async () => {
    live = new Set([SCOPE]);
    const taskId = await createWaitingTask(route('application'));
    let allowed = false;
    const custom = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'custom', version: '0' },
        allowedClassNames: ['LaneRevocableVault'],
        toolPolicy: () => true,
        taskPrincipalPolicy: ({ principal }) =>
          allowed && principal?.id === 'bearer-user',
      }),
      { auth },
    );
    expect(
      (await json(await custom(event('tasks/get', { taskId })))).error,
    ).toEqual(expect.objectContaining(UNKNOWN));
    allowed = true;
    expect(
      (await json(await custom(event('tasks/get', { taskId })))).result,
    ).toMatchObject({ status: 'input_required' });

    // A throwing predicate fails closed with the same answer.
    const throwing = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'custom', version: '0' },
        allowedClassNames: ['LaneRevocableVault'],
        taskPrincipalPolicy: () => {
          throw new Error('policy store offline');
        },
      }),
      { auth },
    );
    const denied = await json(await throwing(event('tasks/get', { taskId })));
    expect(denied.error).toEqual(expect.objectContaining(UNKNOWN));
    expect(JSON.stringify(denied)).not.toContain('offline');

    // Without the hook a custom server keeps today's lifecycle behaviour.
    const unhooked = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'custom', version: '0' },
        allowedClassNames: ['LaneRevocableVault'],
        toolPolicy: () => false,
      }),
      { auth },
    );
    expect(
      (await json(await unhooked(event('tasks/get', { taskId })))).result,
    ).toMatchObject({ status: 'input_required' });
    await custom(event('tasks/cancel', { taskId }));
  });
});
