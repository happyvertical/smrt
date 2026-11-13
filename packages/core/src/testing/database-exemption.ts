import type { DatabaseInterface } from '@happyvertical/sql';

// Only handles successfully prepared by getTestDatabase are exempt. Keeping
// this separate avoids importing the Node-only test database builder at runtime.
const preparedTestDatabases = new WeakSet<DatabaseInterface>();

export function markPreparedTestDatabase(db: DatabaseInterface): void {
  preparedTestDatabases.add(db);
}

export function isPreparedTestDatabase(db: DatabaseInterface): boolean {
  return preparedTestDatabases.has(db);
}
