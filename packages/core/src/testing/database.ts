/**
 * Test database utilities for SMRT framework
 *
 * Provides `getTestDatabase()` which creates an in-memory database with all
 * registered SMRT object schemas. Uses the same schema generation logic as
 * the migration system to ensure consistency between test and production.
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
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry.js';
import { SchemaGenerator } from '../schema/generator.js';
import { ensureLegacySystemTableCompatibility } from '../system/compatibility.js';
import { ALL_SYSTEM_TABLES } from '../system/schema.js';

type TestDatabaseConnectionOptions = Parameters<typeof getDatabase>[0] & {
  __smrtSkipVitestSchemaPreparation?: boolean;
};

/**
 * Options for creating a test database
 */
export interface TestDatabaseOptions {
  /**
   * Database type (default: 'sqlite')
   * - 'sqlite': SQLite database
   * - 'json': JSON adapter (stores data as JSON files with DuckDB for querying)
   */
  type?: 'sqlite' | 'json';

  /**
   * Database URL (default: ':memory:')
   * Use ':memory:' for in-memory databases (fastest for tests)
   * Or provide a file path for persistent test databases
   */
  url?: string;

  /**
   * Pre-existing database to initialize schemas in.
   * If provided, `type` and `url` are ignored.
   */
  db?: DatabaseInterface;

  /**
   * Specific classes to setup schemas for.
   * If not provided, sets up schemas for all registered classes.
   */
  classes?: string[];

  /**
   * Whether to include system tables (default: true)
   * System tables include _smrt_contexts, _smrt_migrations, etc.
   */
  includeSystemTables?: boolean;
}

function resolveRequestedSchemaClassName(className: string): string {
  const registered = ObjectRegistry.getClass(className);
  if (!registered || registered.extends !== 'SmrtCollection') {
    return className;
  }

  const tableName =
    registered.schema?.tableName ||
    registered.config.tableName ||
    ObjectRegistry.getTableName(className);
  if (!tableName) {
    return className;
  }

  const collectionPackage = registered.packageName;

  for (const candidate of ObjectRegistry.getAllClasses().values()) {
    if (candidate === registered || candidate.extends === 'SmrtCollection') {
      continue;
    }

    const candidateTableName =
      candidate.schema?.tableName || candidate.config.tableName;
    if (candidateTableName !== tableName) {
      continue;
    }

    if (
      collectionPackage &&
      candidate.packageName &&
      candidate.packageName !== collectionPackage
    ) {
      continue;
    }

    const candidateLookupName = candidate.qualifiedName || candidate.name;
    const stiBase = ObjectRegistry.getSTIBase(candidateLookupName);
    return stiBase || candidateLookupName;
  }

  return className;
}

function resolveRequestedSchemaClassNames(classNames: string[]): string[] {
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const className of classNames) {
    const schemaClassName = resolveRequestedSchemaClassName(className);
    if (seen.has(schemaClassName)) {
      continue;
    }

    seen.add(schemaClassName);
    resolved.push(schemaClassName);
  }

  return resolved;
}

/**
 * Creates an in-memory test database with schemas pre-created
 *
 * This utility is designed for testing. It creates an in-memory database
 * and initializes all registered SMRT object schemas using the **same
 * schema generation logic** as the production migration system.
 *
 * **Key features:**
 * - Uses `SchemaGenerator.generateSQL()` - the single source of truth for DDL
 * - Handles STI (Single Table Inheritance) correctly
 * - Creates system tables for framework functionality
 * - Safe for parallel test execution (each call creates isolated instance)
 *
 * @param options - Configuration options
 * @returns Promise resolving to configured DatabaseInterface
 *
 * @example
 * ```typescript
 * // Basic usage - all registered schemas
 * const db = await getTestDatabase();
 *
 * // Specific classes only
 * const db = await getTestDatabase({ classes: ['Council', 'Meeting'] });
 *
 * // JSON adapter instead of SQLite
 * const db = await getTestDatabase({ type: 'json' });
 *
 * // File-based database for persistent tests
 * const db = await getTestDatabase({ type: 'sqlite', url: '/tmp/test.db' });
 *
 * // Initialize schemas in an existing database
 * const myDb = await getDatabase({ type: 'sqlite', url: ':memory:' });
 * await getTestDatabase({ db: myDb });
 *
 * // Skip system tables (rare use case)
 * const db = await getTestDatabase({ includeSystemTables: false });
 * ```
 */
export async function getTestDatabase(
  options: TestDatabaseOptions = {},
): Promise<DatabaseInterface> {
  const {
    type = 'sqlite',
    url = ':memory:',
    db: existingDb,
    classes,
    includeSystemTables = true,
  } = options;

  // Use existing database or create new one
  const db =
    existingDb ??
    (await getDatabase({
      type,
      url,
      __smrtSkipVitestSchemaPreparation: true,
    } as TestDatabaseConnectionOptions));

  // Initialize system tables (same as production)
  if (includeSystemTables) {
    await initializeSystemTables(db);
  }

  // Get class names to setup
  const classNames = resolveRequestedSchemaClassNames(
    classes ?? ObjectRegistry.getClassNames(),
  );

  // Skip if no classes registered
  if (classNames.length === 0) {
    return db;
  }

  // Use the same schema generation as production
  const schemaGenerator = new SchemaGenerator();

  // Track created tables to avoid duplicates (STI base classes)
  const createdTables = new Set<string>();

  for (const className of classNames) {
    // Skip STI children - their schema is part of the base class table
    const stiBase = ObjectRegistry.getSTIBase(className);
    if (stiBase && stiBase !== className) {
      continue;
    }

    const tableName = ObjectRegistry.getTableName(className);
    if (!tableName || createdTables.has(tableName)) {
      continue;
    }

    const fields = await ObjectRegistry.getAllFields(className);
    const strategy = ObjectRegistry.getTableStrategy(className);
    const runtimeSchemaConfig = {
      conflictColumns: ObjectRegistry.getConflictColumns(className),
    };

    // Generate schema using SchemaGenerator (same as migrations)
    const schema =
      strategy === 'sti'
        ? await schemaGenerator.generateSTISchemaFromRegistry(
            className,
            tableName,
            fields,
          )
        : schemaGenerator.generateSchemaFromRegistry(
            className,
            tableName,
            fields,
            runtimeSchemaConfig,
          );

    // Generate DDL using generateSQL() - the single source of truth
    const ddl = schemaGenerator.generateSQL(schema);

    try {
      await db.query(ddl);
      createdTables.add(tableName);

      // Create indexes (use DDL strategy so jsonPath / where / etc. render)
      const ddlStrategy = (
        await import('../schema/ddl/index.js')
      ).getDDLStrategy(
        // Map test database type → DDL engine. We default to sqlite since
        // getTestDatabase is sqlite-first; if extended for postgres, the
        // outer schema generator already accounts for engine-specific shapes.
        'sqlite',
      );
      const indexStatements = ddlStrategy.generateIndexes(schema);
      for (const indexSQL of indexStatements) {
        try {
          await db.query(indexSQL);
        } catch (indexError) {
          // Log but don't fail on index creation errors
          // Some indexes may fail if columns don't exist (STI meta fields)
          console.warn(
            `[getTestDatabase] Warning: Failed to create index: ${indexError instanceof Error ? indexError.message : String(indexError)} (SQL: ${indexSQL})`,
          );
        }
      }
    } catch (error) {
      // Provide helpful error message for table creation failures
      throw new Error(
        `[getTestDatabase] Failed to create table '${tableName}' for class '${className}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  return db;
}

/**
 * Initialize SMRT system tables in a database
 *
 * System tables use _smrt_ prefix and store framework metadata.
 * All statements use `IF NOT EXISTS` for idempotency.
 *
 * @param db - Database interface to initialize
 */
async function initializeSystemTables(db: DatabaseInterface): Promise<void> {
  await ensureLegacySystemTableCompatibility(db);

  // Split multi-statement SQL into individual statements
  const allStatements: string[] = [];
  for (const multiStatementSQL of ALL_SYSTEM_TABLES) {
    const statements = multiStatementSQL
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    allStatements.push(...statements);
  }

  // Use db.query() — system tables use CREATE TABLE/INDEX IF NOT EXISTS
  // which databases handle natively without per-column existence checks.
  for (const statement of allStatements) {
    await db.query(statement);
  }
}
