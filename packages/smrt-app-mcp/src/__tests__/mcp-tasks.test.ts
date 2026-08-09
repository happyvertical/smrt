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
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpAppServer, type McpAppPrincipal } from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';

@smrt({
  mcp: { include: ['slow', 'needsInput'], tasks: ['slow', 'needsInput'] },
})
class AppTaskProbe extends SmrtObject {
  name = '';

  @backgroundEligible()
  async slow(options: { value: string }) {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { value: options.value };
  }

  @backgroundEligible()
  async needsInput(
    _options: Record<string, never>,
    context?: JobExecutionContext,
  ): Promise<{ answer: unknown }> {
    const response = await context?.task?.requestInput({
      answer: { type: 'string', description: 'A required answer' },
    });
    return { answer: response?.answer };
  }
}

class AppTaskProbeCollection extends SmrtCollection<AppTaskProbe> {
  static readonly _itemClass = AppTaskProbe;
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

function taskEvent(
  method: string,
  params: Record<string, unknown>,
  principal: McpAppPrincipal | null = { id: 'principal-a' },
  options: {
    mcpMethod?: string | null;
    mcpName?: string | null;
    taskCapability?: boolean;
  } = {},
) {
  const url = new URL('https://example.com/api/mcp');
  return {
    locals: { principal },
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        ...(options.mcpMethod === null
          ? {}
          : { 'mcp-method': options.mcpMethod ?? method }),
        ...(options.mcpName === null
          ? {}
          : method === 'tools/call' && typeof params.name === 'string'
            ? { 'mcp-name': options.mcpName ?? params.name }
            : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'app-task-test',
              version: '0.0.0',
            },
            'io.modelcontextprotocol/clientCapabilities': {
              extensions:
                options.taskCapability === false
                  ? {}
                  : { 'io.modelcontextprotocol/tasks': {} },
            },
          },
        },
      }),
    }),
  };
}

async function waitForTaskStatus(
  handler: ReturnType<typeof mountMcpRoute>,
  taskId: string,
  status: string,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await handler(taskEvent('tasks/get', { taskId }));
    const body = (await response.json()) as {
      result?: { status?: string; result?: unknown };
    };
    if (body.result?.status === status) return body.result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for app MCP task completion');
}

function waitForCompleted(
  handler: ReturnType<typeof mountMcpRoute>,
  taskId: string,
) {
  return waitForTaskStatus(handler, taskId, 'completed');
}

describe('app MCP Tasks extension', () => {
  it('advertises only when enabled and completes a task over stateless HTTP', async () => {
    ObjectRegistry.registerCollection('AppTaskProbe', AppTaskProbeCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppTaskProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
    });
    const collection = await AppTaskProbeCollection.create({ db });
    const probe = await collection.create({ name: 'app task probe' });
    const appServer = createMcpAppServer({
      smrtOptions: () => ({ db }),
      serverInfo: { name: 'app-task-test', version: '0.0.0' },
      allowedClassNames: ['AppTaskProbe'],
    });
    const handler = mountMcpRoute(appServer, {
      resolvePrincipal: (event) =>
        event.locals?.principal as { id: string } | undefined,
    });
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      const discover = await handler(taskEvent('server/discover', {}));
      expect((await discover.json()).result).toMatchObject({
        capabilities: {
          extensions: { 'io.modelcontextprotocol/tasks': {} },
        },
      });

      const createdResponse = await handler(
        taskEvent('tools/call', {
          name: 'apptaskprobe_slow',
          arguments: { id: probe.id, options: { value: 'finished' } },
        }),
      );
      const created = (await createdResponse.json()) as {
        result: { resultType: string; taskId: string; status: string };
      };
      expect(created.result).toMatchObject({
        resultType: 'task',
        status: 'working',
      });

      const completed = await waitForCompleted(handler, created.result.taskId);
      expect(completed).toMatchObject({
        resultType: 'complete',
        result: { structuredContent: { data: { value: 'finished' } } },
      });

      const inputCreatedResponse = await handler(
        taskEvent('tools/call', {
          name: 'apptaskprobe_needsinput',
          arguments: { id: probe.id, _options: {} },
        }),
      );
      const inputCreated = (await inputCreatedResponse.json()) as {
        result: { taskId: string };
      };
      await waitForTaskStatus(
        handler,
        inputCreated.result.taskId,
        'input_required',
      );
      const update = await handler(
        taskEvent('tasks/update', {
          taskId: inputCreated.result.taskId,
          inputResponses: { ignored: 'no', answer: 'yes' },
        }),
      );
      expect((await update.json()).result).toEqual({ resultType: 'complete' });
      const inputCompleted = await waitForCompleted(
        handler,
        inputCreated.result.taskId,
      );
      expect(inputCompleted).toMatchObject({
        result: { structuredContent: { data: { answer: 'yes' } } },
      });

      const jobs = await db.query(
        'SELECT task_id, status FROM _smrt_jobs WHERE task_id = ?',
        created.result.taskId,
      );
      expect(jobs.rows).toEqual([
        { task_id: created.result.taskId, status: 'completed' },
      ]);
    } finally {
      await runner.stop();
    }
  });

  it('cancels the correlated pending job through tasks/cancel', async () => {
    ObjectRegistry.registerCollection('AppTaskProbe', AppTaskProbeCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppTaskProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
    });
    const collection = await AppTaskProbeCollection.create({ db });
    const probe = await collection.create({ name: 'cancel task probe' });
    const handler = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'app-task-test', version: '0.0.0' },
        allowedClassNames: ['AppTaskProbe'],
      }),
      {
        resolvePrincipal: (event) =>
          event.locals?.principal as { id: string } | undefined,
      },
    );
    const createdResponse = await handler(
      taskEvent('tools/call', {
        name: 'apptaskprobe_slow',
        arguments: { id: probe.id, options: { value: 'cancelled' } },
      }),
    );
    const created = (await createdResponse.json()) as {
      result: { taskId: string };
    };
    const cancelled = await handler(
      taskEvent('tasks/cancel', { taskId: created.result.taskId }),
    );
    expect((await cancelled.json()).result).toEqual({ resultType: 'complete' });
    const task = await handler(
      taskEvent('tasks/get', { taskId: created.result.taskId }),
    );
    expect((await task.json()).result).toMatchObject({ status: 'cancelled' });
  });

  it('scopes task lifecycle lookups to the originating tenant and principal', async () => {
    ObjectRegistry.registerCollection('AppTaskProbe', AppTaskProbeCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppTaskProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
    });
    const collection = await AppTaskProbeCollection.create({ db });
    const probe = await collection.create({ name: 'tenant task probe' });
    const handler = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'app-task-test', version: '0.0.0' },
        allowedClassNames: ['AppTaskProbe'],
      }),
      {
        resolvePrincipal: (event) =>
          event.locals?.principal as McpAppPrincipal | undefined,
      },
    );
    const tenantA = { id: 'principal-a', tenantId: 'tenant-a' };
    const createdResponse = await handler(
      taskEvent(
        'tools/call',
        {
          name: 'apptaskprobe_slow',
          arguments: { id: probe.id, options: { value: 'tenant' } },
        },
        tenantA,
      ),
    );
    const created = (await createdResponse.json()) as {
      result: { taskId: string };
    };
    const persisted = await db.query(
      'SELECT task_owner_id FROM _smrt_jobs WHERE task_id = ?',
      created.result.taskId,
    );
    expect(persisted.rows).toEqual([
      { task_owner_id: JSON.stringify(['tenant-a', 'principal-a']) },
    ]);
    const inaccessible = await handler(
      taskEvent(
        'tasks/get',
        { taskId: created.result.taskId },
        { id: 'principal-a', tenantId: 'tenant-b' },
      ),
    );
    expect((await inaccessible.json()).error).toMatchObject({ code: -32602 });
  });

  it('requires a stable principal id before creating a task', async () => {
    ObjectRegistry.registerCollection('AppTaskProbe', AppTaskProbeCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppTaskProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
    });
    const collection = await AppTaskProbeCollection.create({ db });
    const probe = await collection.create({ name: 'anonymous task probe' });
    const handler = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'app-task-test', version: '0.0.0' },
        allowedClassNames: ['AppTaskProbe'],
      }),
      {
        resolvePrincipal: (event) =>
          event.locals?.principal as McpAppPrincipal | undefined,
      },
    );
    const anonymousPrincipal = {};
    const discover = await handler(
      taskEvent('server/discover', {}, anonymousPrincipal),
    );
    const discovered = (await discover.json()) as {
      result: { capabilities: { extensions?: unknown } };
    };
    expect(discovered.result.capabilities.extensions).toBeUndefined();
    const created = await handler(
      taskEvent(
        'tools/call',
        {
          name: 'apptaskprobe_slow',
          arguments: { id: probe.id, options: { value: 'protected' } },
        },
        anonymousPrincipal,
      ),
    );
    expect((await created.json()).error).toMatchObject({
      code: -32600,
      message: 'Authentication is required for MCP tasks.',
    });
  });

  it('retains modern routing and client-capability gates for task requests', async () => {
    ObjectRegistry.registerCollection('AppTaskProbe', AppTaskProbeCollection);
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['AppTaskProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
    });
    const collection = await AppTaskProbeCollection.create({ db });
    const probe = await collection.create({ name: 'header task probe' });
    const handler = mountMcpRoute(
      createMcpAppServer({
        smrtOptions: () => ({ db }),
        serverInfo: { name: 'app-task-test', version: '0.0.0' },
        allowedClassNames: ['AppTaskProbe'],
      }),
      {
        resolvePrincipal: (event) => event.locals?.principal as { id: string },
      },
    );

    const requests = [
      {
        event: taskEvent(
          'tools/call',
          {
            name: 'apptaskprobe_slow',
            arguments: { id: probe.id, options: {} },
          },
          { id: 'principal-a' },
          { mcpName: null },
        ),
        code: -32020,
      },
      {
        event: taskEvent(
          'tools/call',
          {
            name: 'apptaskprobe_slow',
            arguments: { id: probe.id, options: {} },
          },
          { id: 'principal-a' },
          { mcpMethod: 'tasks/get' },
        ),
        code: -32020,
      },
      {
        event: taskEvent(
          'tasks/get',
          { taskId: 'missing' },
          { id: 'principal-a' },
          { taskCapability: false },
        ),
        code: -32021,
      },
    ];

    for (const { event, code } of requests) {
      const response = await handler(event);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(code);
    }
  });
});
