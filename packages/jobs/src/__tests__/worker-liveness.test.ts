import {
  getTestDatabase,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtWorkerCollection } from '../smrt-worker.js';
import {
  registerLiveWorker,
  unregisterLiveWorker,
} from '../worker-liveness.js';

@smrt()
class LivenessProbe extends SmrtObject {
  async noop(): Promise<string> {
    return 'ok';
  }

  // Synchronously holds the event loop, the exact condition (#1474) that
  // previously starved the per-job heartbeat and triggered false recovery.
  async blockThenReturn(args: { ms?: number }): Promise<string> {
    const end = Date.now() + (args.ms ?? 50);
    while (Date.now() < end) {
      // busy-wait: block the loop so timers/poll cannot fire
    }
    return 'blocked-done';
  }
}

afterEach(() => {
  ObjectRegistry.clearCollectionCache?.();
});

async function poll(
  runner: ReturnType<typeof createTaskRunner>,
): Promise<void> {
  await (runner as unknown as { poll(): Promise<void> }).poll();
}

describe('worker-lease recovery (#1474)', () => {
  it('never recovers jobs owned by a worker live in this process, even with no lease', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    // A worker live in THIS process but with no fresh _smrt_workers lease — the
    // state a CPU-bound handler leaves behind when its lease lapses during a
    // synchronous block.
    registerLiveWorker('blocked-worker');
    try {
      const job = await collection.create({
        objectType: 'LivenessProbe',
        method: 'noop',
        args: {},
      });
      job.status = 'running';
      job.workerId = 'blocked-worker';
      job.startedAt = new Date('2020-01-01T00:00:00.000Z');
      await job.save();

      // A different runner runs recovery; the live set takes precedence.
      const other = createTaskRunner({ concurrency: 1, pollInterval: 10 });
      await other.initialize(db);
      await poll(other);

      const after = await collection.get({ id: job.id ?? '' });
      expect(after?.status).toBe('running');
      expect(after?.workerId).toBe('blocked-worker');
    } finally {
      unregisterLiveWorker('blocked-worker');
    }
  });

  it('recovers a job whose owning worker is unknown (no lease, not live)', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });

    const job = await collection.create({
      objectType: 'LivenessProbe',
      method: 'noop',
      args: {},
    });
    job.status = 'running';
    job.workerId = 'dead-runner';
    job.startedAt = new Date('2020-01-01T00:00:00.000Z');
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    await poll(runner);

    const after = await collection.get({ id: job.id ?? '' });
    expect(after?.status).toBe('failed');
    expect(after?.workerId).toBeNull();
    expect(after?.lastError).toContain('owning worker is no longer alive');
  });

  it('does not recover a job owned by another worker holding a fresh lease', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const workers = await SmrtWorkerCollection.create({ db });
    await workers.registerWorker({ workerKey: 'peer', leaseTtlMs: 60_000 });

    const job = await collection.create({
      objectType: 'LivenessProbe',
      method: 'noop',
      args: {},
    });
    job.status = 'running';
    job.workerId = 'peer';
    job.startedAt = new Date('2020-01-01T00:00:00.000Z');
    await job.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    await poll(runner);

    const after = await collection.get({ id: job.id ?? '' });
    expect(after?.status).toBe('running');
  });

  it('start() fails fast with a migration hint when _smrt_workers is missing', async () => {
    // Simulate a consumer that upgraded smrt-jobs without running migrations:
    // the jobs table exists but the workers table was never created.
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await db.query('DROP TABLE IF EXISTS _smrt_workers');

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);

    await expect(runner.start()).rejects.toThrow(/_smrt_workers|db:migrate/);
    await runner.stop();
  });

  it('runs a job that synchronously blocks the event loop to completion without false recovery', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const canonical =
      ObjectRegistry.getClass('LivenessProbe')?.qualifiedName ??
      'LivenessProbe';

    await collection.create({
      objectType: canonical,
      method: 'blockThenReturn',
      // Block far longer than the (floored) lease TTL so the lease genuinely
      // lapses mid-handler; the in-process live set must still protect it.
      args: { ms: 250 },
      timeout: 10_000,
    });

    const runner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      leaseTickMs: 20,
      leaseTtlMs: 60,
    });
    await runner.initialize(db);
    await runner.start();

    try {
      // Wait for the job to reach a terminal state.
      const deadline = Date.now() + 8_000;
      let status = 'pending';
      while (Date.now() < deadline) {
        const rows = await db.query(
          "SELECT status FROM _smrt_jobs WHERE method = 'blockThenReturn' LIMIT 1",
        );
        status =
          (rows.rows[0] as { status?: string } | undefined)?.status ?? '';
        if (status === 'completed' || status === 'failed') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(status).toBe('completed');
    } finally {
      await runner.stop();
    }
  });

  // DuckDB exercises two engine-portability hazards SQLite cannot: a future
  // lease timestamp (an integer epoch-ms column would overflow INT32 here), and
  // the adapter's rowCount reporting (always ≥1 on DuckDB) — recovery must use
  // RETURNING, not rowCount, to decide what actually transitioned.
  it('registers leases and recovers correctly on DuckDB', async () => {
    const db = await getTestDatabase({ type: 'duckdb', url: ':memory:' });
    const collection = await SmrtJobCollection.create({ db });
    const workers = await SmrtWorkerCollection.create({ db });

    await workers.registerWorker({
      workerKey: 'duck-live',
      leaseTtlMs: 60_000,
    });
    const fresh = await workers.freshLeaseWorkerKeys();
    expect(fresh.has('duck-live')).toBe(true);

    const liveJob = await collection.create({
      objectType: 'LivenessProbe',
      method: 'noop',
      args: {},
    });
    liveJob.status = 'running';
    liveJob.workerId = 'duck-live';
    liveJob.startedAt = new Date();
    await liveJob.save();

    const deadJob = await collection.create({
      objectType: 'LivenessProbe',
      method: 'noop',
      args: {},
    });
    deadJob.status = 'running';
    deadJob.workerId = 'duck-dead';
    deadJob.startedAt = new Date();
    await deadJob.save();

    const runner = createTaskRunner({ concurrency: 1, pollInterval: 10 });
    await runner.initialize(db);
    await poll(runner);

    expect((await collection.get({ id: liveJob.id ?? '' }))?.status).toBe(
      'running',
    );
    expect((await collection.get({ id: deadJob.id ?? '' }))?.status).toBe(
      'failed',
    );
  });
});
