/**
 * Task lifecycle calls honour the catalog's effect filter (#3373 combined
 * review D2). A task created by a destructive task tool through an
 * unrestricted route must be an unknown task to every lifecycle method of a
 * route restricted to read effects, even with the same principal, tenant,
 * database and task id. The per-tool policy is not re-applied to lifecycle
 * calls; see `assertTaskToolVisible` in server.ts.
 */

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
} from '@happyvertical/smrt-jobs';
import { TaskRunner } from '@happyvertical/smrt-jobs/runner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CreateMcpAppServerOptions,
  createMcpAppServer,
  type McpAppPrincipal,
} from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';
import { mcpToolEffect } from '../tools.js';

@smrt({ mcp: { include: ['purge'], tasks: ['purge'] } })
class LaneTaskVault extends SmrtObject {
  name = '';

  /** Destructive, input-required task action. */
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
class LaneTaskVaultCollection extends SmrtCollection<LaneTaskVault> {
  static readonly _itemClass = LaneTaskVault;
}

const principal: McpAppPrincipal = { id: 'principal-a', tenantId: 'tenant-a' };
const TOOL = 'lanetaskvault_purge';

function event(method: string, params: Record<string, unknown>) {
  const url = new URL('https://example.com/api/mcp');
  return {
    locals: {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
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
            'io.modelcontextprotocol/clientInfo': { name: 'd2', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {
              extensions: { 'io.modelcontextprotocol/tasks': {} },
            },
          },
        },
      }),
    }),
  };
}

let db: Awaited<ReturnType<typeof getTestDatabase>>;
let vaultId = '';
let runner: TaskRunner;

function route(extra: Partial<CreateMcpAppServerOptions> = {}) {
  return mountMcpRoute(
    createMcpAppServer({
      smrtOptions: () => ({ db }),
      serverInfo: { name: 'd2', version: '0' },
      allowedClassNames: ['LaneTaskVault'],
      ...extra,
    }),
    { resolvePrincipal: () => principal },
  );
}

async function json(response: Response) {
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

async function waitFor(
  handler: ReturnType<typeof route>,
  taskId: string,
  status: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const body = await json(await handler(event('tasks/get', { taskId })));
    if (body.result?.status === status) return body.result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${status}`);
}

beforeAll(async () => {
  ObjectRegistry.registerCollection('LaneTaskVault', LaneTaskVaultCollection);
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['LaneTaskVault', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
  });
  const vault = await (await LaneTaskVaultCollection.create({ db })).create({
    name: 'vault',
  });
  vaultId = vault.id as string;
  runner = new TaskRunner({
    authorizeMcpTask: async (authority) =>
      authority.ownerId === JSON.stringify(['tenant-a', 'principal-a']) &&
      authority.tenantId === 'tenant-a',
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

describe('task lifecycle under a restricted catalog', () => {
  it('treats a destructive task as unknown on a read-only route and keeps it on the unrestricted one', async () => {
    const unrestricted = route();
    const readOnly = route({ effects: ['read'] });

    const tools = await createMcpAppServer({
      smrtOptions: () => ({ db }),
      serverInfo: { name: 'd2', version: '0' },
      allowedClassNames: ['LaneTaskVault'],
    }).listTools({ principal });
    const purge = tools.find((tool) => tool.name === TOOL)!;
    expect(purge).toBeDefined();
    expect(mcpToolEffect(purge)).not.toBe('read');

    const created = await json(
      await unrestricted(
        event('tools/call', {
          name: TOOL,
          arguments: { id: vaultId, _options: {} },
        }),
      ),
    );
    const taskId = created.result?.taskId as string;
    expect(taskId).toBeTruthy();
    await waitFor(unrestricted, taskId, 'input_required');

    for (const restricted of [readOnly]) {
      for (const [method, params] of [
        ['tasks/get', { taskId }],
        ['tasks/update', { taskId, inputResponses: { confirm: 'purge' } }],
        ['tasks/cancel', { taskId }],
      ] as const) {
        const body = await json(await restricted(event(method, params)));
        expect(body.error).toMatchObject({
          code: -32602,
          message: 'Unknown MCP task.',
        });
      }
    }
    // Identical to a task id that never existed.
    expect(
      (await json(await readOnly(event('tasks/get', { taskId: 'nope' }))))
        .error,
    ).toMatchObject({ code: -32602, message: 'Unknown MCP task.' });

    // Nothing above changed the task: the unrestricted route still sees it
    // waiting, and can resume and complete it.
    expect(
      (await json(await unrestricted(event('tasks/get', { taskId })))).result,
    ).toMatchObject({ status: 'input_required' });
    expect(
      (
        await json(
          await unrestricted(
            event('tasks/update', {
              taskId,
              inputResponses: { confirm: 'purge' },
            }),
          ),
        )
      ).result,
    ).toEqual({ resultType: 'complete' });
    await waitFor(unrestricted, taskId, 'completed');
  });

  it('still lets the unrestricted route cancel its own task', async () => {
    const unrestricted = route();
    const created = await json(
      await unrestricted(
        event('tools/call', {
          name: TOOL,
          arguments: { id: vaultId, _options: {} },
        }),
      ),
    );
    const taskId = created.result?.taskId as string;
    await waitFor(unrestricted, taskId, 'input_required');
    expect(
      (await json(await unrestricted(event('tasks/cancel', { taskId }))))
        .result,
    ).toEqual({ resultType: 'complete' });
    await waitFor(unrestricted, taskId, 'cancelled');
  });
});
