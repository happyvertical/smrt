/**
 * Schema generation utilities - Node.js only
 *
 * These functions use SchemaGenerator which depends on node:crypto.
 * Separated from main utils.ts to prevent bundling in browser builds.
 */

import { syncSchema } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry';
import { tableNameFromClass, toSnakeCase } from '../utils';

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
  const cachedFields =
    providedFields && providedFields.size > 0
      ? providedFields
      : ObjectRegistry.getFields(className);

  // Throw error if class is not registered AND no fields provided
  if (cachedFields.size === 0) {
    throw new Error(
      `Cannot generate schema for unregistered class '${className}'. ` +
        `Ensure the class is decorated with @smrt() for schema generation to work. ` +
        `Runtime introspection has been removed per issue #131.`,
    );
  }

  // Dynamic import SchemaGenerator (Node.js-only, uses node:crypto)
  // This prevents bundling it into browser builds
  const { SchemaGenerator } = await import('./generator.js');
  const generator = new SchemaGenerator();
  const schemaDefinition = generator.generateSchemaFromRegistry(
    className,
    tableName,
    cachedFields,
  );

  return generator.generateSQL(schemaDefinition);
}

/**
 * Cache of table setup promises to avoid duplicate setup operations
 */
const _setupTableFromClassPromises: Record<string, Promise<void> | null> = {};

/**
 * Sets up database tables for a class with caching to prevent duplicate operations
 *
 * Creates the database table, indexes, and triggers for a SMRT class.
 * Uses promise caching to ensure each table is only set up once.
 * Now leverages ObjectRegistry's cached schema for instant retrieval.
 *
 * @param db - Database connection interface
 * @param ClassType - Class constructor to create tables for
 * @returns Promise that resolves when setup is complete
 * @throws {Error} If schema creation or trigger setup fails
 */
export async function setupTableFromClass(db: any, ClassType: any) {
  const className = ClassType.name;
  const tableName = className
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/([^s])$/, '$1s')
    .replace(/y$/, 'ies');

  if (
    _setupTableFromClassPromises[tableName] !== undefined &&
    _setupTableFromClassPromises[tableName] !== null
  ) {
    return _setupTableFromClassPromises[tableName];
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
          if (field.options?.primaryKey) {
            _primaryKeyColumn = toSnakeCase(key);
            break;
          }
        }
      }

      await syncSchema({ db, schema });
    } catch (error) {
      // CRITICAL: Clear cache BEFORE throwing to prevent race condition
      // This ensures concurrent callers don't get a stale reference
      _setupTableFromClassPromises[tableName] = null;
      throw error;
    }
  })();

  // Store the promise in cache AFTER creating it
  _setupTableFromClassPromises[tableName] = setupPromise;

  return setupPromise;
}
