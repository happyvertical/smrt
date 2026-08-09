import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import type { JobExecutionContext } from '../logger-extension.js';
import { McpTaskStore } from '../mcp-task.js';
import { TaskRunner } from '../runner.js';

@smrt()
class McpTaskProbe extends SmrtObject {
  name = '';

  @backgroundEligible()
  async voidResult(): Promise<void> {}

  @backgroundEligible()
  async slow(
    options: { value: string },
    _context?: JobExecutionContext,
  ): Promise<{ value: string }> {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { value: options.value };
  }

  @backgroundEligible()
  async needsInput(
    _options: Record<string, never>,
    context?: JobExecutionContext,
  ): Promise<{ answer: unknown }> {
    const answers = await context?.task?.requestInput({
      answer: { type: 'string', description: 'A required answer' },
    });
    return { answer: answers?.answer };
  }

  @backgroundEligible()
  async needsTwoInputs(
    _options: Record<string, never>,
    context?: JobExecutionContext,
  ): Promise<{ first: unknown; second: unknown }> {
    const first = await context?.task?.requestInput({
      first: { type: 'string' },
    });
    const second = await context?.task?.requestInput({
      second: { type: 'string' },
    });
    return { first: first?.first, second: second?.second };
  }
}

class McpTaskProbeCollection extends SmrtCollection<McpTaskProbe> {
  static readonly _itemClass = McpTaskProbe;
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

async function createProbe() {
  ObjectRegistry.registerCollection('McpTaskProbe', McpTaskProbeCollection);
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ['McpTaskProbe', 'SmrtJob', 'SmrtJobEvent', 'SmrtWorker'],
  });
  const collection = await McpTaskProbeCollection.create({ db });
  const probe = await collection.create({ name: 'task probe' });
  return { db, probe };
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for task state');
}

describe('MCP Tasks durable jobs adapter', () => {
  it('persists one correlated job, runs it, and returns its CallToolResult', async () => {
    const { db, probe } = await createProbe();
    const store = await McpTaskStore.create(db, { ownerId: 'principal-a' });
    const created = await store.createTask({
      objectType: 'McpTaskProbe',
      objectId: probe.id ?? '',
      method: 'slow',
      invocationArgs: [{ value: 'done' }],
    });

    const correlated = await db.query(
      'SELECT id, task_id, task_owner_id, status FROM _smrt_jobs WHERE task_id = ?',
      created.taskId,
    );
    expect(correlated.rows).toHaveLength(1);
    expect(correlated.rows[0]).toMatchObject({
      task_id: created.taskId,
      task_owner_id: 'principal-a',
      status: 'pending',
    });

    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      const completed = await waitFor(
        () => store.getTask(created.taskId),
        (task) => task.status === 'completed',
      );
      expect(completed.result).toEqual({
        content: [{ type: 'text', text: JSON.stringify({ value: 'done' }) }],
        structuredContent: { data: { value: 'done' } },
      });
    } finally {
      await runner.stop();
    }
  });

  it('normalizes a void action result to valid JSON in the durable task payload', async () => {
    const { db, probe } = await createProbe();
    const store = await McpTaskStore.create(db, { ownerId: 'principal-a' });
    const created = await store.createTask({
      objectType: 'McpTaskProbe',
      objectId: probe.id ?? '',
      method: 'voidResult',
      invocationArgs: [],
    });
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      const completed = await waitFor(
        () => store.getTask(created.taskId),
        (task) => task.status === 'completed',
      );
      expect(completed.result).toEqual({
        content: [{ type: 'text', text: 'null' }],
        structuredContent: { data: null },
      });
    } finally {
      await runner.stop();
    }
  });

  it('uses the same job row for cancellation and never leaves it pending', async () => {
    const { db, probe } = await createProbe();
    const store = await McpTaskStore.create(db, { ownerId: 'principal-a' });
    const created = await store.createTask({
      objectType: 'McpTaskProbe',
      objectId: probe.id ?? '',
      method: 'slow',
      invocationArgs: [{ value: 'never' }],
    });

    await store.cancelTask(created.taskId);
    const task = await store.getTask(created.taskId);
    expect(task.status).toBe('cancelled');
    const rows = await db.query(
      'SELECT status FROM _smrt_jobs WHERE task_id = ?',
      created.taskId,
    );
    expect(rows.rows).toEqual([{ status: 'cancelled' }]);
  });

  it('accepts only outstanding task input keys and resumes the running job', async () => {
    const { db, probe } = await createProbe();
    const store = await McpTaskStore.create(db, { ownerId: 'principal-a' });
    const created = await store.createTask({
      objectType: 'McpTaskProbe',
      objectId: probe.id ?? '',
      method: 'needsInput',
      invocationArgs: [{}],
    });
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      await waitFor(
        () => store.getTask(created.taskId),
        (task) => task.status === 'input_required',
      );
      await store.updateTask(created.taskId, { ignored: 'no', answer: 'yes' });
      const completed = await waitFor(
        () => store.getTask(created.taskId),
        (task) => task.status === 'completed',
      );
      expect(completed.result).toMatchObject({
        structuredContent: { data: { answer: 'yes' } },
      });
    } finally {
      await runner.stop();
    }
  });

  it('clears consumed input responses before requesting another input round', async () => {
    const { db, probe } = await createProbe();
    const store = await McpTaskStore.create(db, { ownerId: 'principal-a' });
    const created = await store.createTask({
      objectType: 'McpTaskProbe',
      objectId: probe.id ?? '',
      method: 'needsTwoInputs',
      invocationArgs: [{}],
    });
    const runner = new TaskRunner({
      queues: ['mcp-tasks'],
      pollInterval: 5,
      concurrency: 1,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      await waitFor(
        () => store.getTask(created.taskId),
        (task) => task.status === 'input_required',
      );
      await store.updateTask(created.taskId, { first: 'one' });
      await waitFor(
        async () =>
          db.query(
            'SELECT task_input_requests FROM _smrt_jobs WHERE task_id = ?',
            created.taskId,
          ),
        (result) =>
          String(result.rows[0]?.task_input_requests).includes('second'),
      );
      await store.updateTask(created.taskId, { second: 'two' });
      const completed = await waitFor(
        () => store.getTask(created.taskId),
        (task) => task.status === 'completed',
      );
      expect(completed.result).toMatchObject({
        structuredContent: { data: { first: 'one', second: 'two' } },
      });
    } finally {
      await runner.stop();
    }
  });
});
