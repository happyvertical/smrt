import {
  bumpChangeFeed,
  ensureChangeFeedTable,
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Options shared by the maintenance-window natural-key migrations. */
export interface NaturalKeyDedupOptions {
  /** Inspect the duplicate count without changing rows or indexes. */
  dryRun?: boolean;
  /** Confirm all application writers and seeders are stopped. */
  maintenanceConfirmed?: boolean;
}

/** Per-table result; removed is zero for a dry run. */
export interface NaturalKeyDedupResult {
  duplicates: number;
  removed: number;
}

/** One table whose rows must be unique on a column pair. */
export interface NaturalKeyDedupTarget {
  table: string;
  columns: readonly [string, string];
  /** Unique index the generated schema declares for the pair. */
  index: string;
  /**
   * Leading ORDER BY terms that choose the survivor before the oldest-row
   * rule, e.g. the effect the resolver already applies for the pair.
   */
  survivorOrder?: string;
}

function duplicateIdsSql(target: NaturalKeyDedupTarget): string {
  const order = [target.survivorOrder, 'created_at ASC NULLS LAST', 'id ASC']
    .filter(Boolean)
    .join(', ');
  return `SELECT id FROM (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY ${target.columns.join(', ')}
    ORDER BY ${order}
  ) AS duplicate_rank FROM ${target.table}
) AS ranked WHERE duplicate_rank > 1`;
}

/**
 * Remove natural-key duplicates and install each target's unique index in one
 * transaction, so failure leaves every table as it was. Run BEFORE ordinary
 * schema migration with every writer stopped. Re-running is safe.
 */
export async function deduplicateNaturalKeys(
  db: DatabaseInterface,
  targets: readonly NaturalKeyDedupTarget[],
  options: NaturalKeyDedupOptions,
  label: string,
): Promise<NaturalKeyDedupResult[]> {
  const count = async (
    handle: DatabaseInterface,
    target: NaturalKeyDedupTarget,
  ): Promise<number> => {
    const result = await handle.query(
      `SELECT COUNT(*) AS count FROM (${duplicateIdsSql(target)}) AS duplicates`,
    );
    return Number(result.rows[0].count);
  };
  if (options.dryRun) {
    const results: NaturalKeyDedupResult[] = [];
    for (const target of targets) {
      results.push({ duplicates: await count(db, target), removed: 0 });
    }
    return results;
  }
  if (!options.maintenanceConfirmed) {
    throw new Error(
      'Stop all writers and seeders, then set maintenanceConfirmed: true.',
    );
  }
  if (!db.transaction) {
    throw new Error(`${label} requires a root transaction handle.`);
  }
  await ensureChangeFeedTable(db);
  return withEmbeddedWriteTransaction(
    db,
    isEmbeddedDatabase(db),
    async (tx) => {
      if (!isEmbeddedDatabase(db)) {
        for (const target of targets) {
          await tx.query(`LOCK TABLE ${target.table} IN EXCLUSIVE MODE`);
        }
      }
      const results: NaturalKeyDedupResult[] = [];
      for (const target of targets) {
        const duplicates = await count(tx, target);
        if (duplicates > 0) {
          await tx.query(
            `DELETE FROM ${target.table} WHERE id IN (${duplicateIdsSql(target)})`,
          );
        }
        await tx.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS ${target.index} ON ${target.table} (${target.columns.join(', ')})`,
        );
        if (duplicates > 0) {
          await bumpChangeFeed(tx, {
            table: target.table,
            operation: 'delete',
          });
        }
        results.push({ duplicates, removed: duplicates });
      }
      return results;
    },
  );
}
