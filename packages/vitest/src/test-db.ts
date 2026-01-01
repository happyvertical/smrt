/**
 * Test database utilities for SMRT tests
 *
 * Automatically uses PostgreSQL when DATABASE_URL is set (CI environment),
 * otherwise creates unique SQLite temp files to avoid concurrency issues.
 *
 * Supports transaction-based test isolation: each test runs in a transaction
 * that gets rolled back, ensuring clean state between tests.
 *
 * @example Basic usage
 * ```typescript
 * import { getTestDbConfig, createTestDb } from '@happyvertical/smrt-vitest';
 *
 * const { config, cleanup } = await createTestDb();
 * // Use config...
 * await cleanup();
 * ```
 *
 * @example Transaction isolation (recommended for parallel tests)
 * ```typescript
 * import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';
 *
 * const { db, cleanup } = await createIsolatedTestDb({ schema: mySchema });
 * // All operations run in a transaction
 * await db.insert('users', { id: '1', name: 'Test' });
 * // cleanup() rolls back the transaction - no data persists
 * await cleanup();
 * ```
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DatabaseInterfaceWithTransaction,
  TransactionHandle,
} from './types';

export type TestDbAdapter = 'sqlite' | 'postgres';

export interface TestDbConfig {
  type: 'sqlite' | 'postgres';
  url: string;
}

/**
 * Detect the database adapter to use based on environment
 *
 * Uses PostgreSQL if DATABASE_URL is set, otherwise SQLite
 */
export function getTestAdapter(): TestDbAdapter {
  // Explicit adapter override
  if (process.env.TEST_DB_ADAPTER) {
    return process.env.TEST_DB_ADAPTER as TestDbAdapter;
  }

  // Use Postgres if DATABASE_URL is set (CI environment)
  if (process.env.DATABASE_URL) {
    return 'postgres';
  }

  // Default to SQLite for local development
  return 'sqlite';
}

/**
 * Check if PostgreSQL is available (via DATABASE_URL)
 */
export function isPostgresAvailable(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Get database configuration for tests
 *
 * Uses PostgreSQL when DATABASE_URL is set, otherwise creates
 * a unique SQLite temp file to avoid concurrency issues.
 *
 * @param prefix - Optional prefix for the temp file name
 */
export function getTestDbConfig(prefix = 'smrt-test'): TestDbConfig {
  const adapter = getTestAdapter();
  const testId = randomUUID().slice(0, 8);

  switch (adapter) {
    case 'postgres':
      return {
        type: 'postgres',
        url:
          process.env.DATABASE_URL ||
          `postgresql://postgres:postgres@${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}/test_db`,
      };
    default:
      // Use unique temp file to avoid concurrency issues
      return {
        type: 'sqlite',
        url: join(tmpdir(), `${prefix}-${testId}.db`),
      };
  }
}

/**
 * Get an in-memory SQLite config (for tests that don't need persistence)
 *
 * Note: :memory: databases are isolated per connection, so they're safe
 * for concurrent tests within the same process, but can't be shared.
 */
export function getInMemoryDbConfig(): TestDbConfig {
  return {
    type: 'sqlite',
    url: ':memory:',
  };
}

/**
 * Create a test database and return cleanup function
 *
 * @param prefix - Optional prefix for the temp file name
 */
export async function createTestDb(prefix = 'smrt-test'): Promise<{
  config: TestDbConfig;
  cleanup: () => Promise<void>;
}> {
  const config = getTestDbConfig(prefix);

  const cleanup = async () => {
    // Clean up SQLite file-based databases
    if (
      config.type === 'sqlite' &&
      config.url !== ':memory:' &&
      existsSync(config.url)
    ) {
      // Small delay to allow any pending writes
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        rmSync(config.url, { force: true });
        // Also remove -wal and -shm files if they exist
        rmSync(`${config.url}-wal`, { force: true });
        rmSync(`${config.url}-shm`, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    // For Postgres, we might want to clean up test tables
    // but for now we'll rely on the test isolation
  };

  return { config, cleanup };
}

/**
 * Get display name for the current adapter (for test descriptions)
 */
export function getAdapterDisplayName(): string {
  const adapter = getTestAdapter();
  switch (adapter) {
    case 'postgres':
      return 'PostgreSQL';
    default:
      return 'SQLite';
  }
}

/**
 * Options for creating an isolated test database
 */
export interface IsolatedTestDbOptions {
  /**
   * SQL schema to sync before running tests
   */
  schema?: string;

  /**
   * Optional prefix for temp file name (SQLite only)
   */
  prefix?: string;
}

/**
 * Result from createIsolatedTestDb
 */
export interface IsolatedTestDbResult {
  /**
   * The transaction handle - use this for all database operations.
   * All operations run within the transaction.
   */
  db: TransactionHandle;

  /**
   * The underlying database connection (before transaction).
   * Only use this for operations that must be outside the transaction.
   */
  baseDb: DatabaseInterfaceWithTransaction;

  /**
   * Database configuration used
   */
  config: TestDbConfig;

  /**
   * Cleanup function - rolls back the transaction and closes connection.
   * ALWAYS call this in afterEach() or finally block.
   */
  cleanup: () => Promise<void>;
}

/**
 * Create a test database with transaction isolation.
 *
 * Each test runs in a transaction that gets rolled back on cleanup,
 * ensuring complete isolation between tests without the overhead of
 * creating/dropping tables or databases.
 *
 * This is the recommended approach for parallel test execution,
 * especially with PostgreSQL in CI.
 *
 * @param options - Configuration options
 * @returns Transaction handle and cleanup function
 *
 * @example
 * ```typescript
 * import { createIsolatedTestDb } from '@happyvertical/smrt-vitest';
 * import { beforeEach, afterEach, it } from 'vitest';
 *
 * let db: TransactionHandle;
 * let cleanup: () => Promise<void>;
 *
 * beforeEach(async () => {
 *   const result = await createIsolatedTestDb({
 *     schema: `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)`
 *   });
 *   db = result.db;
 *   cleanup = result.cleanup;
 * });
 *
 * afterEach(async () => {
 *   await cleanup(); // Rolls back - no data persists
 * });
 *
 * it('should insert and query', async () => {
 *   await db.insert('users', { id: '1', name: 'Alice' });
 *   const user = await db.get('users', { id: '1' });
 *   expect(user?.name).toBe('Alice');
 *   // After this test, cleanup() rolls back - Alice doesn't exist
 * });
 *
 * it('should start with clean state', async () => {
 *   // This test runs with a fresh transaction
 *   const users = await db.list('users', {});
 *   expect(users).toHaveLength(0); // Clean!
 * });
 * ```
 */
export async function createIsolatedTestDb(
  options: IsolatedTestDbOptions = {},
): Promise<IsolatedTestDbResult> {
  const { schema, prefix = 'smrt-isolated' } = options;

  // Dynamically import getDatabase to avoid circular dependencies
  const { getDatabase, syncSchema } = await import('@happyvertical/sql');

  const config = getTestDbConfig(prefix);

  // Create the base database connection
  // Cast to extended interface that includes beginTransaction (from SDK #722)
  const baseDb = (await getDatabase(
    config,
  )) as DatabaseInterfaceWithTransaction;

  // Sync schema if provided (must be done before transaction for DDL)
  if (schema) {
    await syncSchema({ db: baseDb, schema });
  }

  // Begin transaction for isolation
  // Note: beginTransaction requires @happyvertical/sql with SDK PR #722 merged
  if (!baseDb.beginTransaction) {
    throw new Error(
      `Database adapter '${config.type}' does not support beginTransaction(). ` +
        `This requires @happyvertical/sql with SDK PR #722 merged. ` +
        `See: https://github.com/happyvertical/sdk/pull/722`,
    );
  }

  const db = await baseDb.beginTransaction();

  // Cleanup function rolls back transaction
  const cleanup = async (): Promise<void> => {
    try {
      if (db.isActive()) {
        await db.rollback();
      }
    } catch {
      // Ignore rollback errors (connection may be closed)
    }

    // Clean up SQLite temp files
    if (
      config.type === 'sqlite' &&
      config.url !== ':memory:' &&
      existsSync(config.url)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        rmSync(config.url, { force: true });
        rmSync(`${config.url}-wal`, { force: true });
        rmSync(`${config.url}-shm`, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  return { db, baseDb, config, cleanup };
}
