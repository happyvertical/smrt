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
import type {
  DatabaseInterfaceWithTransaction,
  TransactionHandle,
} from './types.js';

// ============================================================================
// Manifest Types (minimal to avoid circular dependency with smrt-core)
// ============================================================================

/**
 * Schema definition from a manifest object
 */
interface ManifestSchema {
  tableName: string;
  ddl: string;
  indexes?: Array<{ name: string; columns: string[]; unique?: boolean }>;
}

/**
 * Object definition from a manifest
 */
interface ManifestObjectDef {
  className: string;
  schema?: ManifestSchema;
}

/**
 * Manifest file structure (minimal subset)
 */
interface ManifestFile {
  objects: Record<string, ManifestObjectDef>;
}

/**
 * Options for creating an isolated test database from a manifest
 */
export interface ManifestTestDbOptions {
  /**
   * Path to manifest file. If not provided, auto-detects from common locations:
   * - .smrt/manifest.json (vitest plugin output)
   * - dist/manifest.json (production build)
   * - src/manifest/manifest.json (legacy)
   */
  manifestPath?: string;

  /**
   * Filter to specific object class names (e.g., ['Product', 'Order']).
   * If not provided, all objects with schemas are included.
   */
  includeObjects?: string[];

  /**
   * Optional prefix for SQLite temp file name
   * @default 'smrt-manifest'
   */
  prefix?: string;
}

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
 * Index definition from manifest
 */
interface ManifestIndex {
  name: string;
  columns: string[];
  unique?: boolean;
}

/**
 * Table info extracted from manifest for dependency sorting
 */
interface TableInfo {
  tableName: string;
  ddl: string;
  indexes: ManifestIndex[];
  dependencies: string[];
}

/**
 * Generate CREATE INDEX statements from manifest indexes
 *
 * Generates both regular and UNIQUE indexes.
 * UNIQUE indexes on conflict columns (like slug, context) are required
 * for UPSERT/ON CONFLICT to work in SQLite.
 */
function generateIndexDDL(tableName: string, indexes: ManifestIndex[]): string {
  if (!indexes || indexes.length === 0) return '';

  const statements: string[] = [];
  for (const index of indexes) {
    if (!index.columns || index.columns.length === 0) continue;

    const indexType = index.unique ? 'UNIQUE INDEX' : 'INDEX';
    const columns = index.columns.map((c) => `"${c}"`).join(', ');
    statements.push(
      `CREATE ${indexType} IF NOT EXISTS "${index.name}" ON "${tableName}" (${columns});`,
    );
  }
  return statements.join('\n');
}

/**
 * Extract foreign key dependencies from DDL
 *
 * Parses REFERENCES tableName( patterns from CREATE TABLE statements
 */
function extractForeignKeyDependencies(ddl: string): string[] {
  const dependencies: string[] = [];
  // Match REFERENCES "tablename"( or REFERENCES tablename(
  const regex = /REFERENCES\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi;

  for (const match of ddl.matchAll(regex)) {
    const tableName = match[1];
    if (!dependencies.includes(tableName)) {
      dependencies.push(tableName);
    }
  }

  return dependencies;
}

/**
 * Extract DDL from manifest objects with STI deduplication
 *
 * Multiple classes may share the same table (STI), so we deduplicate by tableName.
 * Also extracts indexes for generating CREATE INDEX statements.
 */
function extractDDLFromManifest(
  manifest: ManifestFile,
  includeObjects?: string[],
): TableInfo[] {
  const tableMap = new Map<string, TableInfo>();

  for (const [key, objectDef] of Object.entries(manifest.objects)) {
    // Skip if filter is specified and class not included
    // Compare against both the key (e.g., '@dumm/models:Product') and className (e.g., 'Product')
    // to support both namespaced and simple class names (Issue #860)
    if (includeObjects) {
      const className = objectDef.className || key;
      const matchesKey = includeObjects.includes(key);
      const matchesClassName = includeObjects.includes(className);
      if (!matchesKey && !matchesClassName) {
        continue;
      }
    }

    // Skip objects without schema (abstract classes, etc.)
    if (!objectDef.schema?.ddl || !objectDef.schema?.tableName) {
      continue;
    }

    const { tableName, ddl, indexes = [] } = objectDef.schema;

    // Deduplicate by tableName (STI classes share tables)
    if (!tableMap.has(tableName)) {
      tableMap.set(tableName, {
        tableName,
        ddl,
        indexes,
        dependencies: extractForeignKeyDependencies(ddl),
      });
    }
  }

  return Array.from(tableMap.values());
}

/**
 * Sort tables by foreign key dependencies using topological sort (Kahn's algorithm)
 *
 * Ensures referenced tables are created before tables that reference them
 */
function sortByDependencies(tables: TableInfo[]): string[] {
  const tableNames = new Set(tables.map((t) => t.tableName));
  const inDegree = new Map<string, number>();
  const graph = new Map<string, string[]>();

  // Initialize
  for (const table of tables) {
    inDegree.set(table.tableName, 0);
    graph.set(table.tableName, []);
  }

  // Build graph - only count dependencies that are in our table set
  for (const table of tables) {
    for (const dep of table.dependencies) {
      if (tableNames.has(dep) && dep !== table.tableName) {
        inDegree.set(table.tableName, (inDegree.get(table.tableName) || 0) + 1);
        const edges = graph.get(dep) || [];
        edges.push(table.tableName);
        graph.set(dep, edges);
      }
    }
  }

  // Find all nodes with no incoming edges
  const queue: string[] = [];
  for (const [table, degree] of inDegree) {
    if (degree === 0) {
      queue.push(table);
    }
  }

  // Process queue
  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    sorted.push(current);

    const neighbors = graph.get(current) || [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle any remaining tables (circular dependencies)
  // Use Set for O(1) lookups instead of O(n) Array.includes()
  const sortedSet = new Set(sorted);
  for (const table of tables) {
    if (!sortedSet.has(table.tableName)) {
      sorted.push(table.tableName);
      sortedSet.add(table.tableName);
    }
  }

  return sorted;
}

/**
 * Create an isolated test database with schema from a manifest file.
 *
 * This eliminates manual DDL extraction boilerplate by reading the DDL
 * directly from the generated manifest. It handles:
 * - STI deduplication (multiple classes sharing one table)
 * - Foreign key dependency ordering
 * - Auto-detection of manifest location
 *
 * @param options - Configuration options
 * @returns Transaction handle and cleanup function
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

  // 2. Extract DDL with STI deduplication
  const tables = extractDDLFromManifest(manifest, includeObjects);
  if (tables.length === 0) {
    throw new Error(
      includeObjects
        ? `No objects with schema found matching: ${includeObjects.join(', ')}`
        : 'No objects with schema found in manifest.',
    );
  }

  // 3. Sort by FK dependencies and join DDL
  // Use Map for O(1) lookups instead of O(n) Array.find()
  const tableMap = new Map(tables.map((t) => [t.tableName, t] as const));
  const sortedTableNames = sortByDependencies(tables);

  // Generate CREATE TABLE statements first
  const createTableDDL = sortedTableNames
    .map((name) => tableMap.get(name)?.ddl)
    .filter(Boolean)
    .join('\n\n');

  // Generate CREATE INDEX statements after tables exist
  // This includes UNIQUE indexes required for UPSERT/ON CONFLICT to work
  const createIndexDDL = sortedTableNames
    .map((name) => {
      const table = tableMap.get(name);
      if (!table) return '';
      return generateIndexDDL(table.tableName, table.indexes);
    })
    .filter(Boolean)
    .join('\n');

  // Combine table DDL and index DDL
  const sortedDDL = createIndexDDL
    ? `${createTableDDL}\n\n${createIndexDDL}`
    : createTableDDL;

  // 4. Delegate to existing function
  return createIsolatedTestDb({ schema: sortedDDL, prefix });
}
