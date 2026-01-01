/**
 * Schema generation utilities - Node.js only
 *
 * These functions use SchemaGenerator which depends on node:crypto.
 * Separated from main utils.ts to prevent bundling in browser builds.
 *
 * SMRT handles ALL database maintenance directly.
 * SDK SQL remains a pure query/CRUD layer.
 */

import { getModuleConfig } from '@happyvertical/smrt-config';
import { syncSchema } from '@happyvertical/sql';
import { discoverSTISiblingsSync } from '../manifest/manifest-loader.js';
import { ObjectRegistry } from '../registry';
import { tableNameFromClass, toSnakeCase } from '../utils';
import { SchemaManager } from './schema-manager';

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

  // Throw error if no fields found
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

    // Check if class is actually registered (decorator ran but no fields loaded)
    const isRegistered = ObjectRegistry.hasClass(className);

    if (isRegistered) {
      // Class registered but no fields - manifest problem
      throw new Error(
        `No field metadata found for class '${className}'. ` +
          `The class is registered (decorator ran) but has no field definitions. ` +
          `This usually means the manifest file is missing or stale.` +
          testHint,
      );
    } else {
      // Class not registered - decorator never ran
      throw new Error(
        `Cannot generate schema for unregistered class '${className}'. ` +
          `Ensure the class is decorated with @smrt() for schema generation to work. ` +
          `Runtime introspection has been removed per issue #131.` +
          testHint,
      );
    }
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

  // Store the full schema definition in the registry
  // This is critical for:
  // - STI tables where descendants have additional columns (issue #427)
  // - Per-engine DDL generation via SchemaManager
  const registered = ObjectRegistry.getClass(className);
  if (registered) {
    // Store the full SchemaDefinition for SchemaManager to use
    registered.schema = schemaDefinition;
    // Also store generated DDL for backward compatibility
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
  const smrtTableName = (ClassType as any).SMRT_TABLE_NAME;
  const tableName =
    smrtTableName ||
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
        // Use SchemaManager for direct DDL execution with per-engine support
        const schemaDefinition = ObjectRegistry.getSchema(className);
        if (schemaDefinition) {
          const schemaManager = new SchemaManager(db);
          await schemaManager.ensureTable(schemaDefinition);
        } else {
          // Fallback: This shouldn't happen but handle gracefully
          console.warn(
            `[setupTableFromClass] No SchemaDefinition found for ${className}, skipping`,
          );
        }
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
  // FIX #623: For STI child classes from external packages, ensure the parent class
  // is loaded before calling getSTIBase(). The parent might not be registered yet
  // if it's from an external package manifest.
  const registered = ObjectRegistry.getClass(className);
  if (registered?.extends) {
    const parentClass = ObjectRegistry.getClass(registered.extends);
    if (!parentClass) {
      // Parent class not registered yet - discover and load STI siblings
      // This will register the parent and any other siblings sharing the same table
      const collection =
        registered.schema?.tableName ||
        ObjectRegistry.getSchema(className)?.tableName;
      if (collection) {
        console.log(
          `[ensureSchema] Loading STI siblings for ${className} (parent ${registered.extends} not registered)`,
        );
        const siblings = discoverSTISiblingsSync(collection);
        for (const sibling of siblings) {
          if (!ObjectRegistry.hasClass(sibling.className)) {
            ObjectRegistry.registerFromManifest(
              sibling.className,
              sibling.entry,
              sibling.packageName,
            );
          }
        }
      }
    }
  }

  // Get table name from registry (set during @smrt() decoration)
  const tableName = ObjectRegistry.getTableName(className);

  if (!tableName) {
    throw new Error(
      `Cannot ensure schema for unregistered class '${className}'. ` +
        `Ensure the class is decorated with @smrt() and registered in the ObjectRegistry.`,
    );
  }

  // CRITICAL: Check if this is an STI child BEFORE any caching
  // STI children should delegate directly to their base class without caching
  // their own promise under the shared table name. This avoids a deadlock where:
  // 1. Child caches promise P1 for table T
  // 2. Child's async work calls ensureSchema(base)
  // 3. Base finds P1 cached for table T and returns it
  // 4. Child is waiting on P1, which only resolves when child completes
  // 5. DEADLOCK
  const tableStrategy = ObjectRegistry.getTableStrategy(className);
  if (tableStrategy === 'sti') {
    const stiBase = ObjectRegistry.getSTIBase(className);
    if (stiBase && stiBase !== className) {
      // This is an STI child - delegate directly to base without caching
      return ensureSchema(db, stiBase);
    }
  }

  // From here, we're either:
  // - An STI base class (stiBase === className)
  // - A CTI class (no STI at all)
  // These are safe to cache because they won't recursively call ensureSchema

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

  // Create the setup promise - no recursion possible from here
  // (STI children already delegated above)
  const setupPromise = (async () => {
    // Get fields from registry (from AST manifest)
    const cachedFields = ObjectRegistry.getFields(className);

    // For base classes or CTI, get schema and sync
    // Use pre-generated DDL from manifest (zero runtime overhead)
    // STI schemas now include ALL descendant columns (generated at build time)
    const preGenerated = ObjectRegistry.getSchema(className);

    // FIX #527: For STI classes with cross-package descendants, regenerate schema at runtime
    // Pre-generated schemas from external packages won't have columns from
    // child classes defined in consuming packages (e.g., Agenda.meetingId from praeco)
    const descendants = ObjectRegistry.getDescendants(className);

    // Check if any STI descendants are from a different package than the base class
    // If so, pre-generated schema may be missing their columns
    let hasCrossPackageDescendants = false;
    if (tableStrategy === 'sti' && descendants.length > 0) {
      const baseClass = ObjectRegistry.getClass(className);
      const basePackage = baseClass?.packageName;

      for (const descendantName of descendants) {
        const descendant = ObjectRegistry.getClass(descendantName);
        if (!descendant) continue;
        // Descendant is from a different package if packageName values don't match
        if (basePackage !== descendant.packageName) {
          hasCrossPackageDescendants = true;
          break;
        }
      }
    }

    if (preGenerated?.ddl && !hasCrossPackageDescendants) {
      // Use pre-generated schema from manifest
      // Safe for CTI classes or STI where all classes are from same package
      const schemaManager = new SchemaManager(db);
      await schemaManager.ensureTable(preGenerated);
    } else {
      // Fallback: regenerate schema at runtime using SchemaGenerator
      // This happens for external packages that don't have DDL in their manifest
      const registered = ObjectRegistry.getClass(className);
      if (!registered) {
        throw new Error(
          `Cannot generate schema for unregistered class '${className}'. ` +
            `Ensure the class is decorated with @smrt().`,
        );
      }

      // Dynamic import SchemaGenerator (Node.js-only, uses node:crypto)
      const { SchemaGenerator } = await import('./generator.js');
      const generator = new SchemaGenerator();

      // Check if class uses STI strategy
      const tableStrategy = ObjectRegistry.getTableStrategy(className);

      let schemaDefinition: Awaited<
        ReturnType<
          InstanceType<typeof SchemaGenerator>['generateSchemaFromRegistry']
        >
      >;

      if (tableStrategy === 'sti') {
        // STI: Generate shared table for base class with all descendant columns
        schemaDefinition = await generator.generateSTISchemaFromRegistry(
          className,
          tableName,
          cachedFields,
        );
      } else {
        // CTI: Generate separate table for this class
        schemaDefinition = generator.generateSchemaFromRegistry(
          className,
          tableName,
          cachedFields,
        );
      }

      // Generate DDL and store columns in the registry
      const createTableDDL = generator.generateSQL(schemaDefinition);
      if (registered.schema) {
        registered.schema.columns = schemaDefinition.columns;
        registered.schema.ddl = createTableDDL;
      }

      // Generate index SQL strings from schemaDefinition.indexes
      // These must be included in the schema string for syncSchema to process them
      // (especially for JSON/DuckDB adapter which converts UNIQUE indexes to inline constraints)
      const indexStatements: string[] = [];
      if (schemaDefinition.indexes && schemaDefinition.indexes.length > 0) {
        for (const idx of schemaDefinition.indexes) {
          const indexType = idx.unique ? 'UNIQUE INDEX' : 'INDEX';
          const columns = idx.columns.map((c) => `"${c}"`).join(', ');
          indexStatements.push(
            `CREATE ${indexType} IF NOT EXISTS "${idx.name}" ON "${schemaDefinition.tableName}" (${columns})`,
          );
        }
      }

      // Combine CREATE TABLE and CREATE INDEX statements for syncSchema
      // The JSON/DuckDB adapter will convert UNIQUE indexes to inline constraints
      const fullSchema = [createTableDDL, ...indexStatements].join(';\n');

      // Use syncSchema to execute DDL (like main branch does for external packages)
      if (fullSchema && fullSchema.trim() !== '') {
        await syncSchema({ db, schema: fullSchema });
      }
    }
  })();

  // Store in cache AFTER creating the promise
  // Safe because no recursion can happen (STI children delegate at the top)
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

  // Handle errors by clearing cache
  setupPromise.catch((_error) => {
    if (isMemoryDb) {
      const tableMap = _memoryDbSetupPromises.get(db);
      if (tableMap) {
        tableMap.set(tableName, null);
      }
    } else {
      const cacheKey = `${dbUrl}::${tableName}`;
      _setupTableFromClassPromises[cacheKey] = null;
    }
  });

  return setupPromise;
}
