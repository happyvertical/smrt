/**
 * Batched commits for permission-catalog and role-permission seeding.
 * @packageDocumentation
 */

import {
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Rows a seeding pass writes per transaction (#3323).
 *
 * A cold seed writes every catalog permission and every default grant, each
 * with a change-feed append: thousands of rows on a real registry. When every
 * row autocommits, each is a separate durable commit. On a file-backed SQLite
 * database with `synchronous = FULL` (the local runtime profile), that is an
 * `fsync` per row, and disk flushes, not queries, set the bootstrap's wall
 * clock. Batching cuts the commits by this factor.
 *
 * The batch is bounded, not the whole seed, because a transaction scope in
 * `@happyvertical/sql` tracks every promise created while it is open and
 * keeps each statement's rejection observation until the transaction ends,
 * so its per-statement cost grows with the statements already issued. On the
 * local owner claim, one catalog-wide transaction took ~17s against ~4.5s for
 * batches of 25-100 rows (and ~30s for per-row commits on a real disk).
 */
export const SEEDING_BATCH_SIZE = 50;

/**
 * Write `items` in transactions of at most {@link SEEDING_BATCH_SIZE} rows.
 *
 * Seeding is idempotent and additive, so committing per batch keeps the
 * semantics of the previous per-row commits: an interrupted pass leaves only
 * complete rows behind, and re-running converges. `write` receives the handle
 * bound to its batch's transaction and must issue every write through it.
 *
 * Nesting follows `@happyvertical/sql`'s rules. Given a transaction handle,
 * SQLite and PostgreSQL re-enter it under a SAVEPOINT, and adapters without
 * savepoints (DuckDB/JSON) reuse the caller's transaction directly. A handle
 * with no `transaction()` keeps per-statement commits. A caller already inside
 * a transaction must pass that transaction's handle: on a single-connection
 * adapter the root handle waits for the open transaction instead of joining
 * it.
 *
 * @internal
 */
export async function writeInSeedingBatches<T>(
  db: DatabaseInterface,
  items: readonly T[],
  write: (database: DatabaseInterface, batch: readonly T[]) => Promise<void>,
): Promise<void> {
  for (let start = 0; start < items.length; start += SEEDING_BATCH_SIZE) {
    const batch = items.slice(start, start + SEEDING_BATCH_SIZE);
    if (typeof db.transaction !== 'function') {
      await write(db, batch);
      continue;
    }
    await withEmbeddedWriteTransaction(
      db,
      isEmbeddedDatabase(db),
      (database) => write(database, batch),
      true,
    );
  }
}
