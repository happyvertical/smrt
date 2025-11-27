/**
 * Schema generation utilities - Node.js only
 *
 * These functions use SchemaGenerator which depends on node:crypto.
 * Separated from main utils.ts to prevent bundling in browser builds.
 */

import { getModuleConfig } from '@happyvertical/smrt-config';
import { syncSchema } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry';
import { tableNameFromClass, toSnakeCase } from '../utils';

/**
 * Get schema migration configuration from global config
 *
 * @returns Schema migration strategy ('warn' or 'auto-add')
 */
function getSchemaMigrationStrategy(): 'warn' | 'auto-add' {
  try {
    const config = getModuleConfig('core', {
      schemaMigration: { strategy: 'auto-add' as const },
    });
    return config.schemaMigration?.strategy || 'auto-add';
  } catch {
    // If config loading fails, use safe default
    return 'auto-add';
  }
}

/**
 * Generates a complete database schema SQL statement for a class
 *
 * This is a thin wrapper around SchemaGenerator that provides the
 * single source of truth for schema generation. Uses ObjectRegistry
 * cached fields from AST manifest for consistent schema generation.
 *
 * **Note**: Uses dynamic import for SchemaGenerator to avoid bundling
 * Node.js-only code (node:crypto) in browser builds.
 *
 * @param ClassType - Class constructor to generate schema for
 * @param providedFields - Optional fields map (used during registration)
 * @returns SQL schema creation statement with CREATE TABLE and CREATE INDEX statements
 */
export async function generateSchema(
  ClassType: new (...args: any[]) => any,
  providedFields?: Map<string, any>,
) {
  const className = ClassType.name;
  const tableName = tableNameFromClass(ClassType);

  // For external packages, ensure manifest is loaded before proceeding
  if (!providedFields || providedFields.size === 0) {
    await ObjectRegistry.ensureManifestLoaded(className);
  }

  // Use provided fields if available AND non-empty (during registration), otherwise get from registry
  // NEW: Use getAllFields() to include inherited fields from parent classes
  const cachedFields =
    providedFields && providedFields.size > 0
      ? providedFields
      : await ObjectRegistry.getAllFields(className);

  // Throw error if class is not registered AND no fields provided
  if (cachedFields.size === 0) {
    // Detect if running in test environment
    const isTestEnv =
      process.env.NODE_ENV === 'test' ||
      process.env.VITEST === 'true' ||
      typeof (globalThis as any).describe !== 'undefined' ||
      typeof (globalThis as any).it !== 'undefined';

    const testHint = isTestEnv
      ? `\n\n⚠️  Are you using 'smrt test'? ` +
        `Tests require manifest generation.\n` +
        `   ✅ Use: smrt test\n` +
        `   ❌ NOT:  npx vitest\n`
      : '';

    throw new Error(
      `Cannot generate schema for unregistered class '${className}'. ` +
        `Ensure the class is decorated with @smrt() for schema generation to work. ` +
        `Runtime introspection has been removed per issue #131.` +
        testHint,
    );
  }

  // Check if class uses STI strategy
  const tableStrategy = ObjectRegistry.getTableStrategy(className);

  // Dynamic import SchemaGenerator (Node.js-only, uses node:crypto)
  // This prevents bundling it into browser builds
  const { SchemaGenerator } = await import('./generator.js');
  const generator = new SchemaGenerator();

  let schemaDefinition: Awaited<
    ReturnType<
      InstanceType<typeof SchemaGenerator>['generateSchemaFromRegistry']
    >
  >;

  if (tableStrategy === 'sti') {
    // STI: Generate shared table for base class
    const stiBase = ObjectRegistry.getSTIBase(className);

    if (!stiBase) {
      throw new Error(
        `STI strategy detected for '${className}' but no STI base class found. ` +
          `This should not happen - please report this bug.`,
      );
    }

    // Only generate schema for the base class (not for children)
    // Children will use the same table as the base
    if (className === stiBase) {
      // This is the base class - generate STI schema
      schemaDefinition = await generator.generateSTISchemaFromRegistry(
        className,
        tableName,
        cachedFields,
      );
    } else {
      // This is a child class - return null or empty schema
      // The base class schema already includes all fields
      // Child classes don't need their own tables
      return ''; // Empty SQL - table already created by base class
    }
  } else {
    // CTI: Generate separate table for each class
    schemaDefinition = generator.generateSchemaFromRegistry(
      className,
      tableName,
      cachedFields,
    );
  }

  // Store the columns in the registry so database adapters can access them
  // This is critical for STI tables where descendants have additional columns
  // that need to be validated by the JSON adapter (fixes issue #427)
  const registered = ObjectRegistry.getClass(className);
  if (registered?.schema) {
    registered.schema.columns = schemaDefinition.columns;
    registered.schema.ddl = generator.generateSQL(schemaDefinition);
  }

  return generator.generateSQL(schemaDefinition);
}

/**
 * Cache of table setup promises to avoid duplicate setup operations
 *
 * Dual caching strategy:
 * - File-based DBs: String keys "${dbUrl}::${tableName}"
 * - In-memory DBs: WeakMap with db instance as key (prevents cross-instance conflicts)
 */
const _setupTableFromClassPromises: Record<string, Promise<void> | null> = {};
const _memoryDbSetupPromises = new WeakMap<
  any,
  Map<string, Promise<void> | null>
>();

/**
 * Clears the table setup cache - useful for testing
 * @internal
 */
export function _clearSetupTableCache() {
  Object.keys(_setupTableFromClassPromises).forEach((key) => {
    delete _setupTableFromClassPromises[key];
  });
  // Note: WeakMap doesn't need clearing - entries are garbage collected automatically
}

/**
 * Sets up database tables for a class with caching to prevent duplicate operations
 *
 * Creates the database table, indexes, and triggers for a SMRT class.
 * Uses promise caching to ensure each table is only set up once per database.
 * Now leverages ObjectRegistry's cached schema for instant retrieval.
 *
 * @param db - Database connection interface
 * @param ClassType - Class constructor to create tables for
 * @returns Promise that resolves when setup is complete
 * @throws {Error} If schema creation or trigger setup fails
 */
export async function setupTableFromClass(db: any, ClassType: any) {
  const className = ClassType.name;

  // Use SMRT_TABLE_NAME if available (set by @smrt decorator, handles STI correctly)
  // Otherwise derive from class name
  const tableName =
    (ClassType as any).SMRT_TABLE_NAME ||
    className
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/([^s])$/, '$1s')
      .replace(/y$/, 'ies');

  // Dual caching strategy for :memory: vs file-based databases
  const dbUrl = db.url || db.config?.url || 'memory';
  const isMemoryDb = dbUrl === ':memory:' || dbUrl === 'memory';

  // Check cache first
  let cachedPromise: Promise<void> | null | undefined;

  if (isMemoryDb) {
    // Use WeakMap for :memory: databases (instance-specific)
    const tableMap = _memoryDbSetupPromises.get(db);
    cachedPromise = tableMap?.get(tableName);
  } else {
    // Use string key for file-based databases (URL-specific)
    const cacheKey = `${dbUrl}::${tableName}`;
    cachedPromise = _setupTableFromClassPromises[cacheKey];
  }

  if (cachedPromise !== undefined && cachedPromise !== null) {
    return cachedPromise;
  }

  // Create the setup promise
  const setupPromise = (async () => {
    try {
      // Get fields from registry (from AST manifest)
      const cachedFields = ObjectRegistry.getFields(className);

      // Always generate fresh schema to ensure latest field mapping is used
      const schema = await generateSchema(ClassType, cachedFields);
      let _primaryKeyColumn = 'id'; // default

      if (cachedFields.size > 0) {
        for (const [key, field] of cachedFields.entries()) {
          if (field._meta?.primaryKey) {
            _primaryKeyColumn = toSnakeCase(key);
            break;
          }
        }
      }

      // TODO: Implement schema migration detection and automatic column addition
      // When a parent class schema changes (fields added/removed), we should:
      // 1. Detect schema mismatch by comparing current table schema with generated schema
      // 2. Get migration strategy from getSchemaMigrationStrategy()
      // 3. If 'warn': Log warning about mismatch, do nothing
      // 4. If 'auto-add': Generate ALTER TABLE ADD COLUMN statements for new fields
      // 5. Never auto-remove columns (always require manual migration)
      //
      // Implementation outline:
      // const strategy = getSchemaMigrationStrategy();
      // const currentSchema = await db.describeTable(tableName);
      // const missingColumns = detectMissingColumns(currentSchema, schemaDefinition);
      // if (missingColumns.length > 0) {
      //   if (strategy === 'warn') {
      //     console.warn(`Schema mismatch in ${tableName}: missing columns ${missingColumns.join(', ')}`);
      //   } else if (strategy === 'auto-add') {
      //     for (const column of missingColumns) {
      //       await db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${generateColumnDDL(column)}`);
      //     }
      //   }
      // }

      // Skip schema sync for STI child classes (empty schema returned)
      // But ensure the base class table exists first!
      if (schema && schema.trim() !== '') {
        await syncSchema({ db, schema });
      } else {
        // STI child: Ensure base class table exists
        const tableStrategy = ObjectRegistry.getTableStrategy(className);
        if (tableStrategy === 'sti') {
          const stiBase = ObjectRegistry.getSTIBase(className);
          if (stiBase && stiBase !== className) {
            // This is a child - recursively setup base class table
            const baseClass = ObjectRegistry.getClass(stiBase);
            if (baseClass) {
              await setupTableFromClass(db, baseClass.constructor);
            } else {
              // Base class not registered - fail fast with helpful message
              const { ConfigurationError } = await import('../errors.js');
              throw ConfigurationError.unregisteredBaseClass(
                className,
                stiBase,
              );
            }
          }
        }
      }
    } catch (error) {
      // CRITICAL: Clear cache BEFORE throwing to prevent race condition
      // This ensures concurrent callers don't get a stale reference
      if (isMemoryDb) {
        const tableMap = _memoryDbSetupPromises.get(db);
        if (tableMap) {
          tableMap.set(tableName, null);
        }
      } else {
        const cacheKey = `${dbUrl}::${tableName}`;
        _setupTableFromClassPromises[cacheKey] = null;
      }
      throw error;
    }
  })();

  // Store the promise in cache AFTER creating it
  if (isMemoryDb) {
    // Use WeakMap for :memory: databases
    let tableMap = _memoryDbSetupPromises.get(db);
    if (!tableMap) {
      tableMap = new Map();
      _memoryDbSetupPromises.set(db, tableMap);
    }
    tableMap.set(tableName, setupPromise);
  } else {
    // Use string key for file-based databases
    const cacheKey = `${dbUrl}::${tableName}`;
    _setupTableFromClassPromises[cacheKey] = setupPromise;
  }

  return setupPromise;
}

/**
 * Ensures database schema exists for a class (manifest-only, no class references)
 *
 * This is the modern replacement for setupTableFromClass() that works purely from
 * manifest data without needing class constructor references. Supports STI by
 * recursively ensuring base class tables exist.
 *
 * @param db - Database connection interface
 * @param className - Name of the class to ensure schema for
 * @returns Promise that resolves when schema is ensured
 * @throws {Error} If class not registered or schema creation fails
 *
 * @example
 * ```typescript
 * // Simple usage
 * await ensureSchema(db, 'Product');
 *
 * // STI child class - automatically ensures base class table exists
 * await ensureSchema(db, 'Council'); // Also creates 'Profile' table if needed
 * ```
 */
export async function ensureSchema(db: any, className: string): Promise<void> {
  // Get table name from registry (set during @smrt() decoration)
  const tableName = ObjectRegistry.getTableName(className);

  if (!tableName) {
    throw new Error(
      `Cannot ensure schema for unregistered class '${className}'. ` +
        `Ensure the class is decorated with @smrt() and registered in the ObjectRegistry.`,
    );
  }

  // Dual caching strategy for :memory: vs file-based databases
  const dbUrl = db.url || db.config?.url || 'memory';
  const isMemoryDb = dbUrl === ':memory:' || dbUrl === 'memory';

  // Check cache first
  let cachedPromise: Promise<void> | null | undefined;

  if (isMemoryDb) {
    // Use WeakMap for :memory: databases (instance-specific)
    const tableMap = _memoryDbSetupPromises.get(db);
    cachedPromise = tableMap?.get(tableName);
  } else {
    // Use string key for file-based databases (URL-specific)
    const cacheKey = `${dbUrl}::${tableName}`;
    cachedPromise = _setupTableFromClassPromises[cacheKey];
  }

  if (cachedPromise !== undefined && cachedPromise !== null) {
    return cachedPromise;
  }

  // Create the setup promise
  const setupPromise = (async () => {
    try {
      // Get fields from registry (from AST manifest)
      const cachedFields = ObjectRegistry.getFields(className);

      // For STI child classes, ensure base class table exists first
      const tableStrategy = ObjectRegistry.getTableStrategy(className);
      if (tableStrategy === 'sti') {
        const stiBase = ObjectRegistry.getSTIBase(className);

        if (stiBase && stiBase !== className) {
          // This is a child - recursively setup base class table
          await ensureSchema(db, stiBase);
          // Child classes share base table - no schema generation needed
          return;
        }
      }

      // For base classes or CTI, generate and sync schema
      // Get the class constructor for generateSchema (still needed by that function)
      const registered = ObjectRegistry.getClass(className);
      if (!registered) {
        throw new Error(
          `Cannot generate schema for unregistered class '${className}'. ` +
            `Ensure the class is decorated with @smrt().`,
        );
      }

      const schema = await generateSchema(registered.constructor, cachedFields);

      // Skip empty schemas (shouldn't happen for base classes, but defensive)
      if (schema && schema.trim() !== '') {
        await syncSchema({ db, schema });
      }
    } catch (error) {
      // CRITICAL: Clear cache BEFORE throwing to prevent race condition
      if (isMemoryDb) {
        const tableMap = _memoryDbSetupPromises.get(db);
        if (tableMap) {
          tableMap.set(tableName, null);
        }
      } else {
        const cacheKey = `${dbUrl}::${tableName}`;
        _setupTableFromClassPromises[cacheKey] = null;
      }
      throw error;
    }
  })();

  // Store the promise in cache
  if (isMemoryDb) {
    // Use WeakMap for :memory: databases
    let tableMap = _memoryDbSetupPromises.get(db);
    if (!tableMap) {
      tableMap = new Map();
      _memoryDbSetupPromises.set(db, tableMap);
    }
    tableMap.set(tableName, setupPromise);
  } else {
    // Use string key for file-based databases
    const cacheKey = `${dbUrl}::${tableName}`;
    _setupTableFromClassPromises[cacheKey] = setupPromise;
  }

  return setupPromise;
}
