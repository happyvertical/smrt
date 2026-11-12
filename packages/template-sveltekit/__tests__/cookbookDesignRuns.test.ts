import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  type ResolvedWorkProfile,
  recommendedWorkProfile,
} from '@happyvertical/smrt-inference/server';
import { SmrtJobCollection, TaskRunner } from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CookbookDesignRunsOptions,
  createCookbookDesignRuns,
} from '../host/design-runs.js';

const profile = (): ResolvedWorkProfile => ({
  ...recommendedWorkProfile('design'),
  name: 'design',
  engine: 'api',
  tier: 'best',
  budgets: {
    ...recommendedWorkProfile('design').budgets,
    passes: 3,
    maxRunTokens: 100,
    maxTurnTokens: 10,
    runTimeoutMs: 10_000,
    turnTimeoutMs: 1000,
  },
});
const metadata = {
  profile: 'design' as const,
  engine: 'api' as const,
  effort: 'max' as const,
  tokens: 2,
  toolCalls: 0,
  durationMs: 1,
};
const output = {
  summary: 'Keep the existing data and propose a field.',
  checks: ['The request has a target list.'],
  ready: true,
  operations: [],
};

describe('cookbook durable design jobs', () => {
  let db: DatabaseInterface;
  let host: ReturnType<typeof createCookbookDesignRuns>;
  let runner: TaskRunner | undefined;
  beforeEach(async () => {
    db = await getTestDatabase({
      classes: [
        'DesignRunRecord',
        'SmrtJob',
        'SmrtJobEvent',
        'SmrtWorker',
        'SmrtJobDedupeSlot',
      ],
    });
  });
  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
    host?.dispose();
    await db.close?.();
  });
  function install(executePass: CookbookDesignRunsOptions['executePass']) {
    host = createCookbookDesignRuns({
      db,
      authorize: async () => {},
      executePass,
    });
    return host.forOwner('owner', null);
  }
  async function startWorker() {
    runner = new TaskRunner({
      concurrency: 1,
      pollInterval: 10,
      retention: false,
    });
    await runner.initialize(db);
    await runner.start();
  }
  async function terminal(id: string) {
    const bound = host.forOwner('owner', null);
    for (let index = 0; index < 300; index++) {
      const state = await bound.status(id);
      if (
        ['done', 'failed', 'stopped', 'waiting-approval'].includes(state.status)
      )
        return state;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Design job did not finish');
  }
  it('persists before execution and resumes three checked passes after a host restart', async () => {
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({ output, metadata }),
    );
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a field',
      profile: profile(),
    });
    expect(execute).not.toHaveBeenCalled();
    const jobs = await db.query(
      'SELECT object_id AS target, method FROM _smrt_jobs',
    );
    expect(jobs.rows).toMatchObject([
      { target: created.id, method: 'execute' },
    ]);
    await bound.stop(created.id);
    host.dispose();
    const restarted = install(execute);
    await expect(
      host.forOwner('other', null).status(created.id),
    ).rejects.toThrow('not found');
    await restarted.resume(created.id);
    await startWorker();
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.outputs).toHaveLength(3);
    expect(done.tokens).toBe(6);
    expect(execute.mock.calls.map(([input]) => input.stage)).toEqual([
      'profile',
      'propose',
      'revise',
    ]);
    expect(execute.mock.calls[1][0].request.input).toMatchObject({
      previousCheck: { pass: 1, checked: true },
    });
  });
  it('stops a running pass cooperatively and resumes without resetting usage', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockImplementationOnce(async ({ request }) => {
        began();
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        });
        return { output, metadata };
      })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute);
    const selected = profile();
    selected.budgets.turnTimeoutMs = 1_800_000;
    selected.budgets.runTimeoutMs = 3_600_000;
    const permissionCeiling = ['app.describe'];
    const created = await bound.start({
      threadId: 'thread',
      content: 'Inspect the app',
      profile: selected,
      permissions: permissionCeiling,
    });
    permissionCeiling.push('app.removeList');
    await startWorker();
    await started;
    const stopped = await bound.stop(created.id);
    expect(stopped.status).toBe('stopped');
    expect(execute.mock.calls[0][0].permissions).toEqual(['app.describe']);
    expect(stopped.tokens).toBe(10);
    expect(stopped.leaseUntil).toBeGreaterThan(Date.now() + 1_700_000);
    await vi.waitFor(async () => {
      expect((await bound.status(created.id)).leaseUntil).toBeUndefined();
      const active = await db.query(
        "SELECT id FROM _smrt_jobs WHERE object_id = ? AND status = 'running'",
        created.id,
      );
      expect(active.rows).toHaveLength(0);
    });
    await bound.resume(created.id);
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.tokens).toBe(16);
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it('keeps an uncooperative pass reserved until its actual promise settles', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let finish!: () => void;
    const external = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockImplementationOnce(async () => {
        began();
        await external;
        return { output, metadata };
      })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute);
    const selected = profile();
    selected.budgets.turnTimeoutMs = 1_800_000;
    selected.budgets.runTimeoutMs = 3_600_000;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Inspect the app',
      profile: selected,
    });
    await startWorker();
    await started;
    const stopped = await bound.stop(created.id);
    await vi.waitFor(async () => {
      const job = await db.query(
        'SELECT status FROM _smrt_jobs WHERE object_id = ?',
        created.id,
      );
      expect(job.rows[0].status).toBe('failed');
    });
    expect((await bound.status(created.id)).leaseUntil).toBe(
      stopped.leaseUntil,
    );
    await expect(bound.resume(created.id)).rejects.toThrow();
    finish();
    await vi.waitFor(async () =>
      expect((await bound.status(created.id)).leaseUntil).toBeUndefined(),
    );
    await bound.resume(created.id);
    expect((await terminal(created.id)).status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(4);
  });
  it('refuses a late lease release when the captured job claim has changed', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    let finish!: () => void;
    const external = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bound = install(async () => {
      began();
      await external;
      return { output, metadata };
    });
    const selected = profile();
    selected.budgets.turnTimeoutMs = 1_800_000;
    selected.budgets.runTimeoutMs = 3_600_000;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Inspect the app',
      profile: selected,
    });
    await startWorker();
    await started;
    const stopped = await bound.stop(created.id);
    await vi.waitFor(async () => {
      const job = await db.query(
        'SELECT status FROM _smrt_jobs WHERE object_id = ?',
        created.id,
      );
      expect(job.rows[0].status).toBe('failed');
    });
    // Same job and worker can claim a later attempt; old settlement has no authority.
    await db.query(
      'UPDATE _smrt_jobs SET attempts = attempts + 1 WHERE object_id = ?',
      created.id,
    );
    const transactions = vi.spyOn(db, 'transaction');
    const before = transactions.mock.calls.length;
    finish();
    await vi.waitFor(() =>
      expect(transactions.mock.calls.length).toBeGreaterThan(before),
    );
    await transactions.mock.results.at(-1)?.value;
    expect((await bound.status(created.id)).leaseUntil).toBe(
      stopped.leaseUntil,
    );
    expect((await bound.status(created.id)).leaseRevision).toBe(
      stopped.leaseRevision,
    );
    await expect(bound.resume(created.id)).rejects.toThrow();
    transactions.mockRestore();
  });
  it('uses full schema validation and bounded repair on the same pass', async () => {
    const execute = vi
      .fn<CookbookDesignRunsOptions['executePass']>()
      .mockResolvedValueOnce({ output: { ...output, summary: 42 }, metadata })
      .mockResolvedValue({ output, metadata });
    const bound = install(execute);
    const created = await bound.start({
      threadId: 'thread',
      content: 'Review the list',
      profile: profile(),
    });
    await startWorker();
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(execute).toHaveBeenCalledTimes(4);
    expect(execute.mock.calls[1][0].request.repair?.errors.join(' ')).toContain(
      'string',
    );
    expect(done.tokens).toBe(8);
  });
  it('keeps concrete structural proposals pending review without applying effects', async () => {
    const proposed = {
      ...output,
      operations: [
        {
          tool: 'app.addField',
          args: {
            list: 'Customers',
            name: 'birthday',
            type: 'date',
            expectedRevision: 1,
          },
        },
      ],
    };
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({ output: proposed, metadata }),
    );
    const bound = install(execute);
    const selected = profile();
    selected.previewBeforeApply = false;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Add a birthday field',
      profile: selected,
    });
    await startWorker();
    const pending = await terminal(created.id);
    expect(pending.status).toBe('waiting-approval');
    expect(pending.note).toContain('Automatic application is blocked');
    expect(pending.outputs[2]).toEqual(proposed);
    expect((await bound.stop(created.id)).status).toBe('waiting-approval');
    expect(execute).toHaveBeenCalledTimes(3);
    await expect(bound.resume(created.id)).rejects.toThrow(
      'Review the proposed design',
    );
  });
  it('charges unknown usage and pauses the cumulative budget until an owner raises it', async () => {
    const execute = vi.fn<CookbookDesignRunsOptions['executePass']>(
      async () => ({
        output,
        metadata: { ...metadata, tokens: undefined },
      }),
    );
    const bound = install(execute);
    const settings = profile();
    settings.budgets.maxRunTokens = 10;
    const created = await bound.start({
      threadId: 'thread',
      content: 'Review the list',
      profile: settings,
    });
    await startWorker();
    const paused = await terminal(created.id);
    expect(paused.status).toBe('stopped');
    expect(paused.tokens).toBe(10);
    expect(execute).toHaveBeenCalledTimes(1);
    // Await terminal job transition so resume reserves a fresh nonterminal slot.
    const jobs = await SmrtJobCollection.create({ db });
    for (let index = 0; index < 100; index++) {
      const rows = await jobs.list({
        where: { objectId: created.id, status: 'running' },
      });
      if (!rows.length) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await bound.resume(created.id, { maxTokens: 50 });
    const done = await terminal(created.id);
    expect(done.status).toBe('done');
    expect(done.tokens).toBe(30);
  });
});
