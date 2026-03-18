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

type VitestDatabaseConnectionOptions = Parameters<
  typeof import('@happyvertical/sql')['getDatabase']
>[0] & {
  __smrtSkipVitestSchemaPreparation?: boolean;
};

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
  const { schema, prefix = 'smrt-isolated' } = options;

  // Dynamically import getDatabase to avoid circular dependencies
  const { getDatabase, syncSchema } = await import('@happyvertical/sql');

  const config = getTestDbConfig(prefix);

  // Create the base database connection
  // Cast to extended interface that includes beginTransaction (from SDK #722)
  const baseDb = (await getDatabase({
    ...config,
    __smrtSkipVitestSchemaPreparation: true,
  } as VitestDatabaseConnectionOptions)) as DatabaseInterfaceWithTransaction;

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
 * Tokenize CREATE TABLE body into individual column/constraint definitions.
 *
 * Splits on top-level commas (not inside parentheses or quotes) so it works
 * for both multi-line and single-line DDL strings.
 */
function tokenizeDDLBody(body: string): string[] {
  const segments: string[] = [];
  let current = '';
  let parenDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let prevChar = '';

  for (const ch of body) {
    if (ch === "'" && !inDoubleQuote && prevChar !== '\\') {
      inSingleQuote = !inSingleQuote;
    } else if (ch === '"' && !inSingleQuote && prevChar !== '\\') {
      inDoubleQuote = !inDoubleQuote;
    } else if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '(') parenDepth += 1;
      else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
    }

    if (ch === ',' && parenDepth === 0 && !inSingleQuote && !inDoubleQuote) {
      const trimmed = current.trim();
      if (trimmed) segments.push(trimmed);
      current = '';
    } else {
      current += ch;
    }

    prevChar = ch;
  }

  const last = current.trim();
  if (last) segments.push(last);

  return segments;
}

/** Keywords that indicate a table-level constraint, not a column definition */
const CONSTRAINT_KEYWORDS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'FOREIGN',
  'UNIQUE',
  'CHECK',
]);

/**
 * Parse column definitions from a CREATE TABLE DDL statement
 *
 * Returns a Map of column name → full column definition line.
 * Skips table-level constraints (FOREIGN KEY, PRIMARY KEY, etc.).
 */
function parseColumnsFromDDL(ddl: string): Map<string, string> {
  const columns = new Map<string, string>();
  // Match the body between CREATE TABLE ... ( ... )
  const bodyMatch = ddl.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?\s*\(([\s\S]+)\)/i,
  );
  if (!bodyMatch) return columns;

  const segments = tokenizeDDLBody(bodyMatch[1]);

  for (const segment of segments) {
    // Extract first identifier and check if it's a constraint keyword
    const colMatch = segment.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/);
    if (!colMatch) continue;

    const firstToken = colMatch[1].toUpperCase();
    if (CONSTRAINT_KEYWORDS.has(firstToken)) continue;

    columns.set(colMatch[1], segment);
  }

  return columns;
}

/**
 * Merge two DDL statements for the same table (STI subclasses)
 *
 * Takes the union of all columns from both DDLs.
 * When a column exists in both, the existing definition is kept.
 */
function mergeDDL(existingDDL: string, newDDL: string): string {
  const existingCols = parseColumnsFromDDL(existingDDL);
  const newCols = parseColumnsFromDDL(newDDL);

  // Find columns in newDDL that are missing from existingDDL
  const missingCols: string[] = [];
  for (const [name, def] of newCols) {
    if (!existingCols.has(name)) {
      missingCols.push(def);
    }
  }

  if (missingCols.length === 0) return existingDDL;

  // Insert missing columns before the closing paren
  const closingIdx = existingDDL.lastIndexOf(')');
  if (closingIdx === -1) return existingDDL;

  const before = existingDDL.substring(0, closingIdx).trimEnd();
  const after = existingDDL.substring(closingIdx);
  const additions = missingCols.map((col) => `  ${col}`).join(',\n');

  return `${before},\n${additions}\n${after}`;
}

/**
 * Merge indexes from multiple STI subclasses sharing the same table
 *
 * Deduplicates by index name, keeping the first occurrence.
 */
function mergeIndexes(
  existing: ManifestIndex[],
  incoming: ManifestIndex[],
): ManifestIndex[] {
  const names = new Set(existing.map((i) => i.name));
  const merged = [...existing];
  for (const idx of incoming) {
    if (!names.has(idx.name)) {
      names.add(idx.name);
      merged.push(idx);
    }
  }
  return merged;
}

/**
 * Extract DDL from manifest objects with STI deduplication
 *
 * Multiple classes may share the same table (STI), so we deduplicate by tableName.
 * When STI subclasses add columns, DDLs are merged to include all columns.
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

    // Merge by tableName — STI subclasses may add columns to the same table
    const existing = tableMap.get(tableName);
    if (!existing) {
      tableMap.set(tableName, {
        tableName,
        ddl,
        indexes,
        dependencies: extractForeignKeyDependencies(ddl),
      });
    } else {
      // Merge DDL columns and indexes from this STI subclass
      existing.ddl = mergeDDL(existing.ddl, ddl);
      existing.indexes = mergeIndexes(existing.indexes, indexes);
      // Merge FK dependencies
      const newDeps = extractForeignKeyDependencies(ddl);
      for (const dep of newDeps) {
        if (!existing.dependencies.includes(dep)) {
          existing.dependencies.push(dep);
        }
      }
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
