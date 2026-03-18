import type { DatabaseInterface } from '@happyvertical/sql';
import { DatabaseError } from '../errors.js';
import { isTableVerified, markTableVerified } from '../table-cache.js';

function getVerificationKey(db: DatabaseInterface): string {
  return db.url || ':memory:';
}

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
): Promise<void> {
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
