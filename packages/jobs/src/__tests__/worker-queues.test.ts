import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { SmrtWorkerCollection } from '../smrt-worker.js';
import { runLivenessTicker } from '../worker-liveness-ticker.js';

async function storedQueues(
  workers: SmrtWorkerCollection,
  key: string,
): Promise<unknown> {
  const rows = (
    await workers.db.query(
      'SELECT queues FROM _smrt_workers WHERE worker_id = ?',
      key,
    )
  ).rows as Array<{ queues?: unknown }>;
  const raw = rows[0]?.queues;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

describe('SmrtWorker.queues (#3902)', () => {
  it('records queues at registration and answers liveWorkerKeysForQueue', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const workers = await SmrtWorkerCollection.create({ db });
    await workers.registerWorker({
      workerKey: 'w-default',
      leaseTtlMs: 10_000,
      queues: ['default', 'mail'],
    });
    await workers.registerWorker({ workerKey: 'w-none', leaseTtlMs: 10_000 });
    await workers.registerWorker({
      workerKey: 'w-expired',
      leaseTtlMs: -1_000,
      queues: ['agents'],
    });

    expect(await storedQueues(workers, 'w-default')).toEqual([
      'default',
      'mail',
    ]);
    expect(await workers.liveWorkerKeysForQueue('mail')).toEqual(
      new Set(['w-default']),
    );
    expect(await workers.liveWorkerKeysForQueue('agents')).toEqual(new Set());
    expect(await workers.liveWorkerKeysForQueue('nope')).toEqual(new Set());
  });

  it('renewLease refreshes queues when given', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const workers = await SmrtWorkerCollection.create({ db });
    await workers.registerWorker({ workerKey: 'w', leaseTtlMs: 10_000 });
    await workers.renewLease('w', 10_000);
    expect(await storedQueues(workers, 'w')).toBeNull();
    await workers.renewLease('w', 10_000, ['agents']);
    expect(await storedQueues(workers, 'w')).toEqual(['agents']);
  });

  it('the off-loop ticker writes queues on renewal', async () => {
    const dbUrl = `file:${join(tmpdir(), `worker-queues-${randomUUID()}.db`)}`;
    const seed = await getTestDatabase({ type: 'sqlite', url: dbUrl });
    const workers = await SmrtWorkerCollection.create({ db: seed });
    await workers.registerWorker({ workerKey: 'tw', leaseTtlMs: 10_000 });
    const ticker = await runLivenessTicker({
      url: dbUrl,
      type: 'sqlite',
      workerKey: 'tw',
      leaseTtlMs: 10_000,
      leaseTickMs: 60_000,
      queues: ['agents'],
    });
    try {
      expect(await storedQueues(workers, 'tw')).toEqual(['agents']);
    } finally {
      await ticker.stop();
      for (const f of ['', '-wal', '-shm']) {
        rmSync(`${dbUrl.slice(5)}${f}`, { force: true });
      }
    }
  });

  it('a started TaskRunner registers its configured queues', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const runner = createTaskRunner({
      queues: ['agents'],
      pollInterval: 60_000,
    });
    await runner.initialize(db);
    await runner.start();
    try {
      const workers = await SmrtWorkerCollection.create({ db });
      expect((await workers.liveWorkerKeysForQueue('agents')).size).toBe(1);
      expect((await workers.liveWorkerKeysForQueue('default')).size).toBe(0);
    } finally {
      await runner.stop();
    }
  });
});
