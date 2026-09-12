import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  isRunnerExecutionContext,
  type JobExecutionContext,
  type SmrtJob,
  SmrtJobCollection,
} from '@happyvertical/smrt-jobs';
import {
  getTenantId,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
import type {
  DataSurfaceActionResult,
  DataSurfaceJsonObject,
} from '@happyvertical/smrt-ui/data';
import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  DataSurfaceBackgroundActionEnvelope,
  DataSurfaceBackgroundActionJob,
  DataSurfaceBackgroundQueue,
} from './data-surface-actions.js';

const handlers = new Map<
  string,
  (
    envelope: DataSurfaceBackgroundActionEnvelope,
  ) => Promise<DataSurfaceActionResult>
>();

export interface DataSurfaceActionJobArgs {
  version: 1;
  envelope: DataSurfaceBackgroundActionEnvelope;
}

export interface JobsDataSurfaceBackgroundQueueOptions {
  db: DatabaseInterface;
  handlerId: string;
  execute(
    envelope: DataSurfaceBackgroundActionEnvelope,
  ): Promise<DataSurfaceActionResult>;
  queue?: string;
  priority?: number;
  timeout?: number;
  maxAttempts?: number;
  tenantJobCap?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: '_smrt_data_surface_action_tasks',
  api: false,
  cli: false,
  mcp: false,
})
export class SmrtDataSurfaceActionTask extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ type: 'json', required: true })
  args: DataSurfaceActionJobArgs = {
    version: 1,
    envelope: {} as DataSurfaceBackgroundActionEnvelope,
  };

  @backgroundEligible()
  async run(
    args: DataSurfaceActionJobArgs = this.args,
    context?: JobExecutionContext,
  ): Promise<DataSurfaceActionResult> {
    const envelope = args?.envelope;
    if (context && !isRunnerExecutionContext(context)) {
      throw new Error('Invalid durable data-surface action job context');
    }
    const jobTenantId =
      context?.job.tenantId ?? this.tenantId ?? getTenantId() ?? null;
    if (
      args?.version !== 1 ||
      envelope?.version !== 1 ||
      typeof envelope.handlerId !== 'string' ||
      envelope.handlerId.length === 0 ||
      envelope.principal?.tenantId !== jobTenantId
    ) {
      throw new Error('Invalid durable data-surface action envelope');
    }
    const handler = handlers.get(envelope.handlerId);
    if (!handler) {
      throw new Error(
        `No data-surface action handler registered for ${envelope.handlerId}`,
      );
    }
    const result = await handler(envelope);
    if (!result.ok && result.reason === 'idempotency_in_progress') {
      throw new Error('Data-surface action outcome requires reconciliation');
    }
    return result;
  }
}

/**
 * Register the host handler used by workers after process restart.
 * The returned disposer only removes the same registration.
 */
export function registerDataSurfaceBackgroundActionHandler(
  handlerId: string,
  execute: (
    envelope: DataSurfaceBackgroundActionEnvelope,
  ) => Promise<DataSurfaceActionResult>,
): () => void {
  if (!handlerId || handlerId.length > 256) {
    throw new Error(
      'Data-surface action handlerId must contain 1-256 characters',
    );
  }
  const existing = handlers.get(handlerId);
  if (existing && existing !== execute) {
    throw new Error(
      `Data-surface action handler already registered: ${handlerId}`,
    );
  }
  handlers.set(handlerId, execute);
  return () => {
    if (handlers.get(handlerId) === execute) handlers.delete(handlerId);
  };
}

export function createJobsDataSurfaceBackgroundQueue(
  options: JobsDataSurfaceBackgroundQueueOptions,
): DataSurfaceBackgroundQueue & { unregister(): void } {
  const unregister = registerDataSurfaceBackgroundActionHandler(
    options.handlerId,
    options.execute,
  );
  return {
    unregister,
    async enqueue(job: DataSurfaceBackgroundActionJob) {
      if (job.envelope.handlerId !== options.handlerId) {
        throw new Error('Data-surface action envelope handler mismatch');
      }
      const persisted = await enqueueDataSurfaceActionJob(
        options,
        job.envelope,
      );
      if (!persisted.id)
        throw new Error('Durable data-surface action job has no ID');
      return {
        jobId: persisted.id,
        details: { queue: persisted.queue } as DataSurfaceJsonObject,
      };
    },
  };
}

async function enqueueDataSurfaceActionJob(
  options: JobsDataSurfaceBackgroundQueueOptions,
  envelope: DataSurfaceBackgroundActionEnvelope,
): Promise<SmrtJob> {
  await ObjectRegistry.ensureManifestLoaded('SmrtJob');
  const jobs = await SmrtJobCollection.create({ db: options.db });
  const registered =
    ObjectRegistry.getClassByConstructor(SmrtDataSurfaceActionTask) ??
    ObjectRegistry.getClass('SmrtDataSurfaceActionTask');
  const objectType =
    registered?.qualifiedName ??
    registered?.name ??
    SmrtDataSurfaceActionTask.name;
  return jobs.enqueueJob(
    {
      tenantId: envelope.principal.tenantId,
      queue: options.queue ?? 'data-surface-actions',
      objectType,
      objectId: null,
      method: 'run',
      args: { version: 1, envelope },
      priority: options.priority ?? 70,
      timeout: options.timeout ?? 300_000,
      maxAttempts: options.maxAttempts ?? 3,
    },
    { tenantJobCap: options.tenantJobCap },
  );
}
