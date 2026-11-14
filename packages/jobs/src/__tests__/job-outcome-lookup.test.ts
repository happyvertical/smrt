import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';

it('looks up an exact completion despite 1,001 newer unrelated outcomes and rejects another tenant', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  try {
    const jobs = await SmrtJobCollection.create({ db });
    const events = await SmrtJobEventCollection.create({ db });
    const job = await jobs.enqueueJob({
      objectType: 'LookupProbe',
      method: 'run',
    });
    await job.cancel();
    await db.transaction?.(async (tx) => {
      const scoped = await SmrtJobEventCollection.create({ db: tx });
      for (let index = 0; index < 1001; index++)
        await scoped.append({
          jobId: randomUUID(),
          tenantId: null,
          message: 'Lookup fixture',
          stage: 'failed',
          createdAt: new Date(Date.now() + 1000 + index),
          data: {
            version: 1,
            terminal: true,
            status: 'failed',
            queue: 'default',
            objectType: 'LookupProbe',
            method: 'run',
            attempts: 1,
            failureKind: 'execution',
            completedAt: new Date().toISOString(),
          },
        });
    });
    expect(
      (
        await events.listTerminalOutcomes({ tenantId: null, limit: 1000 })
      ).outcomes.some((outcome) => outcome.jobId === job.id),
    ).toBe(false);
    expect(
      await events.getTerminalOutcome(job.id as string, {
        tenantId: null,
        attempts: 0,
        completedAt: job.completedAt?.toISOString(),
      }),
    ).toMatchObject({ jobId: job.id, status: 'cancelled' });
    expect(
      await events.getTerminalOutcome(job.id as string, {
        tenantId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await events.getTerminalOutcome(job.id as string, {
        tenantId: null,
        attempts: 99,
      }),
    ).toBeNull();
    expect(
      await events.getTerminalOutcome(job.id as string, {
        tenantId: null,
        completedAt: 'other',
      }),
    ).toBeNull();
    await expect(
      events.getTerminalOutcome(job.id as string, {
        tenantId: undefined as never,
      }),
    ).rejects.toThrow('tenantId');
    await events.append({
      jobId: job.id as string,
      tenantId: null,
      message: 'Malformed fixture',
      stage: 'failed',
      createdAt: new Date(Date.now() + 10000),
      data: { version: 99, terminal: true },
    });
    expect(
      await events.getTerminalOutcome(job.id as string, { tenantId: null }),
    ).toMatchObject({ status: 'cancelled' });
  } finally {
    await db.close?.();
  }
});
