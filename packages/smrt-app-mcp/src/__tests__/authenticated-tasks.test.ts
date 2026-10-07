import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  type JobExecutionContext,
  McpTaskStore,
} from '@happyvertical/smrt-jobs';
import { TaskRunner } from '@happyvertical/smrt-jobs/runner';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { expect, it } from 'vitest';
import { createMcpResourceAuth } from '../auth.js';
import { createMcpContinuationTool } from '../continuation.js';
import { createMcpAppServer, type McpAppPrincipal } from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';

let executions = 0;
@smrt({ mcp: { include: ['perform'], tasks: ['perform'] } })
class AuthenticatedTaskProbe extends SmrtObject {
  name = '';
  async perform(options: { wait?: boolean }, context?: JobExecutionContext) {
    if (options.wait) {
      await context?.task?.requestContinuation(
        { recordId: this.id ?? '', revision: '1', inputKey: 'answer' },
        { type: 'string' },
      );
    }
    await context?.task?.assertAuthorized();
    executions++;
    return { done: true, tenantId: context?.job.tenantId };
  }
}
class AuthenticatedTaskProbeCollection extends SmrtCollection<AuthenticatedTaskProbe> {
  static readonly _itemClass = AuthenticatedTaskProbe;
}

it('preserves verified JWT actor and active tenant through ordinary and restartable HTTP tasks', async () => {
  executions = 0;
  ObjectRegistry.registerCollection(
    'AuthenticatedTaskProbe',
    AuthenticatedTaskProbeCollection,
  );
  const pair = await generateKeyPair('RS256');
  const jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: 'task-test',
    alg: 'RS256',
    use: 'sig',
  };
  const issuer = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => issuer.listen(0, '127.0.0.1', resolve));
  const address = issuer.address();
  if (!address || typeof address === 'string')
    throw new Error('No issuer address');
  const origin = `http://127.0.0.1:${address.port}`;
  const tenantId = randomUUID();
  let activeTenant = tenantId;
  let allowed = true;
  const runners: TaskRunner[] = [];
  try {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'AuthenticatedTaskProbe',
        'SmrtJob',
        'SmrtJobEvent',
        'SmrtWorker',
      ],
    });
    const objects = await AuthenticatedTaskProbeCollection.create({ db });
    const probe = await objects.create({ name: 'synthetic review' });
    const storeFor = (principal: McpAppPrincipal) =>
      McpTaskStore.create(db, {
        ownerId: JSON.stringify([principal.tenantId ?? null, principal.id]),
        tenantId: principal.tenantId ?? null,
        requireAuthorization: true,
      });
    const app = createMcpAppServer({
      smrtOptions: () => ({ db }),
      serverInfo: { name: 'authenticated-task', version: '1' },
      allowedClassNames: ['AuthenticatedTaskProbe'],
      workflowTools: [
        {
          name: 'begin_review',
          description: 'Prepare a synthetic review task',
          effect: 'write',
          idempotent: false,
          openWorld: false,
          inputSchema: { type: 'object', properties: {} },
          outputSchema: {
            type: 'object',
            properties: { taskId: { type: 'string' } },
            required: ['taskId'],
          },
          async execute({ principal }) {
            if (!principal?.id) throw new Error('Missing verified principal');
            const store = await storeFor(principal);
            const task = await store.createTask({
              objectType: 'AuthenticatedTaskProbe',
              objectId: probe.id ?? '',
              method: 'perform',
              invocationArgs: [{ wait: true }],
              tenantId: principal.tenantId,
              continuation: {
                recordId: probe.id ?? '',
                revision: '1',
                inputKey: 'answer',
              },
            });
            return {
              content: [{ type: 'text', text: task.taskId }],
              structuredContent: { taskId: task.taskId },
            };
          },
        },
        createMcpContinuationTool({
          name: 'review_input',
          storeFor,
          authorize: async () => true,
        }),
      ],
    });
    const route = mountMcpRoute(app);
    const auth = createMcpResourceAuth({
      profile: 'local',
      issuer: origin,
      resource: `${origin}/mcp`,
      jwksUri: `${origin}/jwks`,
      algorithms: ['RS256'],
      scopes: ['workflow'],
      resolvePrincipal: async ({ subject }) => ({
        id: subject,
        tenantId: activeTenant,
      }),
    });
    const token = (subject: string) =>
      new SignJWT({ scope: 'workflow' })
        .setProtectedHeader({ alg: 'RS256', kid: 'task-test', typ: 'at+jwt' })
        .setIssuer(origin)
        .setAudience(`${origin}/mcp`)
        .setSubject(subject)
        .setExpirationTime('5m')
        .sign(pair.privateKey);
    const alice = await token('alice');
    const bob = await token('bob');
    const request = async (
      method: string,
      params: Record<string, unknown>,
      bearer = alice,
    ) => {
      const http = new Request(`${origin}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': method,
          ...(method === 'tools/call'
            ? { 'mcp-name': String(params.name) }
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
                name: 'task-client',
                version: '1',
              },
              'io.modelcontextprotocol/clientCapabilities': {
                extensions: { 'io.modelcontextprotocol/tasks': {} },
              },
            },
          },
        }),
      });
      const verified = await auth.authenticate(http);
      if (!verified.ok) return { status: verified.response.status };
      const response = await route({
        request: http,
        url: new URL(http.url),
        locals: { user: verified.principal },
      });
      return response.json();
    };
    const start = async () => {
      const runner = new TaskRunner({
        queues: ['mcp-tasks'],
        pollInterval: 5,
        retention: false,
        authorizeMcpTask: async (authority) =>
          allowed &&
          authority.ownerId === JSON.stringify([tenantId, 'alice']) &&
          authority.tenantId === tenantId,
      });
      await runner.initialize(db);
      await runner.start();
      runners.push(runner);
      return runner;
    };
    const wait = async (taskId: string, status: string) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const response = await request('tasks/get', { taskId });
        if (response.result?.status === status) return response.result;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Task did not reach ${status}`);
    };
    const ordinary = await request('tools/call', {
      name: 'authenticatedtaskprobe_perform',
      arguments: { id: probe.id, options: {} },
    });
    expect(ordinary.result.resultType).toBe('task');
    const first = await start();
    expect(await wait(ordinary.result.taskId, 'completed')).toMatchObject({
      result: { structuredContent: { data: { done: true, tenantId } } },
    });
    const prepared = await request('tools/call', {
      name: 'begin_review',
      arguments: {},
    });
    const taskId = prepared.result.structuredContent.taskId;
    await wait(taskId, 'input_required');
    expect(
      (
        await request('tools/call', {
          name: 'review_input',
          arguments: { taskId },
        })
      ).result.structuredContent.continuation.binding.recordId,
    ).toBe(probe.id);
    expect((await request('tasks/get', { taskId }, bob)).error).toBeDefined();
    activeTenant = randomUUID();
    expect((await request('tasks/get', { taskId })).error).toBeDefined();
    activeTenant = tenantId;
    await first.stop();
    allowed = false;
    await request('tasks/update', {
      taskId,
      inputResponses: { answer: 'confirmed' },
    });
    await start();
    await wait(taskId, 'failed');
    expect(executions).toBe(1);
  } finally {
    for (const runner of runners) await runner.stop();
    ObjectRegistry.clearCollectionCache?.();
    await new Promise<void>((resolve) => issuer.close(() => resolve()));
  }
});
