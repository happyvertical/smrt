/**
 * Schema generation utilities - Node.js only
 *
 * These functions use SchemaGenerator which depends on node:crypto.
 * Separated from main utils.ts to prevent bundling in browser builds.
 *
 * SMRT handles ALL database maintenance directly.
 * SDK SQL remains a pure query/CRUD layer.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry.js';
import { tableNameFromClass } from '../utils.js';
import { SchemaManager } from './schema-manager.js';

// Index-rendering helpers live in a separate file to avoid pulling the
// heavyweight registry/collection module graph into the DDL strategies.
export { isJsonPathIndex, renderIndexTarget } from './index-utils.js';

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
  const registeredClass = ObjectRegistry.getClass(className);
  const runtimeSchemaConfig = registeredClass?.config
    ? {
        conflictColumns: registeredClass.config.conflictColumns,
      }
    : undefined;

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
      runtimeSchemaConfig,
    );
  }

  // Store the full schema definition in the registry
  // This is critical for:
  // - STI tables where descendants have additional columns (issue #427)
  // - Per-engine DDL generation via SchemaManager
  if (registeredClass) {
    // Store the full SchemaDefinition for SchemaManager to use
    registeredClass.schema = schemaDefinition;
    // Also store generated DDL for backward compatibility
    registeredClass.schema.ddl = generator.generateSQL(schemaDefinition);
  }

  return generator.generateSQL(schemaDefinition);
}

/**
 * Ensure schema exists for a registered class.
 *
 * This compatibility helper is kept for tooling flows such as CLI commands that
 * explicitly prepare schema ahead of runtime. Core runtime no longer calls this
 * automatically.
 *
 * @deprecated Prefer explicit migration/bootstrap tooling. Runtime verifies
 * schema and fails fast when tables are missing.
 */
export async function ensureSchema(
  db: DatabaseInterface,
  className: string,
): Promise<void> {
  const registered = ObjectRegistry.getClass(className);
  if (!registered) {
    throw new Error(
      `Cannot ensure schema for unregistered class '${className}'. ` +
        `Ensure the class is decorated with @smrt() and registered in the ObjectRegistry.`,
    );
  }

  const tableStrategy = ObjectRegistry.getTableStrategy(className);
  if (tableStrategy === 'sti') {
    const stiBase = ObjectRegistry.getSTIBase(className);
    if (stiBase && stiBase !== className) {
      await ensureSchema(db, stiBase);
      return;
    }
  }

  let schemaDefinition = ObjectRegistry.getSchema(className);
  if (tableStrategy === 'sti') {
    const tableName = ObjectRegistry.getTableName(className);
    if (tableName) {
      const mergedSchema =
        ObjectRegistry.getAllSchemasAsDefinitions()[tableName];
      if (mergedSchema) {
        schemaDefinition = mergedSchema;
      }
    }
  }

  if (!schemaDefinition?.tableName) {
    const providedFields =
      registered.fields.size > 0 ? registered.fields : undefined;
    await generateSchema(registered.constructor, providedFields);
    schemaDefinition = ObjectRegistry.getSchema(className);

    if (tableStrategy === 'sti') {
      const tableName = ObjectRegistry.getTableName(className);
      if (tableName) {
        const mergedSchema =
          ObjectRegistry.getAllSchemasAsDefinitions()[tableName];
        if (mergedSchema) {
          schemaDefinition = mergedSchema;
        }
      }
    }
  }

  if (!schemaDefinition?.tableName) {
    throw new Error(
      `No schema definition found for class '${className}'. ` +
        `Run the manifest generation/build step before preparing schema.`,
    );
  }

  // Use the merged table definition for shared tables (especially STI).
  // Per-class schema metadata can reflect only the current class, while
  // the database table must include columns from all classes sharing it.
  const mergedSchemaDefinition =
    ObjectRegistry.getAllSchemasAsDefinitions()[schemaDefinition.tableName];
  const effectiveSchemaDefinition = mergedSchemaDefinition ?? schemaDefinition;

  const schemaManager = new SchemaManager(db, {
    skipTriggers:
      typeof (db as { exportTable?: unknown }).exportTable === 'function',
  });
  await schemaManager.ensureTable(effectiveSchemaDefinition);
}
