import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type {
  DesignPass,
  DesignRunBudget,
  DesignRunDriverOptions,
} from '@happyvertical/smrt-inference/server';
import { installDesignRunExecutor } from '@happyvertical/smrt-inference/server';
import {
  SmrtJobCollection,
  SmrtJobEventCollection,
  SmrtWorkerCollection,
  TaskRunner,
  unregisterLiveWorker,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import Ajv from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDesignRunJobs, type DesignRunJobsOptions } from '../index.js';

const metadata = {
  profile: 'design',
  engine: 'api',
  effort: 'max',
  tokens: 2,
  toolCalls: 0,
  durationMs: 1,
} as const;
const budget: DesignRunBudget = {
  maxTokens: 100,
  maxDurationMs: 200_000,
  maxCallTokens: 10,
  callTimeoutMs: 30_000,
  repairRetries: 1,
  toolResultChars: 1000,
};
const schema = {
  type: 'object',
  required: ['value'],
  additionalProperties: false,
  properties: { value: { type: 'number' } },
};
const passes: DesignPass[] = [
  { name: 'Propose', schema },
  { name: 'Check and refine', schema },
];
type Input = { prompt: string };
type Output = { value: number };
type Kit = ReturnType<typeof createDesignRunJobs<Input, Output>>;
const startInput = (key = 'request') => ({
  key,
  input: { prompt: 'Design it' },
  budget,
});
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Condition did not settle');
    await delay(10);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('durable design job bridge', () => {
  let db: DatabaseInterface;
  let jobs: SmrtJobCollection;
  let kit: Kit;
  let dispose: (() => void) | undefined;
  let runners: TaskRunner[];
  let settled: (() => void)[];
  const ajv = new Ajv({ strict: true, allErrors: true });
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
    jobs = await SmrtJobCollection.create({ db });
    runners = [];
    settled = [];
  });
  afterEach(async () => {
    for (const settle of settled) settle();
    for (const runner of runners) await runner.stop();
    dispose?.();
    dispose = undefined;
    await db.close?.();
  });
  function install(
    executePass: DesignRunDriverOptions['executePass'] = async (request) => ({
      output: { value: request.pass.index },
      metadata,
    }),
    selectedPasses = passes,
    extra: Partial<DesignRunJobsOptions<Input>> = {},
  ) {
    dispose?.();
    kit = createDesignRunJobs<Input, Output>({
      db,
      jobs,
      kind: 'example-design',
      definition: 'example/v1',
      authorize: async () => {},
      configure: () => ({
        passes: selectedPasses,
        validate: (s, output) => {
          const validate = ajv.compile(s);
          return validate(output)
            ? []
            : (validate.errors ?? []).map(
                (error) => error.message ?? 'invalid',
              );
        },
        executePass,
        readResource: async () => ({ data: null }),
      }),
      ...extra,
    });
    dispose = kit.install();
    return kit.forOwner('owner', null);
  }
  async function worker(
    config: ConstructorParameters<typeof TaskRunner>[0] = {},
  ) {
    const runner = new TaskRunner({
      concurrency: 1,
      pollInterval: 10,
      cancelPollInterval: 10,
      retention: false,
      ...config,
    });
    runners.push(runner);
    await runner.initialize(db);
    await runner.start();
    return runner;
  }
  async function end(id: string) {
    const bound = kit.forOwner('owner', null);
    await until(async () =>
      ['done', 'failed', 'stopped', 'waiting-approval'].includes(
        (await bound.get(id)).status,
      ),
    );
    return bound.get(id);
  }
  async function jobSettled(id: string) {
    await until(
      async () =>
        (
          await jobs.list({
            where: { objectId: id, status: ['pending', 'running'] },
          })
        ).length === 0,
    );
  }

  it('README usage: starts, runs two passes, and completes its job without a lease', async () => {
    const bound = install();
    const state = await bound.start(startInput());
    expect(state.outputs).toEqual([]);
    await worker();
    const done = await end(state.id);
    expect(done).toMatchObject({
      status: 'done',
      outputs: [{ value: 1 }, { value: 2 }],
      tokens: 4,
    });
    expect(done.input.prompt).toBe('Design it');
    expect(done.leaseRevision).toBeUndefined();
    expect(done.leaseUntil).toBeUndefined();
    await jobSettled(state.id);
    const [job] = await jobs.list({ where: { objectId: state.id } });
    expect(job.status).toBe('completed');
    expect(job.args).toEqual({ kind: 'example-design' });
  });

  it('admits one run and one job for concurrent starts and replay after completion', async () => {
    const bound = install();
    const [first, second] = await Promise.all([
      bound.start(startInput()),
      bound.start(startInput()),
    ]);
    expect(second.id).toBe(first.id);
    expect(await jobs.list({ where: { objectId: first.id } })).toHaveLength(1);
    await worker();
    await end(first.id);
    await jobSettled(first.id);
    expect((await bound.start(startInput())).status).toBe('done');
    const replay = await bound.start({
      ...startInput(),
      input: { prompt: 'Ignored replay payload' },
      budget: { ...budget, maxTokens: 0 },
    });
    expect(replay.status).toBe('done');
    expect(replay.input.prompt).toBe('Design it');
    expect(await jobs.list({ where: { objectId: first.id } })).toHaveLength(1);
  });

  it('rolls back the run if job admission fails', async () => {
    const bound = install();
    const enqueue = vi
      .spyOn(jobs, 'enqueueJob')
      .mockRejectedValueOnce(new Error('Admission unavailable'));
    await expect(bound.start(startInput())).rejects.toThrow(
      'Admission unavailable',
    );
    enqueue.mockRestore();
    expect(
      (await db.query('SELECT id FROM _smrt_inference_design_runs')).rows,
    ).toHaveLength(0);
    expect(await jobs.list()).toHaveLength(0);
    await bound.start(startInput());
    expect(await jobs.list()).toHaveLength(1);
  });

  it('repairs invalid output once, retaining attempts and outputs', async () => {
    const execute = vi
      .fn<DesignRunDriverOptions['executePass']>()
      .mockResolvedValueOnce({ output: { wrong: true }, metadata })
      .mockImplementation(async (request) => ({
        output: { value: request.pass.index },
        metadata,
      }));
    const bound = install(execute);
    const run = await bound.start(startInput());
    await worker();
    const done = await end(run.id);
    expect(done.status).toBe('done');
    expect(done.attempts).toHaveLength(3);
    expect(execute.mock.calls[1][0].repair?.errors.length).toBeGreaterThan(0);
    expect(execute.mock.calls[2][0].repair).toBeUndefined();
  });

  it('fails after bounded repairs without retrying the job', async () => {
    const execute = vi.fn<DesignRunDriverOptions['executePass']>(async () => ({
      output: {},
      metadata,
    }));
    const bound = install(execute);
    const run = await bound.start(startInput());
    await worker();
    expect((await end(run.id)).status).toBe('failed');
    await jobSettled(run.id);
    expect(execute).toHaveBeenCalledTimes(2);
    const [job] = await jobs.list({ where: { objectId: run.id } });
    expect(job.status).toBe('completed');
    expect(job.attempts).toBe(1);
    await expect(bound.resume(run.id)).rejects.toThrow('ended');
  });

  it('stops at its budget and resumes with raised totals', async () => {
    const bound = install();
    const run = await bound.start({
      ...startInput(),
      budget: { ...budget, maxTokens: 2 },
    });
    await worker();
    expect((await end(run.id)).status).toBe('stopped');
    await jobSettled(run.id);
    await bound.resume(run.id, { maxTokens: 100 });
    expect((await end(run.id)).status).toBe('done');
  });

  it.each([
    'approve',
    'reject',
  ])('releases approval wait and replays only its check after %s', async (decision) => {
    await db.query('CREATE TABLE host_decisions (value TEXT)');
    let checks = 0;
    const check: DesignPass['check'] = async () => {
      checks++;
      const rows = await db.query('SELECT value FROM host_decisions');
      if (!rows.rows.length) return { waitingApproval: true };
      return rows.rows[0].value === 'approve'
        ? {}
        : { failure: 'The owner rejected this proposal.' };
    };
    const execute = vi.fn<DesignRunDriverOptions['executePass']>(async () => ({
      output: { value: 1 },
      metadata,
    }));
    let bound = install(execute, [{ name: 'Propose', schema, check }]);
    const run = await bound.start(startInput());
    const runner = await worker();
    expect((await end(run.id)).status).toBe('waiting-approval');
    expect((await bound.get(run.id)).leaseRevision).toBeUndefined();
    await jobSettled(run.id);
    await runner.stop();
    await db.query('INSERT INTO host_decisions VALUES (?)', decision);
    bound = install(execute, [{ name: 'Propose', schema, check }]);
    await bound.continueAfterApproval(run.id);
    await worker();
    expect((await end(run.id)).status).toBe(
      decision === 'approve' ? 'done' : 'failed',
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(checks).toBe(2);
    expect(await jobs.list({ where: { objectId: run.id } })).toHaveLength(2);
  });

  it.each([
    'stop',
    'cancel',
  ] as const)('%s aborts an in-flight pass, then resumes', async (action) => {
    let signal: AbortSignal | undefined;
    const execute = vi
      .fn<DesignRunDriverOptions['executePass']>()
      .mockImplementationOnce(async (request) => {
        signal = request.signal;
        await new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          ),
        );
        return { output: { value: 1 }, metadata };
      })
      .mockResolvedValue({ output: { value: 1 }, metadata });
    const bound = install(execute);
    const run = await bound.start(startInput());
    await worker();
    await until(() => signal !== undefined);
    expect((await bound[action](run.id)).status).toBe('stopped');
    await until(
      async () => (await bound.get(run.id)).leaseRevision === undefined,
    );
    await jobSettled(run.id);
    expect(signal?.aborted).toBe(true);
    await bound.resume(run.id);
    expect((await end(run.id)).status).toBe('done');
  });

  it('retains an uncooperative pass lease until true settlement', async () => {
    const external = deferred();
    settled.push(external.resolve);
    let began = false;
    const bound = install(async () => {
      began = true;
      await external.promise;
      return { output: { value: 1 }, metadata };
    });
    const run = await bound.start(startInput());
    await worker();
    await until(() => began);
    await bound.stop(run.id);
    await jobSettled(run.id);
    expect((await bound.get(run.id)).leaseRevision).toBeDefined();
    await expect(bound.resume(run.id)).rejects.toThrow('stopping');
    external.resolve();
    await until(
      async () => (await bound.get(run.id)).leaseRevision === undefined,
    );
  });

  it('forwards job cancellation signal even without a local stop call', async () => {
    let signal: AbortSignal | undefined;
    const bound = install(async (request) => {
      signal = request.signal;
      await new Promise((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      return { output: { value: 1 }, metadata };
    });
    const run = await bound.start(startInput());
    await worker();
    await until(() => signal !== undefined);
    const [job] = await jobs.list({ where: { objectId: run.id } });
    await job.cancel();
    await until(() => signal?.aborted === true);
    // Cross-process cancellation cannot checkpoint under a cancelled claim.
    // The host's stop persists Stop and lets the settled lease release safely.
    await bound.stop(run.id);
    expect((await bound.get(run.id)).status).toBe('stopped');
  });

  it('rejects stale claim commits and forged handler contexts', async () => {
    const external = deferred();
    settled.push(external.resolve);
    let began = false;
    const bound = install(async () => {
      began = true;
      await external.promise;
      return { output: { value: 7 }, metadata };
    });
    const run = await bound.start(startInput());
    await worker();
    await until(() => began);
    const before = await bound.get(run.id);
    const [replaced] = await jobs.list({ where: { objectId: run.id } });
    replaced.workerId = 'replacement';
    await replaced.save();
    external.resolve();
    await until(async () => runners[0].activeJobCount() === 0);
    expect((await bound.get(run.id)).revision).toBe(before.revision);
    expect((await bound.get(run.id)).outputs).toEqual([]);
    await expect(
      kit.handler({} as never, { kind: 'example-design' }, {}),
    ).rejects.toThrow('TaskRunner');
  });

  it('recovers an orphan only after stale-recovery, then explicitly resumes without repeating a committed pass', async () => {
    const external = deferred();
    settled.push(external.resolve);
    let interrupted = false;
    const calls: number[] = [];
    const execute: DesignRunDriverOptions['executePass'] = async (request) => {
      calls.push(request.pass.index);
      if (request.pass.index === 2 && !interrupted) {
        interrupted = true;
        await external.promise;
      }
      return { output: { value: request.pass.index }, metadata };
    };
    let bound = install(execute);
    const run = await bound.start(startInput());
    const oldRunner = await worker({ shutdownTimeout: 1, leaseTickMs: 10000 });
    await until(() => interrupted);
    const leased = await bound.get(run.id);
    expect(leased.outputs).toEqual([{ value: 1 }]);
    await expect(bound.resume(run.id)).rejects.toThrow('settling');
    const [prior] = await jobs.list({ where: { objectId: run.id } });
    await oldRunner.stop();
    unregisterLiveWorker(prior.workerId as string);
    await (await SmrtWorkerCollection.create({ db })).expireWorker(
      prior.workerId as string,
    );
    bound = install(execute);
    await worker();
    await until(
      async () =>
        (await jobs.get({ id: prior.id as string }))?.status === 'failed',
    );
    const events = await SmrtJobEventCollection.create({ db });
    expect(
      (await events.listTerminalOutcomes({ tenantId: null })).outcomes.some(
        (event) =>
          event.jobId === prior.id && event.failureKind === 'stale-recovery',
      ),
    ).toBe(true);
    expect((await bound.get(run.id)).leaseRevision).toBe(leased.leaseRevision);
    await expect(bound.resume(run.id, { maxTokens: 500 })).rejects.toThrow(
      'Recover the job first',
    );
    const checkpoint = await bound.get(run.id);
    const admission = vi
      .spyOn(jobs, 'enqueueJob')
      .mockRejectedValueOnce(new Error('Recovery admission failed'));
    await expect(bound.resume(run.id)).rejects.toThrow(
      'Recovery admission failed',
    );
    admission.mockRestore();
    expect(await bound.get(run.id)).toEqual(checkpoint);
    expect(await jobs.list({ where: { objectId: run.id } })).toHaveLength(1);
    await bound.resume(run.id);
    expect((await end(run.id)).status).toBe('done');
    expect(calls.filter((index) => index === 1)).toHaveLength(1);
    expect(calls.filter((index) => index === 2)).toHaveLength(2);
    const done = await bound.get(run.id);
    external.resolve();
    await until(() => oldRunner.activeJobCount() === 0);
    expect(await bound.get(run.id)).toEqual(done);
  });

  it('does not recover an ordinary failed job', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    const [job] = await jobs.list({ where: { objectId: run.id } });
    job.status = 'failed';
    await job.save();
    await expect(bound.resume(run.id)).rejects.toThrow('not recovered');
  });

  it('scopes admission and reads to owners and tenants', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    const other = kit.forOwner('other', null);
    await expect(other.get(run.id)).rejects.toThrow('not found');
    await expect(
      kit.forOwner('owner', randomUUID()).get(run.id),
    ).rejects.toThrow('not found');
    expect((await other.start(startInput())).id).not.toBe(run.id);
    const tenantId = randomUUID();
    const tenant = kit.forOwner('owner', tenantId);
    const scoped = await tenant.start(startInput());
    expect(scoped.id).not.toBe(run.id);
    expect(await tenant.get(scoped.id)).toMatchObject({ id: scoped.id });
    expect(await jobs.list()).toHaveLength(3);
  });

  it('rejects unauthorized admission and invalid idempotency keys', async () => {
    const bound = install(undefined, passes, {
      authorize: async () => {
        throw new Error('Denied');
      },
    });
    await expect(bound.start(startInput())).rejects.toThrow('Denied');
    expect(await jobs.list()).toHaveLength(0);
    const allowed = install();
    await expect(allowed.start(startInput(' '))).rejects.toThrow('key');
  });

  it('refuses approval continuation outside an approval wait', async () => {
    const bound = install();
    const run = await bound.start(startInput());
    await expect(bound.continueAfterApproval(run.id)).rejects.toThrow(
      'not waiting',
    );
  });

  it('routes two host kinds through one executor without duplicate identities', async () => {
    const bound = install();
    const first = kit;
    const second = createDesignRunJobs<Input, Output>({
      db,
      jobs,
      kind: 'second-host',
      definition: 'second-host/v1',
      authorize: async () => {},
      configure: () => ({
        passes: [{ name: 'Analyze', schema }],
        validate: (s, value) => (ajv.validate(s, value) ? [] : ['Invalid']),
        executePass: async () => ({ output: { value: 9 }, metadata }),
        readResource: async () => ({ data: null }),
      }),
    });
    dispose?.();
    dispose = installDesignRunExecutor(db, (record, args, context) => {
      const kind = (args as { kind: string }).kind;
      return (kind === 'example-design' ? first : second).handler(
        record,
        args,
        context,
      );
    });
    const other = second.forOwner('owner', null);
    const a = await bound.start(startInput());
    const b = await other.start(startInput());
    expect(a.id).not.toBe(b.id);
    await worker();
    await until(async () => (await other.get(b.id)).status === 'done');
    expect((await end(a.id)).outputs).toEqual([{ value: 1 }, { value: 2 }]);
    expect((await other.get(b.id)).outputs).toEqual([{ value: 9 }]);
    await expect(bound.get(b.id)).rejects.toThrow('not found');
  });

  it('fails a misrouted job before executing a pass or changing its checkpoint', async () => {
    const execute = vi.fn<DesignRunDriverOptions['executePass']>(async () => ({
      output: { value: 1 },
      metadata,
    }));
    const bound = install(execute);
    const run = await bound.start(startInput());
    const [job] = await jobs.list({ where: { objectId: run.id } });
    job.args = { kind: 'wrong-host' };
    await job.save();
    await worker();
    await jobSettled(run.id);
    expect((await jobs.get({ id: job.id as string }))?.status).toBe('failed');
    expect(await bound.get(run.id)).toEqual(run);
    expect(execute).not.toHaveBeenCalled();
  });

  it('replays a completed run job without executing any pass again', async () => {
    const execute = vi.fn<DesignRunDriverOptions['executePass']>(async () => ({
      output: { value: 1 },
      metadata,
    }));
    const bound = install(execute);
    const run = await bound.start(startInput());
    await worker();
    await end(run.id);
    await jobSettled(run.id);
    await jobs.enqueueJob({
      objectType: '@happyvertical/smrt-inference:DesignRunRecord',
      objectId: run.id,
      method: 'execute',
      args: { kind: 'example-design' },
      maxAttempts: 1,
    });
    await jobSettled(run.id);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
