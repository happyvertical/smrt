import { randomUUID } from 'node:crypto';
import {
  createMcpAppServer,
  createMcpContinuationTool,
} from '@happyvertical/smrt-app-mcp';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { type McpTaskAuthority, McpTaskStore } from '@happyvertical/smrt-jobs';
import { TaskRunner } from '@happyvertical/smrt-jobs/runner';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bindOpenAiFormReply,
  continueOpenAiForm,
  submitOpenAiForm,
} from './forms-server.js';

const binding = {
  recordId: 'synthetic-review',
  revision: 'immutable-1',
  inputKey: 'form-1',
};
const schema = {
  type: 'object',
  required: ['name', 'resource'],
  properties: {
    name: { type: 'string', maxLength: 64 },
    resource: {
      type: 'string',
      format: 'uri',
      'x-openai-input': {
        type: 'resource',
        options: [
          { name: 'Synthetic resource', uri: 'resource://opaque/owned' },
        ],
      },
    },
  },
};
let duringResource: (() => Promise<void>) | undefined;
let applications = 0;
let live = true;
let grant = true;
let unknown = false;
let revokeDuringResource = false;
@smrt()
class OpenAiFormProbe extends SmrtObject {
  name = '';
  async collectInput() {
    return continueOpenAiForm({
      binding: {
        ...binding,
        reviewUrl: 'https://app.example.invalid/reviews/synthetic',
      },
      schema,
      authorizeApply: async () => live,
      authorizeResource: async () => {
        await duringResource?.();
        if (revokeDuringResource) live = false;
        return grant;
      },
      applyInput: async (content) => {
        applications++;
        if (unknown) throw new Error('Unknown external outcome; reconcile');
        return { content, domainApprovalRequired: true };
      },
    });
  }
}
class OpenAiFormProbeCollection extends SmrtCollection<OpenAiFormProbe> {
  static readonly _itemClass = OpenAiFormProbe;
}
afterEach(() => {
  duringResource = undefined;
  applications = 0;
  live = true;
  grant = true;
  unknown = false;
  revokeDuringResource = false;
  ObjectRegistry.clearCollectionCache?.();
});
async function fixture() {
  ObjectRegistry.registerCollection(
    'OpenAiFormProbe',
    OpenAiFormProbeCollection,
  );
  const db = await getTestDatabase({
    type: process.env.SMRT_TEST_POSTGRES_URL ? 'postgres' : 'sqlite',
    url: process.env.SMRT_TEST_POSTGRES_URL ?? ':memory:',
    classes: ['OpenAiFormProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
  });
  const objects = await OpenAiFormProbeCollection.create({ db });
  const item = await objects.create({ name: randomUUID() });
  const ownerId = randomUUID();
  const tenantId = randomUUID();
  const store = await McpTaskStore.create(db, {
    ownerId,
    tenantId,
    requireAuthorization: true,
  });
  const task = await store.createTask({
    objectType: 'OpenAiFormProbe',
    objectId: item.id ?? '',
    method: 'collectInput',
    invocationArgs: [],
    tenantId,
    continuation: binding,
  });
  const runners: TaskRunner[] = [];
  const start = async (
    authorize: (a: Readonly<McpTaskAuthority>) => Promise<boolean> = async (
      a,
    ) => live && a.ownerId === ownerId && a.tenantId === tenantId,
  ) => {
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
      authorizeMcpTask: authorize,
      retention: false,
      shutdownTimeout: 100,
    });
    await runner.initialize(db);
    await runner.start();
    runners.push(runner);
    return runner;
  };
  return {
    db,
    store,
    task,
    start,
    ownerId,
    tenantId,
    stop: async () => {
      for (const r of runners) await r.stop();
    },
  };
}
async function wait(store: McpTaskStore, id: string, status: string) {
  for (let n = 0; n < 300; n++) {
    const task = await store.getTask(id);
    if (task.status === status) return task;
    if (task.status === 'failed' && status !== 'failed')
      throw new Error(task.statusMessage);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Did not reach ${status}`);
}
const reply = {
  action: 'accept',
  content: { name: 'Synthetic', resource: 'resource://opaque/owned' },
};
const submit = (
  f: Awaited<ReturnType<typeof fixture>>,
  value: unknown = reply,
) =>
  submitOpenAiForm({
    store: f.store,
    taskId: f.task.taskId,
    binding,
    reply: value,
    authorize: async () => live,
  });
describe('durable application form authority', () => {
  it('persists owner/tenant/request/revision, survives restart, and accepts one concurrent reply', async () => {
    const f = await fixture();
    try {
      const runner = await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      await runner.stop();
      expect(await f.store.getContinuation(f.task.taskId)).toMatchObject({
        binding,
        inputRequests: { 'form-1': { schema } },
      });
      const restored = await McpTaskStore.create(f.db, {
        ownerId: f.ownerId,
        tenantId: f.tenantId,
      });
      await Promise.all([
        submitOpenAiForm({
          store: restored,
          taskId: f.task.taskId,
          binding,
          reply,
          authorize: async () => true,
        }),
        submit(f, {
          action: 'accept',
          content: { ...reply.content, name: 'Second' },
        }),
      ]);
      await f.start();
      const result = await wait(f.store, f.task.taskId, 'completed');
      expect(applications).toBe(1);
      expect(JSON.stringify(result)).toContain('domainApprovalRequired');
      await expect(submit(f)).rejects.toThrow('not awaiting');
    } finally {
      await f.stop();
    }
  });
  it('denies wrong owners, tenants, request keys, revision and malformed replies before persistence', async () => {
    const f = await fixture();
    try {
      await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      for (const identity of [
        { ownerId: 'other', tenantId: f.tenantId },
        { ownerId: f.ownerId, tenantId: 'other' },
        { ownerId: f.ownerId, tenantId: null },
      ]) {
        const other = await McpTaskStore.create(f.db, identity);
        await expect(
          submitOpenAiForm({
            store: other,
            taskId: f.task.taskId,
            binding,
            reply,
            authorize: async () => true,
          }),
        ).rejects.toThrow();
      }
      for (const b of [
        { ...binding, revision: 'stale' },
        { ...binding, inputKey: 'wrong' },
        { ...binding, recordId: 'wrong' },
      ])
        await expect(
          submitOpenAiForm({
            store: f.store,
            taskId: f.task.taskId,
            binding: b,
            reply,
            authorize: async () => true,
          }),
        ).rejects.toThrow('binding');
      await expect(
        submit(f, {
          action: 'accept',
          content: { name: 'Synthetic', resource: 'resource://opaque/other' },
        }),
      ).rejects.toThrow();
      expect((await f.store.getTask(f.task.taskId)).status).toBe(
        'input_required',
      );
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });
  it.each([
    'before-reply',
    'after-reply',
    'after-resource',
    'resource-denied',
  ] as const)('denies live authority loss %s', async (mode) => {
    const f = await fixture();
    try {
      const runner = await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      await runner.stop();
      if (mode === 'before-reply') {
        live = false;
        await expect(submit(f)).rejects.toThrow('denied');
        expect((await f.store.getTask(f.task.taskId)).status).toBe(
          'input_required',
        );
      } else {
        await submit(f);
        if (mode === 'after-reply') live = false;
        if (mode === 'after-resource') revokeDuringResource = true;
        if (mode === 'resource-denied') grant = false;
        await f.start();
        await wait(f.store, f.task.taskId, 'failed');
      }
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });
  it.each([
    'cancel',
    'decline',
  ] as const)('does not apply a %s reply', async (action) => {
    const f = await fixture();
    try {
      await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      await submit(f, { action });
      await wait(f.store, f.task.taskId, 'completed');
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
  });
  it('cancellation prevents late application and direct malformed task answers fail closed', async () => {
    const f = await fixture();
    try {
      await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      await f.store.cancelTask(f.task.taskId);
      await expect(submit(f)).rejects.toThrow();
      expect(applications).toBe(0);
    } finally {
      await f.stop();
    }
    const g = await fixture();
    try {
      await g.start();
      await wait(g.store, g.task.taskId, 'input_required');
      await g.store.updateTask(g.task.taskId, {
        [binding.inputKey]: {
          ...bindOpenAiFormReply(binding, schema, reply),
          binding: { ...binding, revision: 'stale' },
        },
      });
      await wait(g.store, g.task.taskId, 'failed');
      expect(applications).toBe(0);
    } finally {
      await g.stop();
    }
  });
  it('unknown external outcome fails without automatic replay after restart', async () => {
    const f = await fixture();
    try {
      unknown = true;
      await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      await submit(f);
      await wait(f.store, f.task.taskId, 'failed');
      await f.stop();
      await f.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(applications).toBe(1);
      expect((await f.store.getTask(f.task.taskId)).status).toBe('failed');
    } finally {
      await f.stop();
    }
  });
  it('rejects provider failures and revocation during submit without recording an answer', async () => {
    const f = await fixture();
    try {
      await f.start();
      await wait(f.store, f.task.taskId, 'input_required');
      let count = 0;
      await expect(
        submitOpenAiForm({
          store: f.store,
          taskId: f.task.taskId,
          binding,
          reply,
          authorize: async () => ++count === 1,
        }),
      ).rejects.toThrow('denied');
      await expect(
        submitOpenAiForm({
          store: f.store,
          taskId: f.task.taskId,
          binding,
          reply,
          authorize: async () => {
            throw new Error('provider down');
          },
        }),
      ).rejects.toThrow('provider down');
      expect((await f.store.getTask(f.task.taskId)).status).toBe(
        'input_required',
      );
      expect(bindOpenAiFormReply(binding, schema, reply).binding).toEqual(
        binding,
      );
    } finally {
      await f.stop();
    }
  });
});

it('serves the functional fallback using real SDK v2 HTTP without advertising unsupported native forms', async () => {
  const f = await fixture();
  const owner = { id: f.ownerId, tenantId: f.tenantId };
  let principal = owner;
  const envelopes: unknown[] = [];
  const read = createMcpContinuationTool({
    name: 'form_read',
    storeFor: async () => f.store,
    authorize: async (p) =>
      live && p.id === owner.id && p.tenantId === owner.tenantId,
  });
  const server = createMcpAppServer({
    serverInfo: { name: 'synthetic-forms', version: '1' },
    smrtOptions: () => ({}),
    allowedClassNames: [],
    workflowTools: [
      read,
      {
        name: 'form_submit',
        description:
          'Submit synthetic form input; dedicated domain review is still required.',
        effect: 'write',
        idempotent: false,
        openWorld: false,
        inputSchema: {
          type: 'object',
          properties: { reply: { type: 'object' } },
          required: ['reply'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { submitted: { type: 'boolean' } },
          required: ['submitted'],
          additionalProperties: false,
        },
        execute: async (c) => {
          await submit(f, c.arguments.reply);
          return {
            content: [
              { type: 'text', text: 'Input submitted; domain review required' },
            ],
            structuredContent: { submitted: true },
          };
        },
      },
    ],
    toolPolicy: ({ principal: p }) =>
      live && p?.id === owner.id && p.tenantId === owner.tenantId,
  });
  const mount = mountMcpRoute(server, { resolvePrincipal: () => principal });
  const client = new Client(
    { name: 'synthetic-form-client', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await f.start();
    await wait(f.store, f.task.taskId, 'input_required');
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://synthetic.test/mcp'), {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const response = await mount({ request, url: new URL(request.url) });
          expect(response.headers.get('mcp-session-id')).toBeNull();
          if (
            response.headers.get('content-type')?.includes('application/json')
          )
            envelopes.push(await response.clone().json());
          return response;
        },
      }),
    );
    expect(JSON.stringify(envelopes)).toContain('2026-07-28');
    expect(JSON.stringify(envelopes)).not.toContain('openai/elicitation');
    const result = await client.callTool({
      name: 'form_read',
      arguments: { taskId: f.task.taskId },
    });
    expect(JSON.stringify(result)).toContain(
      'https://app.example.invalid/reviews/synthetic',
    );
    expect(JSON.stringify(result)).toContain('resource://opaque/owned');
    principal = { ...owner, tenantId: 'other' };
    await expect(
      client.callTool({
        name: 'form_read',
        arguments: { taskId: f.task.taskId },
      }),
    ).rejects.toThrow();
    principal = owner;
    await client.callTool({ name: 'form_submit', arguments: { reply } });
    await wait(f.store, f.task.taskId, 'completed');
    expect(applications).toBe(1);
  } finally {
    await client.close();
    await f.stop();
  }
});

it('rechecks task cancellation after asynchronous resource authorization', async () => {
  const f = await fixture();
  try {
    await f.start();
    await wait(f.store, f.task.taskId, 'input_required');
    duringResource = () =>
      f.store.cancelTask(f.task.taskId).then(() => undefined);
    await submit(f);
    await wait(f.store, f.task.taskId, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(applications).toBe(0);
  } finally {
    await f.stop();
  }
});
it('rejects a changed durable schema fingerprint even with matching record binding', async () => {
  const f = await fixture();
  try {
    await f.start();
    await wait(f.store, f.task.taskId, 'input_required');
    const changed = {
      ...schema,
      properties: {
        ...schema.properties,
        name: { type: 'string', maxLength: 128 },
      },
    };
    await f.store.updateTask(f.task.taskId, {
      [binding.inputKey]: bindOpenAiFormReply(binding, changed, reply),
    });
    await wait(f.store, f.task.taskId, 'failed');
    expect(applications).toBe(0);
  } finally {
    await f.stop();
  }
});
