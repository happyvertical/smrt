import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { SmrtJobCollection } from '../smrt-job.js';
import { SmrtJobEventCollection } from '../smrt-job-event.js';
import {
  terminalSnapshot,
  transitionTerminalJob,
} from '../terminal-outcome.js';

async function fixture() {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  const jobs = await SmrtJobCollection.create({ db });
  const events = await SmrtJobEventCollection.create({ db });
  const job = await jobs.create({
    tenantId: 'tenant-a',
    queue: 'reports',
    objectType: 'SmrtDataSurfaceActionTask',
    objectId: 'private-object-id',
    method: 'run',
    args: { secret: 'never-project-this' },
  });
  const snapshot = terminalSnapshot(job);
  if (!snapshot) throw new Error('Expected persisted job');
  return { db, jobs, events, job, snapshot };
}

describe('atomic terminal job outcomes', () => {
  it('commits the owned job state and one safe terminal projection together', async () => {
    const { db, jobs, events, job, snapshot } = await fixture();
    const completedAt = new Date('2026-10-09T04:00:00.000Z');

    const event = await transitionTerminalJob(db, {
      job: snapshot,
      status: 'completed',
      completedAt,
      expectedStatuses: ['pending'],
      resultPointer: 'private-result-pointer',
    });

    expect(event?.stage).toBe('completed');
    expect((await jobs.get({ id: job.id }))?.status).toBe('completed');
    const page = await events.listTerminalOutcomes({
      tenantId: 'tenant-a',
      queues: ['reports'],
      objectTypes: ['SmrtDataSurfaceActionTask'],
      methods: ['run'],
    });
    expect(page).toMatchObject({
      candidateLimit: 1000,
      truncated: false,
      nextCursor: null,
      outcomes: [
        {
          jobId: job.id,
          tenantId: 'tenant-a',
          status: 'completed',
          queue: 'reports',
          objectType: 'SmrtDataSurfaceActionTask',
          method: 'run',
          attempts: 0,
          completedAt: completedAt.toISOString(),
        },
      ],
    });
    expect(JSON.stringify(page)).not.toContain('private-object-id');
    expect(JSON.stringify(page)).not.toContain('private-result-pointer');
    expect(JSON.stringify(page)).not.toContain('never-project-this');
  });

  it('rolls back the job state when terminal event persistence fails', async () => {
    const { db, jobs, job, snapshot } = await fixture();
    await db.query(`CREATE TRIGGER fail_terminal_outcome
      BEFORE INSERT ON _smrt_job_events
      WHEN NEW.stage = 'completed'
      BEGIN
        SELECT RAISE(FAIL, 'terminal event rejected');
      END`);

    await expect(
      transitionTerminalJob(db, {
        job: snapshot,
        status: 'completed',
        completedAt: new Date(),
        expectedStatuses: ['pending'],
      }),
    ).rejects.toThrow(/terminal event rejected/);

    expect((await jobs.get({ id: job.id }))?.status).toBe('pending');
  });

  it('writes no event when a conditional terminal transition loses its race', async () => {
    const { db, events, snapshot } = await fixture();
    const first = await transitionTerminalJob(db, {
      job: snapshot,
      status: 'completed',
      completedAt: new Date(),
      expectedStatuses: ['pending'],
    });
    const lost = await transitionTerminalJob(db, {
      job: snapshot,
      status: 'failed',
      completedAt: new Date(),
      expectedStatuses: ['pending'],
      failureKind: 'execution',
    });

    expect(first).not.toBeNull();
    expect(lost).toBeNull();
    expect(
      (await events.listTerminalOutcomes({ tenantId: 'tenant-a' })).outcomes,
    ).toHaveLength(1);
  });

  it('persists cancellation through the public job API', async () => {
    const { events, job } = await fixture();
    await job.cancel();

    const page = await events.listTerminalOutcomes({ tenantId: 'tenant-a' });
    expect(page.outcomes).toMatchObject([
      { jobId: job.id, status: 'cancelled' },
    ]);
  });

  it('rejects retained cross-tenant cancellation and preserves system bypass', async () => {
    const { events, job } = await fixture();

    await expect(
      withTenant({ tenantId: 'tenant-b' }, () => job.cancel()),
    ).rejects.toBeInstanceOf(TenantIsolationError);
    expect(job.status).toBe('pending');
    expect(
      (await events.listTerminalOutcomes({ tenantId: 'tenant-a' })).outcomes,
    ).toEqual([]);

    await withSystemContext(() => job.cancel());
    expect(job.status).toBe('cancelled');
    expect(
      (await events.listTerminalOutcomes({ tenantId: 'tenant-a' })).outcomes,
    ).toMatchObject([{ status: 'cancelled' }]);
  });

  it('projects authoritative fields returned by the conditional update', async () => {
    const { db, events, snapshot } = await fixture();
    await db.query(
      `UPDATE _smrt_jobs
          SET status = 'running', attempts = 1, worker_id = 'worker-a'
        WHERE id = ?`,
      snapshot.id,
    );

    await transitionTerminalJob(db, {
      job: snapshot,
      status: 'cancelled',
      completedAt: new Date(),
      expectedStatuses: ['running'],
      expectedWorkerId: 'worker-a',
    });

    expect(
      (await events.listTerminalOutcomes({ tenantId: 'tenant-a' })).outcomes,
    ).toMatchObject([{ status: 'cancelled', attempts: 1 }]);
  });

  it('preserves the stale-recovery event stage while projecting failed', async () => {
    const { db, events, job, snapshot } = await fixture();
    const event = await transitionTerminalJob(db, {
      job: snapshot,
      status: 'failed',
      completedAt: new Date(),
      expectedStatuses: ['pending'],
      failureKind: 'stale-recovery',
    });

    expect(event?.stage).toBe('stale-recovery');
    expect(
      (
        await events.listTerminalOutcomes({
          tenantId: 'tenant-a',
          statuses: ['failed'],
        })
      ).outcomes,
    ).toMatchObject([
      {
        jobId: job.id,
        status: 'failed',
        failureKind: 'stale-recovery',
      },
    ]);
  });

  it('requires an explicit tenant and filters only safe terminal facts', async () => {
    const { db, events, snapshot } = await fixture();
    await transitionTerminalJob(db, {
      job: snapshot,
      status: 'failed',
      completedAt: new Date(),
      expectedStatuses: ['pending'],
      lastError: 'token=secret-value',
      failureKind: 'timeout',
    });

    await expect(
      events.listTerminalOutcomes({ tenantId: undefined as never }),
    ).rejects.toThrow(/require tenantId/);
    const hidden = await events.listTerminalOutcomes({
      tenantId: 'tenant-a',
      queues: ['other'],
    });
    expect(hidden.outcomes).toEqual([]);
    const visible = await events.listTerminalOutcomes({
      tenantId: 'tenant-a',
      statuses: ['failed'],
    });
    expect(visible.outcomes[0]?.failureKind).toBe('timeout');
    expect(JSON.stringify(visible)).not.toContain('secret-value');
  });

  it('ignores unknown and malformed projection payloads', async () => {
    const { events, job } = await fixture();
    const completedAt = new Date().toISOString();
    const valid = {
      version: 1,
      terminal: true,
      status: 'failed',
      queue: 'reports',
      objectType: 'SmrtDataSurfaceActionTask',
      method: 'run',
      attempts: 1,
      completedAt,
    };
    await events.append({
      tenantId: 'tenant-a',
      jobId: job.id ?? '',
      stage: 'failed',
      message: 'malformed fixture',
      data: { ...valid, version: 2 },
    });
    await events.append({
      tenantId: 'tenant-a',
      jobId: job.id ?? '',
      stage: 'failed',
      message: 'malformed fixture',
      data: { ...valid, status: 'invented' },
    });
    await events.append({
      tenantId: 'tenant-a',
      jobId: job.id ?? '',
      stage: 'failed',
      message: 'malformed fixture',
      data: { ...valid, method: undefined },
    });
    await events.append({
      tenantId: 'tenant-a',
      jobId: job.id ?? '',
      stage: 'failed',
      message: 'malformed fixture',
      data: { ...valid, failureKind: 'provider-secret-message' },
    });

    const page = await events.listTerminalOutcomes({ tenantId: 'tenant-a' });
    expect(page.outcomes).toEqual([]);
  });
});
