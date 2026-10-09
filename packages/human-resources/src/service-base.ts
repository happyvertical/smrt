import { createLogger } from '@happyvertical/logger';
import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteQueue,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface, TransactionHandle } from '@happyvertical/sql';
import {
  type HrActor,
  HrError,
  type HrEvent,
  type HrServiceOptions,
} from './types.js';

const logger = createLogger({ level: 'info' });

function isNestedTransactionError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NestedTransactionError';
}

/** Collects events inside a transaction; they are delivered after it commits. */
export type HrEventQueue = (event: HrEvent) => void;

/**
 * Shared plumbing for the HR services: a trusted tenant/profile actor, scoped
 * reads, serialized transactional writes, and after-commit event delivery.
 * Applications authorize the actor before constructing a service. Reads and
 * writes reject conflicting ambient tenancy.
 *
 * Construct a service with the root database handle. A mutation begins and
 * commits its own transaction with `beginTransaction()` and then delivers its
 * events; on a handle that is already inside a transaction (the `tx` of
 * `db.transaction()`, or a `beginTransaction()` handle) the commit would
 * belong to the caller, so a mutation is refused with
 * `HR_TRANSACTION_UNSUPPORTED` before anything is written. Such a handle
 * either has no `beginTransaction` or refuses it with the SDK's
 * `NestedTransactionError`; the service never opens a nested (savepoint)
 * transaction. Reads work on any handle.
 */
export abstract class HrService {
  protected readonly actor: Readonly<HrActor>;
  private readonly onEvent: HrServiceOptions['onEvent'];

  constructor(
    protected readonly db: DatabaseInterface,
    actor: HrActor,
    options: HrServiceOptions = {},
  ) {
    if (!actor?.tenantId?.trim() || !actor?.profileId?.trim())
      throw new HrError(
        'HR_ACTOR_INVALID',
        'HR services require a trusted tenant/profile actor.',
      );
    this.actor = Object.freeze({
      tenantId: this.identity(actor.tenantId),
      profileId: this.identity(actor.profileId),
    });
    this.onEvent = options.onEvent;
  }

  /** Normalize an id; PostgreSQL stores identities as UUIDs. */
  protected identity(value: string): string {
    if (!isPostgresDatabase(this.db)) return value;
    const hex = value.replace(/[{}-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex))
      throw new HrError(
        'HR_INVALID',
        'PostgreSQL HR identities must be UUIDs.',
      );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  /**
   * A required id from caller input, trimmed and normalized.
   *
   * @throws HrError `HR_INVALID` when it is not text or is blank
   */
  protected id(fieldName: string, value: unknown): string {
    if (typeof value !== 'string' || !value.trim())
      throw new HrError('HR_INVALID', `${fieldName} is required.`);
    return this.identity(value.trim());
  }

  /** An optional id from caller input: null or undefined is null. */
  protected optionalId(fieldName: string, value: unknown): string | null {
    return value === null || value === undefined
      ? null
      : this.id(fieldName, value);
  }

  /** Run a read inside the actor's tenant. */
  protected scope<T>(run: () => Promise<T>): Promise<T> {
    const active = getTenantId();
    if (active && this.identity(active) !== this.actor.tenantId)
      throw new HrError(
        'HR_TENANT_MISMATCH',
        'HR actor differs from active tenant.',
      );
    return withTenant({ tenantId: this.actor.tenantId }, run);
  }

  /**
   * Run a mutation in one transaction, serialized per tenant, then deliver the
   * events it queued. Nothing is delivered when the transaction fails.
   *
   * @throws HrError `HR_TRANSACTION_UNSUPPORTED` when the service was constructed with a handle that is already inside a transaction
   */
  protected async transact<T>(
    run: (db: DatabaseInterface, queue: HrEventQueue) => Promise<T>,
  ): Promise<T> {
    // `@happyvertical/sql` has no after-commit hook and no marker for "inside
    // a transaction", so the service begins a transaction of its own and
    // commits it itself; it never calls `transaction()`, which on a
    // transaction-scoped handle would re-enter the caller's transaction under
    // a savepoint. Only a root handle can begin one: a transaction-scoped
    // handle has no `beginTransaction` (libsql SQLite, PostgreSQL, DuckDB,
    // JSON) or refuses it with `NestedTransactionError` before touching the
    // connection (the native-capabilities SQLite adapter). Both fail closed.
    const unsupported = () =>
      new HrError(
        'HR_TRANSACTION_UNSUPPORTED',
        'HR services must be constructed with the root database handle, not one that is already inside a transaction: events are delivered when the service commits its own transaction.',
      );
    const begin = this.db.beginTransaction;
    if (typeof begin !== 'function') throw unsupported();
    const events: HrEvent[] = [];
    const result = await this.scope(() =>
      withEmbeddedWriteQueue(this.db, isEmbeddedDatabase(this.db), async () => {
        let tx: TransactionHandle;
        try {
          tx = await begin.call(this.db);
        } catch (error) {
          // Matched by name: the sql root (pg, node:fs) is not importable from
          // a browser-safe model root, and the SDK sets this name on the class.
          if (isNestedTransactionError(error)) throw unsupported();
          throw error;
        }
        let value: T;
        try {
          if (isPostgresDatabase(this.db))
            await tx.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              JSON.stringify(['smrt.human-resources', this.actor.tenantId]),
            );
          value = await run(tx, (event) => events.push(event));
        } catch (error) {
          await tx.rollback().catch(() => undefined);
          throw error;
        }
        // A failed commit ends the handle itself (the SDK rolls back and
        // releases the connection), so it is not rolled back again here.
        await tx.commit();
        return value;
      }),
    );
    for (const event of events) await this.emit(event);
    return result;
  }

  private async emit(event: HrEvent): Promise<void> {
    if (!this.onEvent) return;
    try {
      await this.onEvent(event);
    } catch (error) {
      logger.error(
        `[smrt-human-resources] onEvent handler failed for ${event.type}`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}
