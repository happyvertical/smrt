import type { DatabaseInterface } from '@happyvertical/sql';
import {
  deduplicateNaturalKeys,
  type NaturalKeyDedupOptions,
  type NaturalKeyDedupResult,
} from './natural-key-dedup.js';

/** Options for the explicit, maintenance-window grant migration. */
export type DeduplicateRolePermissionsOptions = NaturalKeyDedupOptions;

/** Result of the grant migration; removed is zero for a dry run. */
export type DeduplicateRolePermissionsResult = NaturalKeyDedupResult;

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
  const [result] = await deduplicateNaturalKeys(
    db,
    [
      {
        table: 'role_permissions',
        columns: ['role_id', 'permission_id'],
        index: 'role_permissions_role_id_permission_id_idx',
      },
    ],
    options,
    'Grant deduplication',
  );
  return result;
}
