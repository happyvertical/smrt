import type { PostgresOptions } from './postgres';
import type { DatabaseInterface, DuckDBOptions, JSONOptions } from './shared/types';
import type { SqliteOptions } from './sqlite';

/**
 * Union type of options for creating different database types
 */
type GetDatabaseOptions =
  | (PostgresOptions & { type?: 'postgres' })
  | (SqliteOptions & { type?: 'sqlite' })
  | (DuckDBOptions & { type?: 'duckdb' })
  | JSONOptions;

/**
 * Checks if the provided value is a database instance rather than configuration options
 *
 * @param value - Value to check
 * @returns True if the value appears to be a DatabaseInterface instance
 */
function isDatabaseInstance(value: any): value is DatabaseInterface {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.client !== 'undefined' &&
    typeof value.insert === 'function' &&
    typeof value.get === 'function' &&
    typeof value.query === 'function'
  );
}

/**
 * Creates a database connection based on the provided options, or returns an existing database instance
 *
 * @param options - Configuration options for the database connection or an existing database instance
 * @returns Promise resolving to a DatabaseInterface implementation
 * @throws Error if the database type is invalid
 */
export async function getDatabase(
  options: GetDatabaseOptions | DatabaseInterface = {},
): Promise<DatabaseInterface> {
  // If a database instance is passed, return it directly
  if (isDatabaseInstance(options)) {
    return options;
  }
  // if no type but url starts with file:, set to sqlite
  if (
    !options.type &&
    (options.url?.startsWith('file:') || options.url === ':memory:')
  ) {
    options.type = 'sqlite';
  }

  if (options.type === 'postgres') {
    const postgres = await import('./postgres.js');
    return postgres.getDatabase(options as PostgresOptions);
  }
  if (options.type === 'sqlite') {
    const sqlite = await import('./sqlite.js');
    return sqlite.getDatabase(options as SqliteOptions);
  }
  if (options.type === 'duckdb') {
    const duckdb = await import('./duckdb.js');
    return duckdb.getDatabase(options as DuckDBOptions);
  }
  if (options.type === 'json') {
    const json = await import('./json.js');
    return json.getDatabase(options as JSONOptions);
  }
  throw new Error('Invalid database type');
}

/**
 * Validates if a table name consists only of alphanumeric characters and underscores
 *
 * @param name - Table name to validate
 * @returns Boolean indicating if the name is valid
 */
function _isValidTableName(name: string): boolean {
  // Simple regex to allow only alphanumeric characters and underscores
  return /^[a-zA-Z0-9_]+$/.test(name);
}

/**
 * Synchronizes a SQL schema definition with a database
 * Creates tables if they don't exist and adds missing columns to existing tables
 *
 * @param options - Object containing database and schema
 * @param options.db - Database interface to use
 * @param options.schema - SQL schema definition
 * @throws Error if db or schema are missing or if the database doesn't support syncSchema
 */
export async function syncSchema(options: {
  db: DatabaseInterface;
  schema: string;
}) {
  const { db, schema } = options;
  if (!db || !schema) {
    throw new Error('db and schema are required');
  }

  // Delegate to the database adapter's syncSchema implementation
  if (db.syncSchema) {
    await db.syncSchema(schema);
  } else {
    throw new Error('Database adapter does not support schema synchronization');
  }
}

/**
 * Checks if a table exists in the database
 *
 * @param db - Database interface to use
 * @param tableName - Name of the table to check
 * @returns Promise resolving to boolean indicating if the table exists
 */
export async function tableExists(db: DatabaseInterface, tableName: string) {
  return db.tableExists(tableName);
}

/**
 * Escapes and formats a value for use in SQL queries
 *
 * @param value - Value to escape
 * @returns String representation of the value safe for SQL use
 */
export function escapeSqlValue(value: any): string {
  if (value === null) {
    return 'NULL';
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (typeof value === 'number') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }
  // Escape single quotes and wrap in quotes
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Validates a column name for use in SQL queries
 *
 * @param column - Column name to validate
 * @returns The validated column name
 * @throws Error if the column name contains invalid characters
 */
export function validateColumnName(column: string): string {
  // Only allow alphanumeric characters, underscores, and dots (for table.column notation)
  if (!/^[a-zA-Z0-9_.]+$/.test(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }
  return column;
}

// Import buildWhere from shared utils
import { buildWhere } from './shared/utils';
export { buildWhere };

// Export schema management
export { DatabaseSchemaManager } from './schema-manager';
export type { SchemaInitializationResult } from './schema-manager';

export * from './shared/types';

export default { getDatabase, syncSchema, tableExists, buildWhere };
