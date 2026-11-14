import type { DatabaseInterface } from '@happyvertical/sql';
import { isPerConnectionMemoryUrl } from '../embedded-write-queue.js';
import { DatabaseError } from '../errors.js';
import { isTableVerified, markTableVerified } from '../table-cache.js';

const memoryVerificationKeys = new WeakMap<DatabaseInterface, string>();
let nextMemoryVerificationId = 0;

function getVerificationKey(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseInterface & {
    dbid?: string;
    config?: { dbid?: string; url?: string };
  };

  const dbid = dbWithConfig.dbid || dbWithConfig.config?.dbid;
  if (dbid) {
    return dbid;
  }

  const dbUrl = db.url || dbWithConfig.config?.url;
  if (dbUrl && !isPerConnectionMemoryUrl(dbUrl)) {
    return dbUrl;
  }

  let memoryKey = memoryVerificationKeys.get(db);
  if (!memoryKey) {
    nextMemoryVerificationId += 1;
    memoryKey = `memory:${nextMemoryVerificationId}`;
    memoryVerificationKeys.set(db, memoryKey);
  }

  return memoryKey;
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
