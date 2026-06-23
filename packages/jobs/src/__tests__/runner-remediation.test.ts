/**
 * Regression tests for the #1401 (Tier T2) jobs remediation:
 *
 * - #1 fire-and-forget crash risk: a throwing error path must surface as a
 *   `runner:error` event, never as an unhandled promise rejection.
 * - #2/#3 timeout honesty: a `'fail'` timeout fails the job WITHOUT auto-retry
 *   (the original handler keeps running; re-queueing would duplicate it).
 * - #3 `'warn'` behavior: a slow-but-successful handler that exceeds its
 *   timeout still completes successfully and emits a `timeout-warning` event.
 *
 * Real in-memory SQLite + smrtVitestPlugin; the runner and business logic are
 * never mocked (per .claude/rules/testing.md).
 */

import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundEligible } from '../background-policy.js';
import { createTaskRunner } from '../runner.js';
import { type SmrtJob, SmrtJobCollection } from '../smrt-job.js';

/**
 * A handler we can release on demand, so a "hangs past its timeout" test does
 * not leave a forever-pending promise keeping the worker (and the test) alive.
 */
let releaseHang: (() => void) | null = null;

@smrt()
class RemediationProbe extends SmrtObject {
  // Hangs until the test releases it. With a short `timeout` this exercises the
  // timeout path; the external release lets teardown finish cleanly.
  @backgroundEligible()
  async hangs(): Promise<string> {
    await new Promise<void>((resolve) => {
      releaseHang = resolve;
    });
    return 'eventually';
  }

  // Slower than its timeout but finite: under `timeoutBehavior='warn'` it must
  // still complete successfully.
  @backgroundEligible()
  async slowButFinite(): Promise<string> {
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    return 'done-slowly';
  }

  // Throws so the runner enters its error/retry path.
  @backgroundEligible()
  async alwaysThrows(): Promise<never> {
    throw new Error('boom');
  }
}

function canonicalProbeType(): string {
  return (
    ObjectRegistry.getClass('RemediationProbe')?.qualifiedName ||
    'RemediationProbe'
  );
}

afterEach(() => {
  // Release any still-hanging handler so its promise settles and nothing leaks
  // into the next test.
  releaseHang?.();
  releaseHang = null;
  ObjectRegistry.clearCollectionCache?.();
});

describe('TaskRunner remediation (#1401)', () => {
  it('does not emit an unhandled rejection when the error path throws (#1)', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    const job = await collection.create({
      objectType: canonicalProbeType(),
      method: 'alwaysThrows',
      args: {},
      maxAttempts: 1,
    });
    await job.save();

    // Make the failure-path persistence write reject — the exact scenario in
    // the finding: handleJobError's `db.query` rejecting while writing the
    // terminal 'failed' state (a failure mode correlated with whatever is
    // already failing the job). Without the guards, this rejection escapes the
    // fire-and-forget processJob() caller as a process-level unhandled
    // rejection and crashes the worker.
    //
    // writeOwnedJob binds the status as a parameter (`SET status = ?`), so the
    // terminal-failed write is identified by the ownership-guarded UPDATE shape
    // plus a `'failed'` first parameter — not by a literal in the SQL text.
    const originalQuery = db.query.bind(db);
    (db as unknown as { query: typeof db.query }).query = ((
      sql: string,
      ...params: unknown[]
    ) => {
      if (
        typeof sql === 'string' &&
        sql.includes('UPDATE _smrt_jobs') &&
        sql.includes("AND status = 'running'") &&
        params[0] === 'failed'
      ) {
        return Promise.reject(new Error('failure-write exploded'));
      }
      return originalQuery(sql, ...params);
    }) as typeof db.query;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const runnerError = new Promise<Error>((resolve) => {
      runner.once('runner:error', (error) => resolve(error as Error));
    });

    await runner.start();
    try {
      // The guard converts the rejecting failure-write into a runner:error
      // event...
      const error = await runnerError;
      expect(error.message).toContain('failure-write exploded');
      // ...and after a tick for any pending microtasks to flush...
      await new Promise((r) => setTimeout(r, 50));
      // ...no unhandled rejection escaped to the process.
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      (db as unknown as { query: typeof db.query }).query = originalQuery;
      await runner.stop();
    }
  });

  it('fails a timed-out job WITHOUT auto-retrying it (#2/#3 fail)', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    // maxAttempts=3 would normally retry an ordinary failure; a timeout must
    // NOT be retried (the original handler is still running).
    const job = await collection.create({
      objectType: canonicalProbeType(),
      method: 'hangs',
      args: {},
      timeout: 50,
      timeoutBehavior: 'fail',
      maxAttempts: 3,
    });
    await job.save();

    const runner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      shutdownTimeout: 100,
    });
    await runner.initialize(db);

    const retried: SmrtJob[] = [];
    runner.on('job:retrying', (j) => retried.push(j));
    const failed = new Promise<SmrtJob>((resolve, reject) => {
      runner.once('job:failed', (j) => resolve(j));
      runner.once('job:completed', () =>
        reject(new Error('unexpected complete')),
      );
    });

    await runner.start();
    try {
      await failed;
      // Release the hung handler so shutdown can drain promptly.
      releaseHang?.();

      const persisted = await collection.get({ id: job.id ?? '' });
      expect(persisted?.status).toBe('failed');
      // Claimed exactly once (attempts incremented on claim), never re-queued.
      expect(persisted?.attempts).toBe(1);
      expect(retried).toHaveLength(0);
    } finally {
      releaseHang?.();
      await runner.stop();
    }
  });

  it("completes a slow handler under timeoutBehavior='warn' (#3 warn)", async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const eventCollection = await (
      await import('../smrt-job-event.js')
    ).SmrtJobEventCollection.create({ db });

    const job = await collection.create({
      objectType: canonicalProbeType(),
      method: 'slowButFinite',
      args: {},
      timeout: 50, // shorter than the handler's ~150ms
      timeoutBehavior: 'warn',
      maxAttempts: 1,
    });
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    const completed = new Promise<unknown>((resolve, reject) => {
      runner.once('job:completed', (_j, result) => resolve(result));
      runner.once('job:failed', (_j, error) => reject(error));
    });

    await runner.start();
    try {
      const result = (await completed) as { result?: unknown };
      expect(result.result).toBe('done-slowly');

      const persisted = await collection.get({ id: job.id ?? '' });
      expect(persisted?.status).toBe('completed');

      // A warning event was recorded at the deadline (honest 'warn'). The job
      // is global (no tenant), so the tenant-scoped query needs tenantId: null.
      const events = await eventCollection.listByJob(job.id ?? '', {
        tenantId: null,
      });
      expect(events.some((e) => e.stage === 'timeout-warning')).toBe(true);
    } finally {
      await runner.stop();
    }
  });
});
