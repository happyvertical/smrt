import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';

describe('SmrtJobCollection claimReady', () => {
  it('does not return the same ready job to concurrent claim calls', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const jobs = await SmrtJobCollection.create({ db });
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
      jobs.claimReady({
        workerId: 'worker-a',
        queues: ['critical'],
        limit: 1,
        now,
      }),
      jobs.claimReady({
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

    const alreadyClaimed = await jobs.claimReady({
      workerId: 'worker-c',
      queues: ['critical'],
      limit: 1,
      now,
    });
    expect(alreadyClaimed).toEqual([]);

    const claimedOtherQueue = await jobs.claimReady({
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
  });
});
