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
 * Extends DatabaseInterface with commit/rollback methods for explicit
 * transaction management (as opposed to the callback-based `transaction()`).
 */
export interface TransactionHandle extends DatabaseInterface {
  /**
   * Commit the transaction, making all changes permanent.
   * @throws If transaction already ended
   */
  commit: () => Promise<void>;

  /**
   * Rollback the transaction, discarding all changes.
   * @throws If transaction already ended
   */
  rollback: () => Promise<void>;

  /**
   * Check if the transaction is still active.
   * Returns false after commit() or rollback() has been called.
   */
  isActive: () => boolean;
}

/**
 * Extended DatabaseInterface with beginTransaction support.
 * This augments the base interface until SDK is updated.
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
