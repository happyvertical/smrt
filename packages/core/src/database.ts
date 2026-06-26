/**
 * Database configuration and resolution utilities
 *
 * This module provides a unified type for database configuration options
 * and a utility function to resolve any config format to a DatabaseInterface.
 *
 * @module
 */

import type { DatabaseInterface, SchemasOption } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';

/**
 * Unified type for all database configuration formats
 *
 * Supports three formats:
 * - **String**: Connection URL (e.g., 'products.db', ':memory:', 'postgres://...')
 * - **Config object**: Full configuration with type, url, and options
 * - **DatabaseInterface**: Pre-initialized database instance
 *
 * @example
 * ```typescript
 * // String shortcut
 * const config: DatabaseConfig = 'products.db';
 *
 * // Config object
 * const config: DatabaseConfig = {
 *   type: 'sqlite',
 *   url: 'products.db',
 *   authToken: 'token'
 * };
 *
 * // Pre-initialized instance
 * const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
 * const config: DatabaseConfig = db;
 * ```
 */
export type DatabaseConfig =
  | string
  | {
      url?: string;
      type?: 'sqlite' | 'postgres' | 'duckdb' | 'json';
      authToken?: string;
      [key: string]: unknown;
    }
  | DatabaseInterface;

/**
 * Type guard to check if a value is a DatabaseInterface instance
 *
 * @param value - Value to check
 * @returns True if value has query() and close() methods
 *
 * @example
 * ```typescript
 * if (isDatabaseInterface(config)) {
 *   // config is DatabaseInterface
 *   await config.query('SELECT 1');
 * }
 * ```
 */
export function isDatabaseInterface(
  value: unknown,
): value is DatabaseInterface {
  return (
    value !== null &&
    typeof value === 'object' &&
    'query' in value &&
    typeof (value as { query: unknown }).query === 'function'
  );
}

/**
 * Options for resolving a database configuration
 */
export interface ResolveDatabaseOptions {
  /**
   * Cache key for connection pooling.
   * If provided, the same dbid returns the same cached connection.
   */
  dbid?: string;

  /**
   * Optional pre-generated schemas to pass to the database adapter.
   *
   * Intended for explicit tooling and test utilities that bootstrap schema
   * ahead of runtime. Core runtime no longer passes these automatically.
   */
  schemas?: SchemasOption;
}

/**
 * Resolve any DatabaseConfig format to a DatabaseInterface instance
 *
 * This utility function normalizes the three config formats:
 * 1. **String URL**: Passed to getDatabase() with auto-detected type
 * 2. **Config object**: Passed to getDatabase() directly
 * 3. **DatabaseInterface**: Returned as-is
 *
 * @param config - Database configuration in any supported format
 * @param options - Resolution options (dbid for caching, optional explicit schemas)
 * @returns Promise resolving to a DatabaseInterface instance
 *
 * @example
 * ```typescript
 * // String URL
 * const db = await resolveDatabase('products.db');
 *
 * // Config object
 * const db = await resolveDatabase({
 *   type: 'postgres',
 *   url: 'postgres://localhost/mydb'
 * });
 *
 * // Pre-initialized instance (returned as-is)
 * const existingDb = await getDatabase({ url: ':memory:' });
 * const db = await resolveDatabase(existingDb);
 * console.log(db === existingDb); // true
 * ```
 */
export async function resolveDatabase(
  config: DatabaseConfig,
  options: ResolveDatabaseOptions = {},
): Promise<DatabaseInterface> {
  const { dbid, schemas } = options;

  // Already a DatabaseInterface instance - return as-is
  if (isDatabaseInterface(config)) {
    return config;
  }

  // String URL shortcut
  if (typeof config === 'string') {
    const isMemoryDb = config === ':memory:';
    return getDatabase({
      url: config,
      schemas,
      ...(isMemoryDb ? {} : { dbid: dbid ?? `smrt:${config}` }),
    });
  }

  // Config object
  // Only default to :memory: for SQLite (or unspecified type which defaults to SQLite)
  // Other adapters (json, postgres, duckdb) require explicit URLs
  const canUseMemory = !config.type || config.type === 'sqlite';
  const dbUrl = config.url || (canUseMemory ? ':memory:' : '');
  const isMemoryDb = dbUrl === ':memory:';
  // `config` is the loosely-typed config-object variant of `DatabaseConfig`
  // (it carries an open `[key: string]: unknown` index for adapter-specific
  // options). Cast the merged options to `getDatabase`'s own parameter type at
  // this boundary; the adapter validates the concrete shape at runtime.
  return getDatabase({
    ...config,
    url: dbUrl,
    schemas,
    ...(isMemoryDb ? {} : { dbid: dbid ?? `smrt:${dbUrl}` }),
  } as Parameters<typeof getDatabase>[0]);
}
