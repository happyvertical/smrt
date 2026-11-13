import type { DatabaseInterface } from '@happyvertical/sql';
import type { DesignRunState, DesignRunStore } from './design-run.js';
import './models/DesignRunRecord.js';

/** Authenticated host binding; never construct it from model/tool arguments. */
export interface DesignRunStoreOptions {
  db: DatabaseInterface;
  ownerId: string;
  tenantId: string | null;
  /**
   * Enqueue the existing SmrtJob in THIS transaction with dedupeKey = run id.
   * TaskRunner dispatch must reauthorize the owner and pass its own signal to
   * driver.run(). This callback must not start an in-memory executor or timer.
   */
  /** Worker stores check the live TaskRunner claim in this transaction. */
  authorizeWrite?(
    transaction: DatabaseInterface,
    state: Readonly<DesignRunState>,
  ): Promise<boolean>;
  /** Lock and verify the same job/worker/attempt, including terminal Stop. */
  authorizeRelease?(
    transaction: DatabaseInterface,
    state: Readonly<DesignRunState>,
  ): Promise<boolean>;
  enqueue(
    transaction: DatabaseInterface,
    state: Readonly<DesignRunState>,
  ): Promise<void>;
}

/**
 * Owner-scoped workflow persistence with optimistic concurrency. Checkpoint and
 * existing-job admission commit together, including resume after process restart.
 * No schema is created here; the registered model ships through normal migrations.
 */
export function createDesignRunStore(
  options: DesignRunStoreOptions,
): DesignRunStore {
  const { db, ownerId, tenantId } = options;
  if (!ownerId) throw new Error('Design runs require an owner');
  const tenantPredicate =
    tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = ?';
  const identity = (id: string): unknown[] =>
    tenantId === null ? [id, ownerId] : [id, ownerId, tenantId];
  const load = async (connection: DatabaseInterface, id: string) => {
    const result = await connection.query(
      `SELECT payload FROM _smrt_inference_design_runs WHERE id = ? AND owner_id = ? AND ${tenantPredicate}`,
      ...identity(id),
    );
    if (!result.rows.length) return null;
    return JSON.parse(String(result.rows[0].payload)) as DesignRunState;
  };
  return {
    async load(id, requestedOwner) {
      if (requestedOwner !== ownerId) return null;
      return load(db, id);
    },
    async releaseLease(id, requestedOwner, leaseRevision) {
      if (requestedOwner !== ownerId || !options.authorizeRelease) return false;
      if (!db.transaction)
        throw new Error('Design runs require transaction support');
      return db.transaction(async (tx) => {
        const state = await load(tx, id);
        if (
          state?.status !== 'stopped' ||
          state.leaseRevision !== leaseRevision
        )
          return false;
        if (!(await options.authorizeRelease?.(tx, state))) return false;
        const next = {
          ...state,
          revision: state.revision + 1,
          leaseUntil: undefined,
          leaseRevision: undefined,
        };
        const updated = await tx.query(
          `UPDATE _smrt_inference_design_runs SET revision = ?, payload = ?, updated_at = ?
            WHERE id = ? AND owner_id = ? AND ${tenantPredicate} AND revision = ? RETURNING id`,
          next.revision,
          JSON.stringify(next),
          new Date().toISOString(),
          ...identity(id),
          state.revision,
        );
        return updated.rows.length === 1;
      });
    },
    async save(state, expectedRevision) {
      if (state.ownerId !== ownerId) throw new Error('Design run not found');
      if (!db.transaction)
        throw new Error('Design runs require transaction support');
      return db.transaction(async (tx) => {
        if (
          options.authorizeWrite &&
          !(await options.authorizeWrite(tx, state))
        )
          return false;
        const previous = await load(tx, state.id);
        const encoded = JSON.stringify(state);
        const date = new Date().toISOString();
        if (expectedRevision === null) {
          const inserted = await tx.query(
            `INSERT INTO _smrt_inference_design_runs
              (id, slug, context, created_at, updated_at, owner_id, tenant_id, revision, payload)
              VALUES (?, ?, '', ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING id`,
            state.id,
            state.id,
            date,
            date,
            ownerId,
            tenantId,
            state.revision,
            encoded,
          );
          if (inserted.rows.length !== 1) return false;
        } else {
          if (!previous || state.revision !== expectedRevision + 1)
            return false;
          const updated = await tx.query(
            `UPDATE _smrt_inference_design_runs SET revision = ?, payload = ?, updated_at = ?
              WHERE id = ? AND owner_id = ? AND ${tenantPredicate} AND revision = ? RETURNING id`,
            state.revision,
            encoded,
            date,
            ...identity(state.id),
            expectedRevision,
          );
          if (updated.rows.length !== 1) return false;
        }
        if (
          state.status === 'running' &&
          (!previous ||
            previous.status === 'stopped' ||
            previous.status === 'waiting-approval')
        ) {
          await options.enqueue(tx, state);
        }
        return true;
      });
    },
  };
}
