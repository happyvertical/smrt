/**
 * SMRT-aware JSON database adapter
 *
 * Wraps the generic JSON adapter with SMRT schema injection.
 * This keeps SMRT-specific code in SMRT, not in the SDK.
 *
 * @module @happyvertical/smrt-core/adapters/json
 */

import type { DatabaseInterface, JSONOptions } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { ObjectRegistry } from '../registry.js';

/**
 * SchemaProvider interface for JSON adapter
 * Matches the generic interface from @happyvertical/sql
 */
export interface SchemaProvider {
  tableName: string;
  ddl: string;
  indexes?: string[];
  triggers?: string[];
  version?: string;
  fields?: Map<string, any>;
}

/**
 * Get a SMRT-aware JSON database connection
 *
 * This function wraps the generic JSON adapter from @happyvertical/sql
 * with automatic SMRT schema injection. It reads schemas from the ObjectRegistry
 * (populated from manifest.json) and passes them to the generic adapter.
 *
 * @param options - JSON database options
 * @returns Database interface configured with SMRT schemas
 * @throws Error if any schema is missing pre-generated data (requires package rebuild)
 *
 * @example
 * ```typescript
 * import { getSmrtJSONDatabase } from '@happyvertical/smrt-core/adapters/json';
 *
 * // Automatically injects schemas from ObjectRegistry
 * const db = await getSmrtJSONDatabase({
 *   url: './data',
 *   writeStrategy: 'immediate'
 * });
 *
 * // Use like any other database
 * const records = await db.list('events', { limit: 10 });
 * ```
 */
export async function getSmrtJSONDatabase(
  options: JSONOptions,
): Promise<DatabaseInterface> {
  // Build schemas from ObjectRegistry
  const smrtSchemas: Record<string, SchemaProvider> = {};

  const allClasses = ObjectRegistry.getAllClasses();
  for (const [className] of allClasses) {
    const schema = ObjectRegistry.getSchema(className);
    if (!schema || !schema.tableName) continue;

    // Fail fast if schema is incomplete (no pre-generated data)
    // This forces packages to be rebuilt with the new manifest standard
    if (!schema.ddl || !schema.columns) {
      throw new Error(
        `Schema for class '${className}' (table '${schema.tableName}') is missing pre-generated schema. ` +
          `Rebuild the package with 'smrt scan' to generate schema in manifest.`,
      );
    }

    // Convert columns Record to Map for SDK compatibility
    const fieldsMap = schema.columns
      ? new Map(Object.entries(schema.columns))
      : undefined;

    smrtSchemas[schema.tableName] = {
      tableName: schema.tableName,
      ddl: schema.ddl,
      indexes: schema.indexes,
      fields: fieldsMap,
    };
  }

  // Merge with any explicitly provided schemas (user overrides win)
  const mergedSchemas = { ...smrtSchemas, ...options.schemas };

  // Call generic adapter with schemas injected
  return getDatabase({
    ...options,
    type: 'json',
    schemas: mergedSchemas,
  });
}

/**
 * Re-export generic adapter for non-SMRT use cases
 *
 * If you don't need SMRT schema injection, you can use the generic
 * adapter directly from @happyvertical/sql.
 */
export { getDatabase as getGenericJSONDatabase } from '@happyvertical/sql';
