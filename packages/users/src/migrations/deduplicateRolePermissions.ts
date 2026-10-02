import {
  bumpChangeFeed,
  ensureChangeFeedTable,
  isEmbeddedDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Options for the explicit, maintenance-window grant migration. */
export interface DeduplicateRolePermissionsOptions {
  /** Inspect the duplicate count without changing rows or indexes. */
  dryRun?: boolean;
  /** Confirm all application writers and seeders are stopped. */
  maintenanceConfirmed?: boolean;
}

/** Result of the grant migration; removed is zero for a dry run. */
export interface DeduplicateRolePermissionsResult {
  duplicates: number;
  removed: number;
}

const duplicateIds = `SELECT id FROM (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY role_id, permission_id
    ORDER BY created_at ASC NULLS LAST, id ASC
  ) AS duplicate_rank FROM role_permissions
) AS ranked WHERE duplicate_rank > 1`;

/**
 * Keep the oldest grant for each role/permission pair and install its unique
 * index. Run BEFORE ordinary schema migration, with every writer stopped;
 * old application versions cannot safely seed against the new constraint.
 * Equal timestamps use the lowest id; null timestamps sort last. The surviving
 * row is unchanged. Deletion, index creation and change notification commit
 * together, so failure leaves the old grants intact. Re-running is safe.
 */
export async function deduplicateRolePermissions(
  db: DatabaseInterface,
  options: DeduplicateRolePermissionsOptions = {},
): Promise<DeduplicateRolePermissionsResult> {
  const count = async (handle: DatabaseInterface): Promise<number> => {
    const result = await handle.query(
      `SELECT COUNT(*) AS count FROM (${duplicateIds}) AS duplicates`,
    );
    return Number(result.rows[0].count);
  };
  if (options.dryRun) return { duplicates: await count(db), removed: 0 };
  if (!options.maintenanceConfirmed) {
    throw new Error(
      'Stop all writers and seeders, then set maintenanceConfirmed: true.',
    );
  }
  if (!db.transaction) {
    throw new Error('Grant deduplication requires a root transaction handle.');
  }
  await ensureChangeFeedTable(db);
  return withEmbeddedWriteTransaction(
    db,
    isEmbeddedDatabase(db),
    async (tx) => {
      if (!isEmbeddedDatabase(db)) {
        await tx.query('LOCK TABLE role_permissions IN EXCLUSIVE MODE');
      }
      const duplicates = await count(tx);
      if (duplicates > 0) {
        await tx.query(
          `DELETE FROM role_permissions WHERE id IN (${duplicateIds})`,
        );
      }
      await tx.query(
        'CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_role_id_permission_id_idx ON role_permissions (role_id, permission_id)',
      );
      if (duplicates > 0) {
        await bumpChangeFeed(tx, {
          table: 'role_permissions',
          operation: 'delete',
        });
      }
      return { duplicates, removed: duplicates };
    },
  );
}
