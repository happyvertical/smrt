/**
 * SMRT Testing Utilities
 *
 * Provides utilities for testing SMRT objects in isolation.
 * The main export is `getTestDatabase()` which creates an in-memory
 * database with all registered schemas pre-created.
 * `snapshotObjectRegistryState()` isolates sequential registry-mutating fixtures;
 * its restore callback is test cleanup, not a production application lifecycle API.
 *
 * @example
 * ```typescript
 * import { getTestDatabase } from '@happyvertical/smrt-core/testing';
 *
 * beforeEach(async () => {
 *   const db = await getTestDatabase();
 *   collection = await MyCollection.create({ db });
 * });
 * ```
 *
 * @packageDocumentation
 */

export { getTestDatabase, type TestDatabaseOptions } from './database.js';
export {
  type StubNotification,
  type StubNotificationsHandle,
  stubNotifications,
} from './notifications-stub.js';
export { snapshotObjectRegistryState } from './registry-state.js';
