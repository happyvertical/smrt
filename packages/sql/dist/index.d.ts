import { PostgresOptions } from './postgres';
import { DatabaseInterface, DuckDBOptions, JSONOptions } from './shared/types';
import { SqliteOptions } from './sqlite';
import { buildWhere } from './shared/utils';
/**
 * Union type of options for creating different database types
 */
type GetDatabaseOptions = (PostgresOptions & {
    type?: 'postgres';
}) | (SqliteOptions & {
    type?: 'sqlite';
}) | (DuckDBOptions & {
    type?: 'duckdb';
}) | JSONOptions;
/**
 * Creates a database connection based on the provided options, or returns an existing database instance
 *
 * @param options - Configuration options for the database connection or an existing database instance
 * @returns Promise resolving to a DatabaseInterface implementation
 * @throws Error if the database type is invalid
 */
export declare function getDatabase(options?: GetDatabaseOptions | DatabaseInterface): Promise<DatabaseInterface>;
/**
 * Synchronizes a SQL schema definition with a database
 * Creates tables if they don't exist and adds missing columns to existing tables
 *
 * @param options - Object containing database and schema
 * @param options.db - Database interface to use
 * @param options.schema - SQL schema definition
 * @throws Error if db or schema are missing or if the database doesn't support syncSchema
 */
export declare function syncSchema(options: {
    db: DatabaseInterface;
    schema: string;
}): Promise<void>;
/**
 * Checks if a table exists in the database
 *
 * @param db - Database interface to use
 * @param tableName - Name of the table to check
 * @returns Promise resolving to boolean indicating if the table exists
 */
export declare function tableExists(db: DatabaseInterface, tableName: string): Promise<boolean>;
/**
 * Escapes and formats a value for use in SQL queries
 *
 * @param value - Value to escape
 * @returns String representation of the value safe for SQL use
 */
export declare function escapeSqlValue(value: any): string;
/**
 * Validates a column name for use in SQL queries
 *
 * @param column - Column name to validate
 * @returns The validated column name
 * @throws Error if the column name contains invalid characters
 */
export declare function validateColumnName(column: string): string;
export { buildWhere };
export { DatabaseSchemaManager } from './schema-manager';
export type { SchemaInitializationResult } from './schema-manager';
export * from './shared/types';
declare const _default: {
    getDatabase: typeof getDatabase;
    syncSchema: typeof syncSchema;
    tableExists: typeof tableExists;
    buildWhere: (where: Record<string, any>, startIndex?: number) => {
        sql: string;
        values: any[];
    };
};
export default _default;
//# sourceMappingURL=index.d.ts.map