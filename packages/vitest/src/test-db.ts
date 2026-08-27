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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Share the canonical collection-base detector with core instead of keeping a
// local copy. A second copy is exactly how the #1342 junction schema-drop bug
// half-survived: the core fix taught `collection-resolution.ts` to recognize
// `SmrtJunction`, but this manifest-based test-db builder kept an older copy
// that only knew `SmrtCollection`, so junction Collections filtered through
// `createIsolatedTestDbFromManifest({ includeObjects: [...] })` were still
// misclassified as table-bearing and lost their FK/junction columns.
import {
  ensureSystemTables,
  isSmrtCollectionExtendsName,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  foreignKeyConstraintName,
  planForeignKeyCreation,
  renderDeferredForeignKeyAdd,
  schemaForeignKeysForEngine,
} from '@happyvertical/smrt-core/schema';
import {
  type CollectedManifestTable,
  collectManifestTables,
  type ManifestSchemaLike,
  renderCollectedManifestTable,
} from '@happyvertical/smrt-core/schema/utils';
import {
  applySqliteSpeedPragmas,
  getDatabaseFromSqliteSchemaTemplate,
} from './sqlite-schema-template.js';
import type {
  DatabaseInterfaceWithTransaction,
  TransactionHandle,
} from './types.js';

type VitestDatabaseConnectionOptions = Parameters<
  typeof import('@happyvertical/sql')['getDatabase']
>[0] & {
  __smrtSkipVitestSchemaPreparation?: boolean;
};

function removeSqliteFiles(url: string): void {
  rmSync(url, { force: true });
  rmSync(`${url}-wal`, { force: true });
  rmSync(`${url}-shm`, { force: true });
}

// ============================================================================
// Manifest Types (minimal to avoid circular dependency with smrt-core)
// ============================================================================

/**
 * Schema definition from a manifest object.
 *
 * `columns` and `indexes` are the structured, authoritative schema and are
 * rendered through the engine DDL strategy; `ddl` is the engine-neutral
 * CREATE TABLE preview and is only used when an object exposes no columns
 * (hand-authored manifests, #2358).
 */
type ManifestSchema = ManifestSchemaLike;

/**
 * Object definition from a manifest
 */
interface ManifestObjectDef {
  className: string;
  extends?: string;
  extendsTypeArg?: string | null;
  packageName?: string;
  schema?: ManifestSchema;
}

/**
 * Manifest file structure (minimal subset)
 */
interface ManifestFile {
  packageName?: string;
  objects: Record<string, ManifestObjectDef>;
}

/**
 * Options for {@link createIsolatedTestDbFromManifest}.
 */
export interface ManifestTestDbOptions {
  /**
   * Explicit path to a manifest JSON file.
   *
   * When omitted the function searches the following locations in order:
   * 1. `.smrt/manifest.json` — output of `smrtVitestPlugin()` / `smrt generate:test`
   * 2. `dist/manifest.json` — production build manifest
   * 3. `src/manifest/manifest.json` — legacy location
   */
  manifestPath?: string;

  /**
   * Restrict schema creation to a subset of class names.
   *
   * Accepts either simple class names (`'Product'`) or fully-qualified
   * manifest keys (`'@my-org/smrt-models:Product'`).  When omitted, every
   * object that has a schema in the manifest is included.
   *
   * An explicitly named object absent from the local manifest is resolved from
   * dependency manifests already registered by `smrtVitestPlugin()`.
   *
   * @example `['Product', 'Order', 'OrderItem']`
   */
  includeObjects?: string[];

  /**
   * Prefix for the SQLite temp-file name.  Ignored for PostgreSQL.
   * @default 'smrt-manifest'
   */
  prefix?: string;
}

/**
 * Supported test database adapters.
 *
 * - `'sqlite'` — file-based or in-memory SQLite (default for local development)
 * - `'postgres'` — PostgreSQL, used when `DATABASE_URL` is set (CI)
 */
export type TestDbAdapter = 'sqlite' | 'postgres';

/**
 * Database connection configuration for a test run.
 *
 * Returned by {@link getTestDbConfig} and {@link getInMemoryDbConfig}.
 * Pass to `@happyvertical/sql`'s `getDatabase()` to open a connection.
 */
export interface TestDbConfig {
  /** Adapter type — determines the driver used to open the connection. */
  type: 'sqlite' | 'postgres';
  /**
   * Connection URL.
   *
   * - SQLite: absolute path to a `.db` file, or `':memory:'`
   * - PostgreSQL: `postgresql://user:pass@host:port/dbname`
   */
  url: string;
}

/**
 * Detect the database adapter to use based on the current environment.
 *
 * Resolution order:
 * 1. `TEST_DB_ADAPTER` env var — explicit override (`'sqlite'` or `'postgres'`)
 * 2. `DATABASE_URL` env var set → `'postgres'`
 * 3. Default → `'sqlite'`
 *
 * @returns The adapter identifier for the current environment.
 * @see {@link getTestDbConfig} to obtain a full {@link TestDbConfig}.
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
 * Check whether PostgreSQL is available for the current test run.
 *
 * Returns `true` when the `DATABASE_URL` environment variable is set,
 * which is the signal used by CI environments to opt into PostgreSQL.
 *
 * @returns `true` if `DATABASE_URL` is set, `false` otherwise.
 * @see {@link getTestAdapter} for full adapter resolution logic.
 */
export function isPostgresAvailable(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Get a {@link TestDbConfig} appropriate for the current environment.
 *
 * Uses PostgreSQL when `DATABASE_URL` is set (CI), otherwise generates
 * a unique SQLite temp-file path to prevent concurrency conflicts between
 * parallel test workers.
 *
 * @param prefix - Optional prefix used in the SQLite temp-file name.
 *   Ignored when using PostgreSQL. Defaults to `'smrt-test'`.
 * @returns A {@link TestDbConfig} ready to pass to `getDatabase()`.
 * @see {@link getInMemoryDbConfig} for a non-persistent SQLite alternative.
 * @see {@link createTestDb} to obtain the config alongside a cleanup function.
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
 * Get a {@link TestDbConfig} backed by an in-memory SQLite database.
 *
 * In-memory databases are isolated per connection — safe for concurrent
 * tests within the same process, but the database cannot be shared across
 * connections or workers.  No temp files are created or cleaned up.
 *
 * Prefer {@link getTestDbConfig} (file-based SQLite or PostgreSQL) when
 * tests need to be shared or inspected after the run.
 *
 * @returns A `TestDbConfig` with `url: ':memory:'`.
 */
export function getInMemoryDbConfig(): TestDbConfig {
  return {
    type: 'sqlite',
    url: ':memory:',
  };
}

/**
 * Create a test database and return a cleanup function.
 *
 * Determines the adapter automatically via {@link getTestDbConfig}.  For
 * SQLite, a unique temp file is created; `cleanup()` removes it along with
 * any WAL/SHM sidecar files.  For PostgreSQL, `cleanup()` is a no-op
 * (table isolation must be handled by the test itself).
 *
 * Unlike {@link createIsolatedTestDb}, this function does **not** wrap
 * operations in a transaction — mutations made during the test persist until
 * the temp file is deleted.  Prefer {@link createIsolatedTestDb} for
 * isolated, parallel-safe tests.
 *
 * @param prefix - Prefix for the SQLite temp-file name.  Ignored for
 *   PostgreSQL.  Defaults to `'smrt-test'`.
 * @returns An object containing the resolved {@link TestDbConfig} and an
 *   async `cleanup()` function that removes the temp file on SQLite.
 *
 * @example
 * ```typescript
 * import { createTestDb } from '@happyvertical/smrt-vitest';
 *
 * const { config, cleanup } = await createTestDb();
 * const db = await getDatabase(config);
 * // ... run tests ...
 * await cleanup();
 * ```
 *
 * @see {@link createIsolatedTestDb} for transaction-isolated test databases.
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
        removeSqliteFiles(config.url);
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
 * Get a human-readable display name for the current test database adapter.
 *
 * Useful for labelling `describe` blocks or test output so logs make clear
 * which backend is under test.
 *
 * @returns `'PostgreSQL'` when the adapter is `'postgres'`, otherwise `'SQLite'`.
 *
 * @example
 * ```typescript
 * import { getAdapterDisplayName } from '@happyvertical/smrt-vitest';
 *
 * describe(`Product (${getAdapterDisplayName()})`, () => {
 *   // ...
 * });
 * ```
 *
 * @see {@link getTestAdapter} to obtain the raw adapter identifier.
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
 * Options for {@link createIsolatedTestDb}.
 */
export interface IsolatedTestDbOptions {
  /**
   * Raw SQL DDL to execute against the database before the transaction begins.
   *
   * The DDL is applied outside the transaction (required for DDL on SQLite and
   * some PostgreSQL configurations), so it persists for the lifetime of the
   * temp database.  The transaction wraps only the DML that follows.
   *
   * @example
   * ```typescript
   * schema: `
   *   CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
   *   CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id));
   * `
   * ```
   */
  schema?: string;

  /**
   * Prefix for the SQLite temp-file name.  Ignored for PostgreSQL.
   * @default 'smrt-isolated'
   */
  prefix?: string;
}

/**
 * Result returned by {@link createIsolatedTestDb} and
 * {@link createIsolatedTestDbFromManifest}.
 */
export interface IsolatedTestDbResult {
  /**
   * Transaction-scoped database handle.
   *
   * Use this for all DML inside your test.  All operations run within the
   * open transaction and are rolled back when `cleanup()` is called.
   */
  db: TransactionHandle;

  /**
   * The underlying database connection, opened before the transaction began.
   *
   * Use only for operations that must run outside the transaction (e.g.,
   * reading sequences or checking schema state).  Most tests should use
   * `db` instead.
   */
  baseDb: DatabaseInterfaceWithTransaction;

  /**
   * The resolved {@link TestDbConfig} used to open the connection.
   *
   * Useful for introspection (e.g., logging which adapter is under test).
   */
  config: TestDbConfig;

  /**
   * Roll back the transaction, close the connection, and delete any SQLite
   * temp files.
   *
   * **Always** call this in `afterEach()` or a `finally` block to prevent
   * connection leaks and temp-file accumulation.
   */
  cleanup: () => Promise<void>;
}

/**
 * Create a test database with transaction isolation.
 *
 * Each test runs in a transaction that gets rolled back on `cleanup()`,
 * ensuring complete isolation between tests without the overhead of
 * creating or dropping tables between runs.  Parallel test workers each
 * receive their own temp database file (SQLite) or an independent
 * transaction (PostgreSQL).
 *
 * File-backed SQLite schemas are prepared once per process, snapshotted, and
 * copied into each later database. The template contains schema only; test
 * data remains isolated in the per-test transaction and database file.
 *
 * Requires `@happyvertical/sql` with `beginTransaction()` support
 * (SDK PR #722).  Throws if the adapter does not implement it.
 *
 * @param options - Optional schema DDL and SQLite prefix.
 *   Pass `schema` to have the DDL applied before the transaction begins.
 * @returns An {@link IsolatedTestDbResult} containing the transaction handle,
 *   base connection, resolved config, and a `cleanup()` function.
 *
 * @see {@link createIsolatedTestDbFromManifest} to derive the schema
 *   automatically from the generated manifest file.
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
  return createIsolatedTestDbWithPostSchemaStatements(options, []);
}

async function createIsolatedTestDbWithPostSchemaStatements(
  options: IsolatedTestDbOptions,
  postSchemaStatements: readonly PostSchemaStatement[],
): Promise<IsolatedTestDbResult> {
  const { schema, prefix = 'smrt-isolated' } = options;

  // Dynamically import getDatabase to avoid circular dependencies
  const { getDatabase, syncSchema } = await import('@happyvertical/sql');

  const config = getTestDbConfig(prefix);

  // Create the base database connection
  // Cast to extended interface that includes beginTransaction (from SDK #722)
  const baseDb =
    schema && config.type === 'sqlite' && config.url !== ':memory:'
      ? await getDatabaseFromSqliteSchemaTemplate({
          cacheKey: `isolated-test-db\0${schema}`,
          databaseOptions: {
            ...config,
            __smrtSkipVitestSchemaPreparation: true,
          },
          getDatabase: async (databaseOptions) =>
            (await getDatabase(
              databaseOptions as VitestDatabaseConnectionOptions,
            )) as DatabaseInterfaceWithTransaction,
          prepare: (database) => syncSchema({ db: database, schema }),
        })
      : ((await getDatabase({
          ...config,
          __smrtSkipVitestSchemaPreparation: true,
        } as VitestDatabaseConnectionOptions)) as DatabaseInterfaceWithTransaction);

  // Isolated test databases are throwaway, so strip fsync durability from
  // local file-backed SQLite (#2221). The schema-preparation skip above also
  // bypasses the setup file's pragma application, so it happens here.
  await applySqliteSpeedPragmas(baseDb, config);

  const applyPostSchemaStatements = async (
    schemaDb: DatabaseInterfaceWithTransaction,
  ): Promise<void> => {
    for (const deferred of postSchemaStatements) {
      if (
        await postgresConstraintExists(
          schemaDb,
          deferred.tableName,
          deferred.constraintName,
        )
      ) {
        continue;
      }
      await schemaDb.query(deferred.statement);
    }
  };

  let systemTablesPrepared = false;

  // Sync schema if provided (must be done before the isolated test
  // transaction). PostgreSQL schema preparation is serialized across workers
  // in a transaction-scoped advisory lock. The lock covers reconciliation,
  // FK installation, and framework system tables without leaking a session
  // lock through a pooled connection.
  if (schema && config.type !== 'sqlite') {
    if (!baseDb.beginTransaction) {
      throw new Error(
        `Database adapter '${config.type}' does not support beginTransaction(). ` +
          'This requires @happyvertical/sql with SDK PR #722 merged.',
      );
    }
    const schemaTransaction = await baseDb.beginTransaction();
    try {
      await schemaTransaction.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['smrt-vitest-manifest-schema'],
      );
      await syncSchema({ db: schemaTransaction, schema });
      await applyPostSchemaStatements(schemaTransaction);
      await ensureSystemTables(schemaTransaction, config.type);
      await schemaTransaction.commit();
      systemTablesPrepared = true;
    } catch (error) {
      if (schemaTransaction.isActive()) {
        await schemaTransaction.rollback();
      }
      throw error;
    }
  }

  // Transaction handles are passed to SMRT objects as already-initialized
  // databases, so they intentionally skip the normal SmrtClass bootstrap.
  // A missing-table probe aborts a PostgreSQL transaction even when the caller
  // catches the error. Provision every framework-owned system table on the base
  // connection before opening the isolated transaction.
  if (config.type === 'postgres' && !systemTablesPrepared) {
    await ensureSystemTables(baseDb, config.type);
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

  // Cleanup function rolls back transaction and closes connection
  const cleanup = async (): Promise<void> => {
    try {
      if (db.isActive()) {
        await db.rollback();
      }
    } catch {
      // Ignore rollback errors (connection may be closed)
    }

    // Close base database connection to prevent connection leaks (Issue #858)
    try {
      if (
        baseDb &&
        typeof (baseDb as unknown as Record<string, unknown>).close ===
          'function'
      ) {
        await (
          (baseDb as unknown as Record<string, unknown>)
            .close as () => Promise<void>
        )();
      }
    } catch {
      // Ignore close errors
    }

    // Clean up SQLite temp files
    if (
      config.type === 'sqlite' &&
      config.url !== ':memory:' &&
      existsSync(config.url)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      try {
        removeSqliteFiles(config.url);
      } catch {
        // Ignore cleanup errors
      }
    }
  };

  return { db, baseDb, config, cleanup };
}

interface PostSchemaStatement {
  statement: string;
  tableName: string;
  constraintName: string;
}

async function postgresConstraintExists(
  db: DatabaseInterfaceWithTransaction,
  tableName: string,
  constraintName: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM pg_constraint AS constraint_row
     JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
     JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
     WHERE table_row.relname = $1
       AND namespace_row.nspname = current_schema()
       AND constraint_row.conname = $2
       AND constraint_row.contype = 'f'
     LIMIT 1`,
    [tableName, constraintName],
  );
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

// ============================================================================
// Manifest-based Test Database Helpers
// ============================================================================

/**
 * Load a manifest file from common locations
 *
 * @param manifestPath - Optional explicit path to manifest
 * @returns Parsed manifest or null if not found
 */
function loadManifest(manifestPath?: string): ManifestFile | null {
  const searchPaths = manifestPath
    ? [manifestPath]
    : [
        join(process.cwd(), '.smrt', 'manifest.json'),
        join(process.cwd(), 'dist', 'manifest.json'),
        join(process.cwd(), 'src', 'manifest', 'manifest.json'),
      ];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content) as ManifestFile;
      } catch (error) {
        // Log parse error but continue to next path
        console.warn(
          `[smrt-vitest] Failed to parse manifest at "${path}":`,
          error,
        );
      }
    }
  }

  return null;
}

/**
 * Table info extracted from manifest for dependency sorting
 */
interface TableInfo {
  tableName: string;
  /** Structured STI union of every contributing manifest object */
  table: CollectedManifestTable;
  dependencies: string[];
}

/**
 * Extract foreign key dependencies from DDL
 *
 * Parses REFERENCES tableName( patterns from CREATE TABLE statements
 */
function extractForeignKeyDependencies(ddl: string): string[] {
  const dependencies: string[] = [];
  const identifier = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
  const regex = new RegExp(
    `\\bREFERENCES\\s+((?:${identifier}\\s*\\.\\s*)*${identifier})(?![A-Za-z0-9_$"]|\\s*\\.)`,
    'gi',
  );

  for (const match of ddl.matchAll(regex)) {
    const qualifiedTarget = match[1] ?? '';
    const parts = Array.from(
      qualifiedTarget.matchAll(/"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)/g),
    );
    const finalIdentifier = parts.at(-1);
    const tableName = finalIdentifier?.[1]
      ? finalIdentifier[1].replaceAll('""', '"')
      : finalIdentifier?.[2];
    if (!tableName) continue;
    if (!dependencies.includes(tableName)) {
      dependencies.push(tableName);
    }
  }

  return dependencies;
}

/**
 * Collect the tables a collected manifest table depends on: structured
 * `foreignKey.table` references first, then any `REFERENCES` clauses in the
 * contributors' cached DDL strings (hand-authored manifests).
 */
function collectTableDependencies(table: CollectedManifestTable): string[] {
  const dependencies: string[] = [];
  for (const column of Object.values(table.definition.columns)) {
    const target = column.foreignKey?.table;
    if (target && !dependencies.includes(target)) {
      dependencies.push(target);
    }
  }
  for (const dep of extractForeignKeyDependencies(table.legacyDdl)) {
    if (!dependencies.includes(dep)) {
      dependencies.push(dep);
    }
  }
  return dependencies;
}

function getPackageNameFromKey(key: string): string | undefined {
  const separatorIndex = key.lastIndexOf(':');
  if (separatorIndex <= 0) {
    return undefined;
  }

  return key.slice(0, separatorIndex);
}

function getObjectPackageName(
  manifest: ManifestFile,
  key: string,
  objectDef: ManifestObjectDef,
): string | undefined {
  return (
    objectDef.packageName || getPackageNameFromKey(key) || manifest.packageName
  );
}

function addManifestObjectIdentifiers(
  target: Set<string>,
  manifest: ManifestFile,
  key: string,
  objectDef: ManifestObjectDef,
  options: { includeSimpleName: boolean },
): void {
  target.add(key);
  if (options.includeSimpleName && objectDef.className) {
    target.add(objectDef.className);
  }

  const packageName = getObjectPackageName(manifest, key, objectDef);
  if (packageName && objectDef.className) {
    target.add(`${packageName}:${objectDef.className}`);
  }
}

function findManifestObject(
  manifest: ManifestFile,
  lookupName: string,
  packageName?: string,
): { key: string; objectDef: ManifestObjectDef } | undefined {
  const direct = manifest.objects[lookupName];
  if (direct) {
    return { key: lookupName, objectDef: direct };
  }

  const separatorIndex = lookupName.lastIndexOf(':');
  const lookupPackage =
    separatorIndex > 0 ? lookupName.slice(0, separatorIndex) : packageName;
  const simpleName =
    separatorIndex > 0 ? lookupName.slice(separatorIndex + 1) : lookupName;
  const lowerSimpleName = simpleName.toLowerCase();

  for (const [key, objectDef] of Object.entries(manifest.objects)) {
    const objectPackageName = getObjectPackageName(manifest, key, objectDef);
    if (
      lookupPackage &&
      objectPackageName &&
      objectPackageName !== lookupPackage
    ) {
      continue;
    }

    if (
      key === lookupName ||
      objectDef.className === simpleName ||
      objectDef.className?.toLowerCase() === lowerSimpleName
    ) {
      return { key, objectDef };
    }
  }

  return undefined;
}

function getManifestCollectionAncestors(
  manifest: ManifestFile,
  key: string,
  objectDef: ManifestObjectDef,
): Array<{ key: string; objectDef: ManifestObjectDef }> {
  const ancestors: Array<{ key: string; objectDef: ManifestObjectDef }> = [];
  const visited = new Set<string>();
  let currentKey = key;
  let currentDef: ManifestObjectDef | undefined = objectDef;

  while (currentDef?.extends) {
    if (isSmrtCollectionExtendsName(currentDef.extends)) {
      break;
    }

    const currentPackage = getObjectPackageName(
      manifest,
      currentKey,
      currentDef,
    );
    const parent = findManifestObject(
      manifest,
      currentDef.extends,
      currentPackage,
    );
    if (!parent || visited.has(parent.key)) {
      break;
    }

    visited.add(parent.key);
    ancestors.push(parent);
    currentKey = parent.key;
    currentDef = parent.objectDef;
  }

  return ancestors;
}

function isManifestCollectionObject(
  manifest: ManifestFile,
  key: string,
  objectDef: ManifestObjectDef,
): boolean {
  if (isSmrtCollectionExtendsName(objectDef.extends)) {
    return true;
  }

  return getManifestCollectionAncestors(manifest, key, objectDef).some(
    (ancestor) => isSmrtCollectionExtendsName(ancestor.objectDef.extends),
  );
}

function resolveManifestCollectionItemClassName(
  manifest: ManifestFile,
  key: string,
  objectDef: ManifestObjectDef,
): string | undefined {
  if (objectDef.extendsTypeArg) {
    return objectDef.extendsTypeArg;
  }

  const inferredItemClassName = inferManifestCollectionItemClassName(
    manifest,
    key,
    objectDef,
  );
  if (inferredItemClassName) {
    return inferredItemClassName;
  }

  for (const ancestor of getManifestCollectionAncestors(
    manifest,
    key,
    objectDef,
  )) {
    if (ancestor.objectDef.extendsTypeArg) {
      return ancestor.objectDef.extendsTypeArg;
    }
  }

  return undefined;
}

function getCollectionItemNameCandidates(className: string): string[] {
  const candidates: string[] = [];

  const addCandidate = (candidate: string): void => {
    if (
      candidate &&
      candidate !== className &&
      !candidates.includes(candidate)
    ) {
      candidates.push(candidate);
    }
  };

  if (className.endsWith('Collection')) {
    addCandidate(className.slice(0, -'Collection'.length));
  }

  if (className.endsWith('ies')) {
    addCandidate(`${className.slice(0, -3)}y`);
  } else if (className.endsWith('s')) {
    addCandidate(className.slice(0, -1));
  }

  return candidates;
}

function inferManifestCollectionItemClassName(
  manifest: ManifestFile,
  key: string,
  objectDef: ManifestObjectDef,
): string | undefined {
  const objectPackageName = getObjectPackageName(manifest, key, objectDef);

  for (const candidate of getCollectionItemNameCandidates(
    objectDef.className,
  )) {
    const candidateEntry = findManifestObject(
      manifest,
      candidate,
      objectPackageName,
    );
    if (candidateEntry) {
      return candidate;
    }
  }

  return undefined;
}

function buildEffectiveIncludeObjects(
  manifest: ManifestFile,
  includeObjects?: string[],
): Set<string> | undefined {
  if (!includeObjects) {
    return undefined;
  }

  const effectiveIncludes = new Set<string>();

  for (const includeObject of includeObjects) {
    const includeSimpleName = !includeObject.includes(':');
    const entry = findManifestObject(manifest, includeObject);
    if (!entry) {
      effectiveIncludes.add(includeObject);
      continue;
    }

    const objectPackageName = getObjectPackageName(
      manifest,
      entry.key,
      entry.objectDef,
    );
    const itemClassName = isManifestCollectionObject(
      manifest,
      entry.key,
      entry.objectDef,
    )
      ? resolveManifestCollectionItemClassName(
          manifest,
          entry.key,
          entry.objectDef,
        )
      : undefined;
    const itemEntry = itemClassName
      ? findManifestObject(manifest, itemClassName, objectPackageName)
      : undefined;

    addManifestObjectIdentifiers(
      effectiveIncludes,
      manifest,
      itemEntry?.key || entry.key,
      itemEntry?.objectDef || entry.objectDef,
      { includeSimpleName },
    );
  }

  return effectiveIncludes;
}

/**
 * Extract tables from manifest objects with STI deduplication
 *
 * Multiple classes may share the same table (STI), so we deduplicate by
 * tableName and merge their structured columns and indexes (first contributor
 * wins per column name; indexes deduplicated by name). The merged definition
 * is rendered through the engine DDL strategy — the same renderer
 * `db:migrate` uses — so the isolated test database has the same tables and
 * indexes as a migrated one (#2358). Objects that expose no structured
 * columns fall back to their cached `ddl` string for the CREATE TABLE.
 */
function extractTablesFromManifest(
  manifest: ManifestFile,
  includeObjects?: string[],
): TableInfo[] {
  const effectiveIncludes = buildEffectiveIncludeObjects(
    manifest,
    includeObjects,
  );

  const entries: Array<{ schema: ManifestSchema; source: string }> = [];
  for (const [key, objectDef] of Object.entries(manifest.objects)) {
    // Skip if filter is specified and class not included
    // Compare against both the key (e.g., '@dumm/models:Product') and className (e.g., 'Product')
    // to support both namespaced and simple class names (Issue #860)
    if (effectiveIncludes) {
      const className = objectDef.className || key;
      const matchesKey = effectiveIncludes.has(key);
      const matchesClassName = effectiveIncludes.has(className);
      if (!matchesKey && !matchesClassName) {
        continue;
      }
    }

    // Skip objects without schema (abstract classes, etc.)
    if (!objectDef.schema?.tableName) {
      continue;
    }

    entries.push({ schema: objectDef.schema, source: key });
  }

  // The Vitest plugin registers dependency manifests in ObjectRegistry but
  // deliberately leaves the generated local manifest package-local. Resolve
  // only explicitly requested objects that are absent from that local file;
  // pulling every registered dependency table would unexpectedly expand
  // otherwise focused test schemas.
  if (includeObjects) {
    const missingIncludes = includeObjects.filter(
      (includeObject) => !findManifestObject(manifest, includeObject),
    );
    const registeredSchemas =
      missingIncludes.length > 0
        ? ObjectRegistry.getAllSchemasAsDefinitions()
        : undefined;
    const addedRegisteredTables = new Set<string>();
    for (const includeObject of missingIncludes) {
      const tableName = ObjectRegistry.getTableName(includeObject);
      const schema =
        tableName && registeredSchemas
          ? registeredSchemas[tableName]
          : undefined;
      if (!schema || addedRegisteredTables.has(schema.tableName)) {
        continue;
      }

      addedRegisteredTables.add(schema.tableName);
      entries.push({
        schema,
        source: `registered manifest object ${includeObject}`,
      });
    }
  }

  const collected = Array.from(collectManifestTables(entries).values());
  const includedTables = new Set(collected.map((table) => table.tableName));

  return collected.map((table) => {
    const missingDependencies = collectTableDependencies(table).filter(
      (dependency) => !includedTables.has(dependency),
    );
    if (missingDependencies.length > 0 && !table.structured) {
      throw new Error(
        `Cannot safely create filtered manifest schema: legacy DDL for "${table.tableName}" references omitted table "${missingDependencies[0]}". Include the referenced object or regenerate a structured manifest.`,
      );
    }

    const definition = {
      ...table.definition,
      columns: Object.fromEntries(
        Object.entries(table.definition.columns).map(([name, column]) => [
          name,
          column.foreignKey && !includedTables.has(column.foreignKey.table)
            ? { ...column, foreignKey: undefined }
            : column,
        ]),
      ),
      foreignKeys: table.definition.foreignKeys.filter((foreignKey) =>
        includedTables.has(foreignKey.referencesTable),
      ),
      dependencies: table.definition.dependencies.filter((dependency) =>
        includedTables.has(dependency),
      ),
    };
    const filteredTable = { ...table, definition };
    return {
      tableName: filteredTable.tableName,
      table: filteredTable,
      dependencies: collectTableDependencies(filteredTable),
    };
  });
}

/**
 * Create an isolated test database with schema derived from a manifest file.
 *
 * Eliminates the need to manually write or maintain DDL in test files by
 * reading table definitions directly from the generated manifest.  Handles:
 *
 * - **STI deduplication** — multiple classes that share the same table are
 *   merged into a single `CREATE TABLE` statement that includes all columns.
 * - **FK dependency ordering** — tables are created in topological order so
 *   `REFERENCES` constraints are always satisfied.
 * - **Auto-detection** — searches `.smrt/manifest.json`, `dist/manifest.json`,
 *   and `src/manifest/manifest.json` when no `manifestPath` is given.
 *
 * @param options - Optional manifest path, class filter, and SQLite prefix.
 * @returns An {@link IsolatedTestDbResult} — same shape as
 *   {@link createIsolatedTestDb}, with a transaction-scoped `db` handle and
 *   a `cleanup()` that rolls back and removes temp files.
 *
 * @throws When no manifest is found at any of the checked locations.
 * @throws When the manifest contains no objects with a database schema (or
 *   none of the filtered `includeObjects` have a schema).
 *
 * @see {@link createIsolatedTestDb} if you prefer to supply raw DDL directly.
 * @see {@link ManifestTestDbOptions} for all available options.
 *
 * @example Basic usage
 * ```typescript
 * import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
 *
 * let db, cleanup;
 *
 * beforeEach(async () => {
 *   ({ db, cleanup } = await createIsolatedTestDbFromManifest());
 * });
 *
 * afterEach(async () => {
 *   await cleanup();
 * });
 * ```
 *
 * @example With tenant scoping
 * ```typescript
 * import { createIsolatedTestDbFromManifest } from '@happyvertical/smrt-vitest';
 * import { withTenant, resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
 *
 * // In setup file
 * setupTestTenancy({ enableInterceptors: true, rawQueryPolicy: 'allow' });
 *
 * // In test file
 * let db, cleanup;
 *
 * beforeEach(async () => {
 *   ({ db, cleanup } = await createIsolatedTestDbFromManifest());
 * });
 *
 * afterEach(async () => {
 *   resetTenancy();
 *   await cleanup();
 * });
 *
 * it('should auto-populate tenantId', async () => {
 *   await withTenant({ tenantId: 'test-tenant' }, async () => {
 *     const product = await collection.create({ name: 'Widget' });
 *     expect(product.tenantId).toBe('test-tenant');
 *   });
 * });
 * ```
 *
 * @example Filter to specific objects
 * ```typescript
 * const { db, cleanup } = await createIsolatedTestDbFromManifest({
 *   includeObjects: ['Product', 'Order', 'OrderItem'],
 * });
 * ```
 */
export async function createIsolatedTestDbFromManifest(
  options: ManifestTestDbOptions = {},
): Promise<IsolatedTestDbResult> {
  const { manifestPath, includeObjects, prefix = 'smrt-manifest' } = options;
  const adapter = getTestAdapter();

  // 1. Load manifest
  const manifest = loadManifest(manifestPath);
  if (!manifest) {
    const checkedPaths = manifestPath
      ? [manifestPath]
      : [
          '.smrt/manifest.json',
          'dist/manifest.json',
          'src/manifest/manifest.json',
        ];

    throw new Error(
      'No manifest found. Ensure smrtVitestPlugin() is configured in vitest.config.ts ' +
        'or specify manifestPath. Checked: ' +
        checkedPaths.join(', '),
    );
  }

  // 2. Extract tables with STI deduplication
  const tables = extractTablesFromManifest(manifest, includeObjects);
  if (tables.length === 0) {
    throw new Error(
      includeObjects
        ? `No objects with schema found matching: ${includeObjects.join(', ')}`
        : 'No objects with schema found in manifest.',
    );
  }

  // 3. Use the same dependency/cycle planner as every other schema path.
  // Legacy contributors expose dependencies only through cached DDL, so carry
  // the already-parsed TableInfo dependencies into the structured plan input.
  const tableMap = new Map(tables.map((t) => [t.tableName, t] as const));
  const plan = planForeignKeyCreation(
    tables.map((table) => ({
      ...table.table.definition,
      dependencies: table.dependencies,
    })),
    adapter,
  );
  if (adapter === 'postgres') {
    const unstructuredCyclicTables = plan.cyclicTables.filter(
      (tableName) => !tableMap.get(tableName)?.table.structured,
    );
    if (unstructuredCyclicTables.length > 0) {
      throw new Error(
        `Cannot safely create PostgreSQL manifest schema: legacy DDL foreign-key cycle includes ${unstructuredCyclicTables.map((tableName) => `"${tableName}"`).join(', ')}. Regenerate a structured manifest so cyclic constraints can be deferred. No schema changes were applied.`,
      );
    }
  }
  // PostgreSQL's generic synchronizer remains responsible for reconciling
  // existing test tables, indexes, defaults, and newly added columns. Keep
  // named constraints out of that parser and apply every physical FK through
  // the core renderer only after all tables exist. SQLite retains its existing
  // inline-constraint rendering path.
  const renderedDefinitions =
    adapter === 'postgres'
      ? plan.schemas.map((definition) => ({
          ...definition,
          columns: Object.fromEntries(
            Object.entries(definition.columns).map(([name, column]) => [
              name,
              { ...column, foreignKey: undefined },
            ]),
          ),
          foreignKeys: [],
        }))
      : plan.schemas;
  const rendered = renderedDefinitions.flatMap((definition) => {
    const table = tableMap.get(definition.tableName);
    return table
      ? [renderCollectedManifestTable({ ...table.table, definition }, adapter)]
      : [];
  });

  // CREATE TABLE statements first
  const createTableDDL = rendered
    .map((ddl) => ddl.createTable)
    .filter(Boolean)
    .join('\n\n');

  // CREATE INDEX statements after tables exist. This includes the UNIQUE
  // indexes required for UPSERT/ON CONFLICT to work and, unlike the retired
  // string renderer, keeps partial `WHERE` predicates and JSON-path targets.
  // Triggers are not applied: manifests carry no trigger definitions
  // (`ManifestSchema` has no `triggers`), and multi-statement trigger bodies
  // would not survive the schema splitter below.
  const createIndexDDL = rendered
    .flatMap((ddl) => ddl.indexes)
    .filter(Boolean)
    .join('\n');

  // Combine table DDL and index DDL
  const sortedDDL = [createTableDDL, createIndexDDL]
    .filter(Boolean)
    .join('\n\n');

  // 4. Delegate to existing function
  return createIsolatedTestDbWithPostSchemaStatements(
    { schema: sortedDDL, prefix },
    adapter === 'postgres'
      ? tables
          .flatMap(({ tableName, table }) =>
            schemaForeignKeysForEngine(table.definition, 'postgres').map(
              (foreignKey) => ({ tableName, foreignKey }),
            ),
          )
          .sort((a, b) =>
            `${a.tableName}.${a.foreignKey.column}`.localeCompare(
              `${b.tableName}.${b.foreignKey.column}`,
            ),
          )
          .map(({ tableName, foreignKey }) => ({
            statement: renderDeferredForeignKeyAdd(tableName, foreignKey),
            tableName,
            constraintName: foreignKeyConstraintName(tableName, foreignKey),
          }))
      : [],
  );
}
