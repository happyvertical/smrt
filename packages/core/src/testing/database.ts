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
import { ensurePostgresChangeFeedAppendFunction } from '../change-feed.js';
import {
  type CollectionRegistrationLookup,
  isCollectionRegistration,
  resolveCollectionItemClassName,
  resolveRelatedRegistration,
} from '../registry/collection-resolution.js';
import { ObjectRegistry } from '../registry.js';
import { detectEngine } from '../schema/ddl/index.js';
import { schemaForeignKeys } from '../schema/foreign-key-ddl.js';
import { planForeignKeyCreation } from '../schema/foreign-key-planner.js';
import { SchemaGenerator } from '../schema/generator.js';
import type { SchemaDefinition } from '../schema/types.js';
import { ensureLegacySystemTableCompatibility } from '../system/compatibility.js';
import { getSystemTableDDL } from '../system/schema.js';

type TestDatabaseConnectionOptions = Parameters<typeof getDatabase>[0] & {
  __smrtSkipVitestSchemaPreparation?: boolean;
};

function resolveSTIBaseRegistration(className: string, stiBaseName: string) {
  const registered = ObjectRegistry.getClass(className);

  if (stiBaseName.includes(':')) {
    return ObjectRegistry.getClass(stiBaseName);
  }

  if (registered?.packageName) {
    const samePackageBase = ObjectRegistry.getClassInPackage(
      registered.packageName,
      stiBaseName,
    );
    if (samePackageBase) {
      return samePackageBase;
    }
  }

  return ObjectRegistry.getClass(stiBaseName);
}

function resolveSTIBaseLookupName(
  className: string,
  stiBaseName: string,
): string {
  const stiBase = resolveSTIBaseRegistration(className, stiBaseName);
  return stiBase?.qualifiedName || stiBase?.name || stiBaseName;
}

function isSTIChild(className: string): boolean {
  const stiBaseName = ObjectRegistry.getSTIBase(className);
  if (!stiBaseName) {
    return false;
  }

  const registered = ObjectRegistry.getClass(className);
  const stiBase = resolveSTIBaseRegistration(className, stiBaseName);

  if (registered && stiBase) {
    return registered !== stiBase;
  }

  return stiBaseName !== className;
}

type RegisteredSchemaClass = NonNullable<
  ReturnType<typeof ObjectRegistry.getClass>
>;

const collectionRegistrationLookup: CollectionRegistrationLookup = {
  findClass: (className) => ObjectRegistry.getClass(className),
  findClassInPackage: (packageName, className) =>
    ObjectRegistry.getClassInPackage(packageName, className),
  getInheritanceChain: (className) =>
    ObjectRegistry.getInheritanceChain(className),
};

function resolveCollectionSchemaClassName(
  className: string,
  registered: RegisteredSchemaClass,
): string {
  const itemClassName = resolveCollectionItemClassName(
    className,
    registered,
    collectionRegistrationLookup,
  );
  if (itemClassName) {
    const itemRegistration = resolveRelatedRegistration(
      itemClassName,
      registered,
      collectionRegistrationLookup,
    );
    const itemLookupName =
      itemRegistration?.qualifiedName ||
      itemRegistration?.name ||
      itemClassName;
    const stiBase = ObjectRegistry.getSTIBase(itemLookupName);
    return stiBase
      ? resolveSTIBaseLookupName(itemLookupName, stiBase)
      : itemLookupName;
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
    if (
      candidate === registered ||
      isCollectionRegistration(
        candidate.qualifiedName || candidate.name,
        candidate,
        collectionRegistrationLookup,
      )
    ) {
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
    return stiBase
      ? resolveSTIBaseLookupName(candidateLookupName, stiBase)
      : candidateLookupName;
  }

  return className;
}

/**
 * Options for creating a test database
 */
export interface TestDatabaseOptions {
  /**
   * Database type (default: 'sqlite')
   * - 'sqlite': SQLite database
   * - 'json': JSON adapter (stores data as JSON files with DuckDB for querying)
   * - 'duckdb': Native DuckDB database
   * - 'postgres': PostgreSQL database (normally supplied through `db`)
   */
  type?: 'sqlite' | 'json' | 'duckdb' | 'postgres';

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

  /**
   * Explicitly omit physical FK constraints for adapter/query tests whose
   * subject is unrelated to referential enforcement. Defaults to `false`.
   * This is required (and deliberately noisy at the call site) when a DuckDB
   * fixture uses generated `ON UPDATE CASCADE`, which DuckDB cannot enforce.
   */
  omitForeignKeyConstraints?: boolean;
}

/** Resolve the DDL dialect used when preparing an existing test database. */
export function resolveTestDatabaseDDLEngine(
  type: TestDatabaseOptions['type'],
  db: DatabaseInterface,
  inferFromDatabase = false,
): 'sqlite' | 'json' | 'duckdb' | 'postgres' {
  // When this helper created the adapter, the requested type is authoritative.
  // Native DuckDB and JSON-on-DuckDB both expose exportTable(), so capability
  // inference must not override an explicit native DuckDB request.
  if (!inferFromDatabase) {
    return type ?? 'sqlite';
  }

  const configuredDb = db as DatabaseInterface & {
    config?: { type?: string; url?: string };
    type?: string;
    exportTable?: unknown;
    inferSchemaFromJSON?: unknown;
    getTableLoadErrors?: unknown;
  };

  if (
    typeof configuredDb.inferSchemaFromJSON === 'function' ||
    typeof configuredDb.getTableLoadErrors === 'function'
  ) {
    return 'json';
  }

  if (typeof configuredDb.exportTable === 'function') {
    // The native DuckDB adapter exposes schema evolution capabilities that the
    // JSON adapter does not. Keep exportTable-only test doubles compatible with
    // the historical JSON structural marker.
    if (
      typeof configuredDb.getTableSchema === 'function' &&
      typeof configuredDb.alterTable?.addColumn === 'function'
    ) {
      return 'duckdb';
    }
    return 'json';
  }

  return detectEngine(
    db.url || configuredDb.config?.url || '',
    configuredDb.type || configuredDb.config?.type,
  );
}

function omitTestForeignKeyConstraints(
  schema: SchemaDefinition,
): SchemaDefinition {
  const foreignKeyTargets = new Set(
    schemaForeignKeys(schema).map((foreignKey) => foreignKey.referencesTable),
  );
  return {
    ...schema,
    columns: Object.fromEntries(
      Object.entries(schema.columns).map(([name, column]) => [
        name,
        column.foreignKey ? { ...column, foreignKey: undefined } : column,
      ]),
    ),
    foreignKeys: [],
    dependencies: schema.dependencies.filter(
      (dependency) => !foreignKeyTargets.has(dependency),
    ),
  };
}

function resolveRequestedSchemaClassName(className: string): string {
  const registered = ObjectRegistry.getClass(className);
  if (!registered) {
    return className;
  }

  if (
    !isCollectionRegistration(
      className,
      registered,
      collectionRegistrationLookup,
    )
  ) {
    const stiBase = ObjectRegistry.getSTIBase(className);
    return stiBase ? resolveSTIBaseLookupName(className, stiBase) : className;
  }

  return resolveCollectionSchemaClassName(className, registered);
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
 * // Native DuckDB adapter
 * const db = await getTestDatabase({ type: 'duckdb', url: ':memory:' });
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
    type,
    url = ':memory:',
    db: existingDb,
    classes,
    includeSystemTables = true,
    omitForeignKeyConstraints = false,
  } = options;

  // Use existing database or create new one
  const db =
    existingDb ??
    (await getDatabase({
      type: type ?? 'sqlite',
      url,
      __smrtSkipVitestSchemaPreparation: true,
    } as TestDatabaseConnectionOptions));

  // Initialize system tables (same as production)
  if (includeSystemTables) {
    await initializeSystemTables(db);
  }

  // Get class names to setup
  const classNames = resolveRequestedSchemaClassNames(
    classes ?? ObjectRegistry.getQualifiedClassNames(),
  );

  // Skip if no classes registered
  if (classNames.length === 0) {
    return db;
  }

  // Use the same schema generation as production
  const schemaGenerator = new SchemaGenerator();
  const ddlEngine = resolveTestDatabaseDDLEngine(
    type,
    db,
    existingDb !== undefined,
  );

  // Collect every table before executing DDL so dependency ordering and cycle
  // handling are identical to production migration/schema paths (#2413).
  const schemas = new Map<
    string,
    { schema: SchemaDefinition; className: string }
  >();
  const authoritativeSchemas = ObjectRegistry.getAllSchemasAsDefinitions();

  for (const className of classNames) {
    // R11: the registration carries idType (native uuid vs text); read it
    // below when building runtimeSchemaConfig.
    const registered = ObjectRegistry.getClass(className);
    // Skip STI children - their schema is part of the base class table.
    // main (#1324): isSTIChild() compares RegisteredClass *identity* rather
    // than raw strings, so it stays correct under R5-canon (getSTIBase returns
    // qualified names) while also handling collection/override registrations.
    if (isSTIChild(className)) {
      continue;
    }

    const tableName = ObjectRegistry.getTableName(className);
    if (!tableName || schemas.has(tableName)) {
      continue;
    }

    const fields = await ObjectRegistry.getAllFields(className);
    const strategy = ObjectRegistry.getTableStrategy(className);
    // Mirrors `schema/utils.ts`: this bag is rebuilt by hand, so every `@smrt()`
    // option the generator reads has to be listed or tests silently diverge
    // from the production schema. `indexes` (#2357) was missing from both.
    const runtimeSchemaConfig = {
      conflictColumns: ObjectRegistry.getConflictColumns(className),
      idType: registered?.config.idType,
      indexes: registered?.config.indexes,
      registry: ObjectRegistry,
    };

    // Generate schema through the registry paths. Production (`manifest.json`
    // and therefore `smrt db:migrate`) uses the manifest paths
    // (`generateSTISchemaFromManifest` / `generateCTISchemaFromManifest`);
    // the two families are held to the same column and index sets by
    // `src/schema/schema-path-parity.test.ts` (#2359) — do not assume they
    // agree by construction.
    const schema =
      strategy === 'sti'
        ? await schemaGenerator.generateSTISchemaFromRegistry(
            className,
            tableName,
            fields,
            runtimeSchemaConfig,
          )
        : schemaGenerator.generateSchemaFromRegistry(
            className,
            tableName,
            fields,
            runtimeSchemaConfig,
          );

    // Manifest registrations can carry explicit FK actions that differ from
    // decorator defaults. The deterministic merged table schema preserves
    // those authoritative actions while still backfilling runtime-only fields.
    const authoritativeSchema = authoritativeSchemas[tableName];
    const effectiveColumns = authoritativeSchema
      ? Object.fromEntries(
          Object.entries(schema.columns).map(([name, column]) => {
            const manifestColumn = authoritativeSchema.columns[name];
            return [
              name,
              manifestColumn
                ? { ...column, foreignKey: manifestColumn.foreignKey }
                : column,
            ];
          }),
        )
      : schema.columns;
    const effectiveForeignKeys = schemaForeignKeys({
      columns: effectiveColumns,
      foreignKeys: [],
    });
    const effectiveSchema: SchemaDefinition = {
      ...schema,
      columns: effectiveColumns,
      foreignKeys: effectiveForeignKeys,
      dependencies: effectiveForeignKeys
        .map((foreignKey) => foreignKey.referencesTable)
        .filter((dependency) => dependency !== tableName),
    };

    schemas.set(tableName, {
      schema: omitForeignKeyConstraints
        ? omitTestForeignKeyConstraints(effectiveSchema)
        : effectiveSchema,
      className,
    });
  }

  // Explicitly requested test classes still need their registered parents.
  // Add the authoritative dependency closure so a child-only request cannot
  // emit a physical reference to a table this helper never creates.
  const addDependencies = (schema: SchemaDefinition): void => {
    for (const foreignKey of schemaForeignKeys(schema)) {
      if (schemas.has(foreignKey.referencesTable)) continue;
      const dependency = authoritativeSchemas[foreignKey.referencesTable];
      if (!dependency) continue;
      const effectiveDependency = omitForeignKeyConstraints
        ? omitTestForeignKeyConstraints(dependency)
        : dependency;
      schemas.set(dependency.tableName, {
        schema: effectiveDependency,
        className: dependency.tableName,
      });
      addDependencies(effectiveDependency);
    }
  };
  for (const { schema } of [...schemas.values()]) addDependencies(schema);

  const tablePlan = planForeignKeyCreation(
    [...schemas.values()].map(({ schema }) => schema),
    ddlEngine,
  );
  const ddlStrategy = (await import('../schema/ddl/index.js')).getDDLStrategy(
    ddlEngine,
  );

  for (const schema of tablePlan.schemas) {
    const className = schemas.get(schema.tableName)?.className ?? 'unknown';
    const ddl = schemaGenerator.generateSQL(schema, ddlEngine);

    try {
      await db.query(ddl);

      // Create indexes (use DDL strategy so jsonPath / where / etc. render)
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
        `[getTestDatabase] Failed to create table '${schema.tableName}' for class '${className}': ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  for (const statement of tablePlan.deferredStatements) {
    try {
      await db.query(statement);
    } catch (error) {
      throw new Error(
        `[getTestDatabase] Failed to add deferred foreign-key constraint: ${error instanceof Error ? error.message : String(error)} (SQL: ${statement})`,
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

  const configuredDb = db as DatabaseInterface & {
    config?: { type?: string; url?: string };
    type?: string;
  };
  const engine = detectEngine(
    db.url || configuredDb.config?.url || '',
    configuredDb.type || configuredDb.config?.type,
  );

  // Split multi-statement SQL into individual statements
  const allStatements: string[] = [];
  for (const multiStatementSQL of getSystemTableDDL(engine)) {
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

  // PostgreSQL keeps the best-effort append boundary in a function that must
  // be executed whole rather than included in semicolon-split portable DDL.
  await ensurePostgresChangeFeedAppendFunction(db);
}
