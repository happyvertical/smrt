import type { DatabaseInterface } from '@happyvertical/sql';
import { DatabaseError } from '../errors.js';
import { assertDatabaseMigratedForBuild } from '../migrations/startup-guard.js';
import { getDatabaseEngine } from '../system/compatibility.js';
import {
  getVerificationKey,
  isTableVerified,
  markTableVerified,
} from '../table-cache.js';

/**
 * Verify that a model table already exists.
 *
 * Runtime no longer creates application tables implicitly. This helper is the
 * shared fail-fast path used by collections and objects before they touch app
 * tables, while still caching successful checks to avoid repeated round-trips.
 */
export async function verifyPersistenceTable(
  db: DatabaseInterface,
  tableName: string,
  className: string,
  engineHint?: string,
): Promise<void> {
  await assertDatabaseMigratedForBuild(db, {
    engineHint: getDatabaseEngine(db, engineHint),
  });
  const verificationKey = getVerificationKey(db);
  if (isTableVerified(verificationKey, tableName)) {
    return;
  }

  const tableExists = await db.tableExists(tableName);
  if (!tableExists) {
    throw DatabaseError.schemaMissing(tableName, className);
  }

  markTableVerified(verificationKey, tableName);
}
