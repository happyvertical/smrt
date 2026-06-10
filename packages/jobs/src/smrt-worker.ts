// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import './__smrt-register__.js';

import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Liveness record for a single TaskRunner / ScheduleRunner incarnation,
 * stored in the `_smrt_workers` system table.
 *
 * @remarks
 * Job recovery asks "is this job's owning worker alive?" rather than "is this
 * job's heartbeat fresh?" (issue #1474). Each running worker keeps a row here
 * and renews `leaseExpiresAt` on a fixed cadence; a worker that dies stops
 * renewing and its lease expires, so its `running` jobs are recovered.
 *
 * `workerId` is unique per *incarnation* (a restarted runner gets a new key —
 * see `createWorkerKey`), which is what lets recovery distinguish a crashed
 * worker's orphaned jobs from an identically-configured restart.
 *
 * `leaseExpiresAt` is a `datetime` so it maps to a real timestamp column on
 * every engine (an integer epoch-ms column overflows `int4`/`INT32` on
 * Postgres and DuckDB). Stage 1 writes/compares it against the host clock —
 * the same approach the previous heartbeat recovery used; Stage 2 will move to
 * database-side time once an off-loop writer exists.
 */
@smrt({
  tableName: '_smrt_workers',
  conflictColumns: ['worker_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class SmrtWorker extends SmrtObject {
  /** Per-incarnation-unique worker key (also stored on owned jobs' workerId). */
  @field({ type: 'text', required: true })
  workerId: string = '';

  /** OS process id of the owning runner (diagnostic). */
  @field({ type: 'integer', nullable: true })
  pid: number | null = null;

  /** Hostname of the owning runner (diagnostic). */
  @field({ type: 'text', nullable: true })
  hostname: string | null = null;

  /** When this incarnation started. */
  @field({ type: 'datetime', nullable: true })
  startedAt: Date | null = null;

  /** Last lease renewal time (diagnostic; liveness uses leaseExpiresAt). */
  @field({ type: 'datetime', nullable: true })
  heartbeatAt: Date | null = null;

  /** Lease expiry — the worker is alive while this is in the future. */
  @field({ type: 'datetime', nullable: true })
  leaseExpiresAt: Date | null = null;

  /** Lifecycle status (`running` while the runner is processing). */
  @field({ type: 'text', required: true, default: 'running' })
  status: string = 'running';
}

export interface RegisterWorkerInput {
  workerKey: string;
  pid?: number | null;
  hostname?: string | null;
  leaseTtlMs: number;
}

/**
 * Collection for managing `_smrt_workers` liveness rows.
 */
export class SmrtWorkerCollection extends SmrtCollection<SmrtWorker> {
  static readonly _itemClass = SmrtWorker;

  /**
   * Fail fast if the `_smrt_workers` table has not been migrated.
   *
   * The framework never creates application/system tables at runtime; the
   * table is created by `smrt db:migrate` (or `getTestDatabase`). A consumer
   * that upgrades smrt-jobs without migrating must get a clear, actionable
   * error at `start()` rather than a confusing recovery failure later.
   */
  async assertReady(): Promise<void> {
    try {
      await this.db.query('SELECT 1 FROM _smrt_workers LIMIT 1');
    } catch (error) {
      throw new Error(
        'The _smrt_workers table is missing. Run `smrt db:migrate` to create ' +
          'job-system tables before starting a TaskRunner/ScheduleRunner. ' +
          `(underlying error: ${(error as Error).message})`,
      );
    }
  }

  /** Whether the `_smrt_workers` table exists (recovery skips lease checks if not). */
  async tableReady(): Promise<boolean> {
    try {
      await this.db.query('SELECT 1 FROM _smrt_workers LIMIT 1');
      return true;
    } catch {
      return false;
    }
  }

  /** Register a worker incarnation with its lease seeded to `now + ttl`. */
  async registerWorker(input: RegisterWorkerInput): Promise<void> {
    const now = new Date();
    await this.create({
      workerId: input.workerKey,
      pid: input.pid ?? null,
      hostname: input.hostname ?? null,
      startedAt: now,
      heartbeatAt: now,
      // Seed the lease in the same write so the worker is immediately "alive",
      // closing the window between registration and the first claimReady().
      leaseExpiresAt: new Date(now.getTime() + input.leaseTtlMs),
      status: 'running',
    });
  }

  /** Renew a worker's lease to `now + ttl`. */
  async renewLease(workerKey: string, leaseTtlMs: number): Promise<void> {
    const now = new Date();
    await this.db.query(
      `UPDATE _smrt_workers
          SET lease_expires_at = ?,
              heartbeat_at = ?
        WHERE worker_id = ?`,
      new Date(now.getTime() + leaseTtlMs).toISOString(),
      now.toISOString(),
      workerKey,
    );
  }

  /** Remove a worker incarnation (graceful shutdown). */
  async expireWorker(workerKey: string): Promise<void> {
    await this.db.query(
      'DELETE FROM _smrt_workers WHERE worker_id = ?',
      workerKey,
    );
  }

  /** Worker keys whose database lease is still fresh (alive cross-process). */
  async freshLeaseWorkerKeys(): Promise<Set<string>> {
    const result = await this.db.query(
      `SELECT worker_id
         FROM _smrt_workers
        WHERE lease_expires_at IS NOT NULL
          AND lease_expires_at >= ?`,
      new Date().toISOString(),
    );
    const keys = new Set<string>();
    for (const row of result.rows as Array<{ worker_id?: unknown }>) {
      if (typeof row.worker_id === 'string') keys.add(row.worker_id);
    }
    return keys;
  }

  /** Delete worker rows whose lease expired more than `graceMs` ago. */
  async pruneExpired(graceMs: number): Promise<void> {
    const cutoff = new Date(Date.now() - Math.max(0, graceMs)).toISOString();
    await this.db.query(
      `DELETE FROM _smrt_workers
        WHERE lease_expires_at IS NOT NULL
          AND lease_expires_at < ?`,
      cutoff,
    );
  }
}

export default SmrtWorker;
