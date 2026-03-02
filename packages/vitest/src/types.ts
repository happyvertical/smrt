/**
 * Transaction handle types
 *
 * These are temporary type definitions that will be replaced when
 * SDK PR #722 is merged and @happyvertical/sql is updated.
 *
 * @see https://github.com/happyvertical/sdk/pull/722
 */

import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Transaction handle for manual transaction control.
 *
 * Extends `DatabaseInterface` with explicit `commit`/`rollback` methods,
 * as opposed to the callback-based `transaction()` helper.  Returned by
 * `DatabaseInterfaceWithTransaction.beginTransaction()`.
 *
 * The handle is also a full `DatabaseInterface`, so all read/write operations
 * (`get`, `list`, `insert`, `update`, `delete`, `query`) can be called on it
 * and will execute within the open transaction.
 *
 * @see {@link DatabaseInterfaceWithTransaction.beginTransaction}
 */
export interface TransactionHandle extends DatabaseInterface {
  /**
   * Commit the transaction, making all pending changes permanent.
   *
   * @returns A promise that resolves once the commit is complete.
   * @throws If the transaction has already been committed or rolled back.
   */
  commit: () => Promise<void>;

  /**
   * Roll back the transaction, discarding all pending changes.
   *
   * @returns A promise that resolves once the rollback is complete.
   * @throws If the transaction has already been committed or rolled back.
   */
  rollback: () => Promise<void>;

  /**
   * Return whether the transaction is still open.
   *
   * @returns `true` until `commit()` or `rollback()` has been called,
   *   `false` afterwards.
   */
  isActive: () => boolean;
}

/**
 * Extended `DatabaseInterface` that adds support for manual transaction control.
 *
 * This interface augments the base SDK `DatabaseInterface` until
 * {@link https://github.com/happyvertical/sdk/pull/722 SDK PR #722} is merged
 * and `@happyvertical/sql` is updated to include `beginTransaction()` natively.
 */
export interface DatabaseInterfaceWithTransaction extends DatabaseInterface {
  /**
   * Begin a new transaction with manual control.
   *
   * Unlike `transaction()` which uses a callback pattern, this returns
   * a handle that allows explicit commit/rollback control.
   *
   * @example
   * ```typescript
   * const tx = await db.beginTransaction();
   * try {
   *   await tx.insert('users', { id: '1', name: 'Alice' });
   *   await tx.commit();
   * } catch (error) {
   *   await tx.rollback();
   *   throw error;
   * }
   * ```
   */
  beginTransaction?: () => Promise<TransactionHandle>;
}
