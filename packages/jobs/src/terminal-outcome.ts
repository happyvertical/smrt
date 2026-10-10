import { randomUUID } from 'node:crypto';
import { ensureJobEventsSystemTableCompatibility } from '@happyvertical/smrt-core';
import { ensureSchema } from '@happyvertical/smrt-core/schema/utils';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { JobStatus, SmrtJob } from './smrt-job.js';
import { SmrtJobEvent, type SmrtJobTerminalStatus } from './smrt-job-event.js';

const terminalStorageReady = new WeakMap<object, Promise<void>>();

async function ensureTerminalOutcomeStorage(
  db: DatabaseInterface,
): Promise<void> {
  const key = db as object;
  const existing = terminalStorageReady.get(key);
  if (existing) return existing;

  const pending = (async () => {
    // SmrtJob.cancel() has historically worked for consumers that prepare only
    // the job model. Terminal outcomes now require their package-owned event
    // table as well, so prepare that registered schema before opening the
    // state+event transaction. Never fall back to a state-only transition.
    await ensureSchema(db, 'SmrtJobEvent');
    await ensureJobEventsSystemTableCompatibility(db);
  })();
  terminalStorageReady.set(key, pending);
  try {
    await pending;
  } catch (error) {
    terminalStorageReady.delete(key);
    throw error;
  }
}

export interface SmrtJobTerminalSnapshot {
  id: string;
  tenantId: string | null;
  queue: string;
  objectType: string;
  method: string;
  attempts: number;
}

export interface TransitionTerminalJobOptions {
  job: SmrtJobTerminalSnapshot;
  status: SmrtJobTerminalStatus;
  completedAt: Date;
  expectedStatuses: JobStatus[];
  expectedWorkerId?: string | null;
  expectedTaskId?: string;
  clearWorker?: boolean;
  lastError?: string | null;
  failureKind?: 'execution' | 'timeout' | 'stale-recovery';
  resultPointer?: string | null;
  taskResult?: Record<string, unknown> | null;
}

/**
 * Atomically persist an owned terminal job transition and its durable outcome.
 *
 * A null result means the conditional transition lost a race. Neither the job
 * row nor an event is written in that case.
 */
export async function transitionTerminalJob(
  db: DatabaseInterface,
  options: TransitionTerminalJobOptions,
): Promise<SmrtJobEvent | null> {
  if (!db.transaction) {
    throw new Error('Terminal job transitions require transaction support');
  }
  if (options.expectedStatuses.length === 0) {
    throw new Error('Terminal job transitions require an expected status');
  }

  await ensureTerminalOutcomeStorage(db);

  const persisted = await db.transaction(async (tx) => {
    const assignments: Array<[string, unknown]> = [
      ['status', options.status],
      ['completed_at', options.completedAt.toISOString()],
      ['updated_at', options.completedAt.toISOString()],
    ];
    if (options.clearWorker) {
      assignments.push(['worker_id', null], ['worker_heartbeat', null]);
    }
    if (options.lastError !== undefined) {
      assignments.push(['last_error', options.lastError]);
    }
    if (options.resultPointer !== undefined) {
      assignments.push(['result_pointer', options.resultPointer]);
    }
    if (options.taskResult !== undefined) {
      assignments.push([
        'task_result',
        options.taskResult === null ? null : JSON.stringify(options.taskResult),
      ]);
    }

    const where = ['id = ?'];
    const whereValues: unknown[] = [options.job.id];
    if (options.job.tenantId === null) {
      where.push('tenant_id IS NULL');
    } else {
      where.push('tenant_id = ?');
      whereValues.push(options.job.tenantId);
    }
    where.push(
      `status IN (${options.expectedStatuses.map(() => '?').join(', ')})`,
    );
    whereValues.push(...options.expectedStatuses);
    if (options.expectedWorkerId === null) {
      where.push('worker_id IS NULL');
    } else if (options.expectedWorkerId !== undefined) {
      where.push('worker_id = ?');
      whereValues.push(options.expectedWorkerId);
    }
    if (options.expectedTaskId !== undefined) {
      where.push('task_id = ?');
      whereValues.push(options.expectedTaskId);
    }

    const updated = await tx.query(
      `UPDATE _smrt_jobs
          SET ${assignments.map(([column]) => `${column} = ?`).join(', ')}
        WHERE ${where.join(' AND ')}
        RETURNING CAST(tenant_id AS VARCHAR) AS tenant_id,
                  queue, object_type, method, attempts`,
      ...assignments.map(([, value]) => value),
      ...whereValues,
    );
    if (updated.rows.length !== 1) return null;
    const authoritative = updated.rows[0] as {
      tenant_id: string | null;
      queue: string;
      object_type: string;
      method: string;
      attempts: number | string;
    };
    const attempts = Number(authoritative.attempts);
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error('Terminal job transition returned invalid attempts');
    }

    const stage =
      options.status === 'failed' && options.failureKind === 'stale-recovery'
        ? 'stale-recovery'
        : options.status;
    const id = randomUUID();
    const type =
      options.status === 'completed'
        ? 'progress'
        : options.status === 'failed'
          ? 'error'
          : 'status';
    const level = options.status === 'failed' ? 'error' : 'info';
    const progress = options.status === 'completed' ? 100 : null;
    const message = `Job ${options.status}`;
    const data = {
      version: 1,
      terminal: true,
      status: options.status,
      queue: authoritative.queue,
      objectType: authoritative.object_type,
      method: authoritative.method,
      attempts,
      completedAt: options.completedAt.toISOString(),
      ...(options.status === 'failed' && options.failureKind
        ? { failureKind: options.failureKind }
        : {}),
    };
    const timestamp = options.completedAt.toISOString();
    await tx.query(
      `INSERT INTO _smrt_job_events
        (id, slug, context, created_at, updated_at, tenant_id, job_id,
         type, level, stage, progress, message, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      id,
      '',
      timestamp,
      timestamp,
      authoritative.tenant_id,
      options.job.id,
      type,
      level,
      stage,
      progress,
      message,
      JSON.stringify(data),
    );
    return {
      id,
      slug: id,
      context: '',
      created_at: timestamp,
      updated_at: timestamp,
      tenant_id: authoritative.tenant_id,
      job_id: options.job.id,
      type,
      level,
      stage,
      progress,
      message,
      data,
    };
  });

  if (!persisted) return null;
  const event = new SmrtJobEvent({ db });
  await event.initialize();
  await event.loadDataFromDb(persisted);
  return event;
}

export function terminalSnapshot(
  job: Pick<
    SmrtJob,
    'id' | 'tenantId' | 'queue' | 'objectType' | 'method' | 'attempts'
  >,
): SmrtJobTerminalSnapshot | null {
  if (!job.id) return null;
  return {
    id: job.id,
    tenantId: job.tenantId ?? null,
    queue: job.queue,
    objectType: job.objectType,
    method: job.method,
    attempts: job.attempts,
  };
}
