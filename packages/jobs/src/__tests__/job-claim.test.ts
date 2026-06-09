import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';

describe('SmrtJobCollection claimReady', () => {
  it('returns claimed jobs in scheduler order for multi-slot claims', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
    const now = new Date('2026-06-08T22:00:00.000Z');

    await jobs.create({
      queue: 'ordered',
      objectType: 'LowPriorityProbe',
      method: 'run',
      runAt: new Date('2026-06-08T21:55:00.000Z'),
      priority: 1,
    });
    await jobs.create({
      queue: 'ordered',
      objectType: 'HighPriorityProbe',
      method: 'run',
      runAt: new Date('2026-06-08T21:58:00.000Z'),
      priority: 99,
    });
    await jobs.create({
      queue: 'ordered',
      objectType: 'MiddlePriorityProbe',
      method: 'run',
      runAt: new Date('2026-06-08T21:57:00.000Z'),
      priority: 50,
    });

    const claimed = await jobs.claimReady({
      workerId: 'worker-order',
      queues: ['ordered'],
      limit: 3,
      now,
    });

    expect(claimed.map((job) => job.objectType)).toEqual([
      'HighPriorityProbe',
      'MiddlePriorityProbe',
      'LowPriorityProbe',
    ]);
  });

  it('does not return the same ready job to concurrent claim calls', async () => {
    const dbUrl = tmpDbUrl('job-claim-concurrent');
    const dbPath = dbUrl.replace('file:', '');
    let seedDb: DatabaseInterface | undefined;
    let workerADb: DatabaseInterface | undefined;
    let workerBDb: DatabaseInterface | undefined;

    try {
      seedDb = await getTestDatabase({ type: 'sqlite', url: dbUrl });
      workerADb = await getTestDatabase({ type: 'sqlite', url: dbUrl });
      workerBDb = await getTestDatabase({ type: 'sqlite', url: dbUrl });

      const jobs = await SmrtJobCollection.create({ db: seedDb });
      const workerAJobs = await SmrtJobCollection.create({ db: workerADb });
      const workerBJobs = await SmrtJobCollection.create({ db: workerBDb });
      const now = new Date('2026-06-08T22:00:00.000Z');

      const target = await jobs.create({
        queue: 'critical',
        objectType: 'ClaimProbe',
        method: 'run',
        runAt: new Date('2026-06-08T21:59:00.000Z'),
        priority: 75,
      });
      const otherQueue = await jobs.create({
        queue: 'other',
        objectType: 'ClaimProbe',
        method: 'run',
        runAt: new Date('2026-06-08T21:58:00.000Z'),
        priority: 100,
      });

      const [workerA, workerB] = await Promise.all([
        workerAJobs.claimReady({
          workerId: 'worker-a',
          queues: ['critical'],
          limit: 1,
          now,
        }),
        workerBJobs.claimReady({
          workerId: 'worker-b',
          queues: ['critical'],
          limit: 1,
          now,
        }),
      ]);

      const claimed = [...workerA, ...workerB];
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(target.id);
      expect(claimed[0].status).toBe('running');
      expect(claimed[0].attempts).toBe(1);
      expect(claimed[0].workerId).toMatch(/^worker-[ab]$/);
      expect(claimed[0].startedAt?.toISOString()).toBe(now.toISOString());
      expect(claimed[0].workerHeartbeat?.toISOString()).toBe(now.toISOString());

      const alreadyClaimed = await workerAJobs.claimReady({
        workerId: 'worker-c',
        queues: ['critical'],
        limit: 1,
        now,
      });
      expect(alreadyClaimed).toEqual([]);

      const claimedOtherQueue = await workerBJobs.claimReady({
        workerId: 'worker-c',
        queues: ['other'],
        limit: 1,
        now,
      });
      expect(claimedOtherQueue.map((job) => job.id)).toEqual([otherQueue.id]);

      const persistedTarget = await jobs.get({ id: target.id ?? '' });
      expect(persistedTarget?.status).toBe('running');
      expect(persistedTarget?.attempts).toBe(1);
      expect(persistedTarget?.workerId).toMatch(/^worker-[ab]$/);
    } finally {
      await closeDatabases(seedDb, workerADb, workerBDb);
      unlinkIfExists(dbPath);
      unlinkIfExists(`${dbPath}-shm`);
      unlinkIfExists(`${dbPath}-wal`);
    }
  });
});

function tmpDbUrl(name: string): string {
  return `file:${join(tmpdir(), `${name}-${randomUUID()}.db`)}`;
}

async function closeDatabases(
  ...databases: Array<DatabaseInterface | undefined>
): Promise<void> {
  await Promise.all(databases.map((db) => db?.close?.()));
}

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
