/**
 * Scopes and the confirm gate on generated (task) tools, including the
 * lifecycle re-check of the originating tool's scopes.
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
  TaskRunner,
} from '@happyvertical/smrt-jobs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInMemoryMcpAuditSink } from '../audit.js';
import {
  type CreateMcpAppServerOptions,
  createMcpAppServer,
  type McpAppPrincipal,
} from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';

@smrt({ mcp: { include: ['purge'], tasks: ['purge'] } })
class ScopedTaskVault extends SmrtObject {
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
class ScopedTaskVaultCollection extends SmrtCollection<ScopedTaskVault> {
  static readonly _itemClass = ScopedTaskVault;
}

let principal: McpAppPrincipal = {
  id: 'principal-a',
  tenantId: 'tenant-a',
  scopes: ['vault.purge'],
};
const TOOL = 'scopedtaskvault_purge';

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
      allowedClassNames: ['ScopedTaskVault'],
      toolScopes: { [TOOL]: ['vault.purge'] },
      confirmTools: [TOOL],
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
  ObjectRegistry.registerCollection(
    'ScopedTaskVault',
    ScopedTaskVaultCollection,
  );
  db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['ScopedTaskVault', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
  });
  const vault = await (await ScopedTaskVaultCollection.create({ db })).create({
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

describe('generated tools: scopes, confirm and task lifecycle', () => {
  it('gates the generated task tool on confirm, strips it, and re-checks scopes on lifecycle calls', async () => {
    principal = { ...principal, scopes: ['vault.purge'] };
    const sink = createInMemoryMcpAuditSink();
    const app = createMcpAppServer({
      smrtOptions: () => ({ db }),
      serverInfo: { name: 'd2', version: '0' },
      allowedClassNames: ['ScopedTaskVault'],
      toolScopes: { [TOOL]: ['vault.purge'] },
      confirmTools: [TOOL],
      auditSink: sink,
    });

    // callTask: refused without confirm, audited as denied.
    const refused = await app.callTask({
      name: TOOL,
      arguments: { id: vaultId, _options: {} },
      principal,
    });
    expect(refused.isError).toBe(true);
    expect(sink.records.at(-1)).toMatchObject({
      outcome: 'denied',
      errorCode: 'confirm_required',
    });

    // callTask: scope missing is a 403 before anything runs.
    await expect(
      app.callTask({
        name: TOOL,
        arguments: { id: vaultId, _options: {}, confirm: true },
        principal: { ...principal, scopes: [] },
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Confirmed call creates the task; `confirm` is consumed, not forwarded.
    const handler = route();
    const created = await json(
      await handler(
        event('tools/call', {
          name: TOOL,
          arguments: { id: vaultId, _options: {}, confirm: true },
        }),
      ),
    );
    const taskId = created.result?.taskId as string;
    expect(taskId).toBeTruthy();
    await waitFor(handler, taskId, 'input_required');

    // Narrowed credential: every lifecycle call sees an unknown task.
    principal = { ...principal, scopes: [] };
    for (const [method, params] of [
      ['tasks/get', { taskId }],
      ['tasks/update', { taskId, inputResponses: { confirm: 'purge' } }],
      ['tasks/cancel', { taskId }],
    ] as const) {
      expect(
        (await json(await handler(event(method, params)))).error,
      ).toMatchObject({
        code: -32602,
        message: 'Unknown MCP task.',
      });
    }

    // Restored scopes can still finish the task.
    principal = { ...principal, scopes: ['vault.purge'] };
    expect(
      (await json(await handler(event('tasks/cancel', { taskId })))).result,
    ).toEqual({ resultType: 'complete' });
  });
});
