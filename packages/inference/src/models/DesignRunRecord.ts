import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Host installation is process-local; queued work remains durable in SmrtJob. */
export type DesignRunExecutor = (
  record: DesignRunRecord,
  args: unknown,
  context: unknown,
) => Promise<unknown>;
const executors = new WeakMap<DatabaseInterface, DesignRunExecutor>();
/** Install the authenticated TaskRunner bridge for this database; returns teardown. */
export function installDesignRunExecutor(
  db: DatabaseInterface,
  execute: DesignRunExecutor,
): () => void {
  if (executors.has(db))
    throw new Error('A design run executor is already installed');
  executors.set(db, execute);
  return () => {
    if (executors.get(db) === execute) executors.delete(db);
  };
}

/**
 * Domain checkpoint, not a queue: SmrtJob owns admission, worker liveness and
 * cancellation. Generated mutations are closed; the host's authenticated store
 * binds owner and tenant on every operation. Migrate before using the driver.
 */
@smrt({
  tableName: '_smrt_inference_design_runs',
  api: false,
  cli: false,
  mcp: false,
  indexes: [
    {
      name: 'idx_inference_design_runs_owner',
      columns: ['ownerId', 'tenantId'],
    },
  ],
})
export class DesignRunRecord extends SmrtObject {
  static readonly backgroundEligibleMethods = ['execute'];

  /** Internal job target, never exposed as an API, CLI or MCP action. */
  async execute(args: unknown, context?: unknown): Promise<unknown> {
    const execute = executors.get(this.db);
    if (!execute) throw new Error('No host design run executor is installed');
    return execute(this, args, context);
  }

  @field({ required: true, requiredFor: 'identity' })
  ownerId: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  @field()
  revision: number = 0;

  /** JSON text avoids driver-specific JSON materialization on read/CAS. */
  @field({ type: 'text', required: true, requiredFor: 'workflow-state' })
  payload: string = '';
}
