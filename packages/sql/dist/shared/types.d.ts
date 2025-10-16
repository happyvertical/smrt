/**
 * Common database connection options
 */
export interface DatabaseOptions {
    /**
     * Database connection URL
     */
    url?: string;
    /**
     * Authentication token for the database connection
     */
    authToken?: string;
}
/**
 * DuckDB-specific connection options
 */
export interface DuckDBOptions extends DatabaseOptions {
    /**
     * Database type identifier
     */
    type?: 'duckdb';
    /**
     * Path to directory containing JSON files to auto-register as tables
     * @default './data'
     */
    dataDir?: string;
    /**
     * Automatically register JSON files in dataDir as queryable tables
     * @default true
     */
    autoRegisterJSON?: boolean;
    /**
     * Strategy for writing data back to JSON files
     * - 'immediate': Write changes to JSON files immediately
     * - 'manual': Require explicit export calls
     * - 'none': Read-only mode, no writes to JSON files
     * @default 'none'
     */
    writeStrategy?: 'immediate' | 'manual' | 'none';
    /**
     * Whether to use a persistent DuckDB file for caching/indexes
     * If true, uses url or defaults to ':memory:'
     * @default false
     */
    persistent?: boolean;
}
/**
 * JSON database adapter options (DuckDB-backed)
 *
 * Uses DuckDB's in-memory engine to query JSON files directly.
 * No WAL files or persistent database files are created.
 */
export interface JSONOptions {
    /**
     * Database type identifier
     */
    type: 'json';
    /**
     * Path to directory containing JSON files (required)
     * JSON files in this directory will be loaded as queryable tables
     */
    dataDir: string;
    /**
     * Automatically load all JSON files in dataDir as tables
     * @default true
     */
    autoRegister?: boolean;
    /**
     * Strategy for writing changes back to JSON files
     * - 'immediate': Auto-save after every insert/update (default)
     * - 'manual': Require explicit exportTable() calls
     * - 'none': Read-only mode, throws error on writes
     * @default 'immediate'
     */
    writeStrategy?: 'immediate' | 'manual' | 'none';
    /**
     * Skip auto-registration for tables that match SMRT object schemas
     * When true, tables with SMRT schemas will be skipped during autoRegister,
     * allowing SMRT framework to create them with proper types first.
     * @default false
     */
    skipSmrtTables?: boolean;
}
/**
 * Result of a database operation that modifies data
 */
export interface QueryResult {
    /**
     * Type of operation performed (e.g., "insert", "update", "delete")
     */
    operation: string;
    /**
     * Number of rows affected by the operation
     */
    affected: number;
}
/**
 * Schema manifest structure for JSON-based schema management
 */
export interface SchemaManifest {
    version: string;
    timestamp: number;
    packageName: string;
    schemas: Record<string, SchemaDefinition>;
    dependencies: string[];
}
/**
 * Schema definition for individual tables
 */
export interface SchemaDefinition {
    tableName: string;
    columns: Record<string, ColumnDefinition>;
    indexes: IndexDefinition[];
    triggers: TriggerDefinition[];
    foreignKeys: ForeignKeyDefinition[];
    dependencies: string[];
    version: string;
    packageName: string;
    baseClass?: string;
}
/**
 * Column definition structure
 */
export interface ColumnDefinition {
    type: string;
    primaryKey?: boolean;
    unique?: boolean;
    notNull?: boolean;
    defaultValue?: any;
    check?: string;
    foreignKey?: {
        table: string;
        column: string;
        onDelete?: string;
        onUpdate?: string;
    };
    description?: string;
}
/**
 * Index definition structure
 */
export interface IndexDefinition {
    name: string;
    columns: string[];
    unique?: boolean;
    where?: string;
    description?: string;
}
/**
 * Trigger definition structure
 */
export interface TriggerDefinition {
    name: string;
    when: string;
    event: string;
    table: string;
    condition?: string;
    body: string;
    description?: string;
}
/**
 * Foreign key constraint definition
 */
export interface ForeignKeyDefinition {
    column: string;
    referencesTable: string;
    referencesColumn: string;
    onDelete?: string;
    onUpdate?: string;
}
/**
 * Options for schema initialization and management
 */
export interface SchemaInitializationOptions {
    /** Schema manifest containing table definitions */
    manifest?: SchemaManifest;
    /** Raw SQL DDL schema string (legacy support) */
    schema?: string;
    /** Schema overrides for extending base schemas */
    overrides?: Record<string, SchemaDefinition>;
    /** Force recreation of tables */
    force?: boolean;
    /** Enable debug logging */
    debug?: boolean;
}
/**
 * Common interface for database adapters
 * Provides a unified API for different database backends
 */
export interface DatabaseInterface {
    /**
     * Underlying database client instance
     */
    client: any;
    /**
     * Inserts one or more records into a table
     *
     * @param table - Table name
     * @param data - Single record or array of records to insert
     * @returns Promise resolving to operation result
     */
    insert: (table: string, data: Record<string, any> | Record<string, any>[]) => Promise<QueryResult>;
    /**
     * Retrieves a single record matching the where criteria
     *
     * @param table - Table name
     * @param where - Criteria to match records
     * @returns Promise resolving to matching record or null if not found
     */
    get: (table: string, where: Record<string, any>) => Promise<Record<string, any> | null>;
    /**
     * Retrieves multiple records matching the where criteria
     *
     * @param table - Table name
     * @param where - Criteria to match records
     * @returns Promise resolving to array of matching records
     */
    list: (table: string, where: Record<string, any>) => Promise<Record<string, any>[]>;
    /**
     * Updates records matching the where criteria
     *
     * @param table - Table name
     * @param where - Criteria to match records to update
     * @param data - New data to set
     * @returns Promise resolving to operation result
     */
    update: (table: string, where: Record<string, any>, data: Record<string, any>) => Promise<QueryResult>;
    /**
     * Inserts a record or updates it if it already exists (UPSERT)
     * Uses database-specific ON CONFLICT / ON DUPLICATE KEY syntax
     *
     * @param table - Table name
     * @param conflictColumns - Columns that define the uniqueness constraint
     * @param data - Data to insert or update
     * @returns Promise resolving to operation result
     *
     * @example
     * ```typescript
     * // Upsert a user by email
     * await db.upsert('users', ['email'], {
     *   email: 'user@example.com',
     *   name: 'John Doe',
     *   updated_at: new Date().toISOString()
     * });
     *
     * // Upsert with composite key
     * await db.upsert('settings', ['user_id', 'key'], {
     *   user_id: '123',
     *   key: 'theme',
     *   value: 'dark'
     * });
     * ```
     */
    upsert: (table: string, conflictColumns: string[], data: Record<string, any>) => Promise<QueryResult>;
    /**
     * Gets a record matching the where criteria or inserts it if not found
     *
     * @param table - Table name
     * @param where - Criteria to match existing record
     * @param data - Data to insert if no record found
     * @returns Promise resolving to the record (either retrieved or newly inserted)
     */
    getOrInsert: (table: string, where: Record<string, any>, data: Record<string, any>) => Promise<Record<string, any>>;
    /**
     * Creates a table-specific interface for simplified table operations
     *
     * @param table - Table name
     * @returns TableInterface for the specified table
     */
    table: (table: string) => TableInterface;
    /**
     * Checks if a table exists in the database
     *
     * @param table - Table name
     * @returns Promise resolving to boolean indicating existence
     */
    tableExists: (table: string) => Promise<boolean>;
    /**
     * Executes a SQL query using template literals and returns multiple rows
     *
     * @param strings - Template strings
     * @param vars - Variables to interpolate into the query
     * @returns Promise resolving to array of result records
     */
    many: (strings: TemplateStringsArray, ...vars: any[]) => Promise<Record<string, any>[]>;
    /**
     * Executes a SQL query using template literals and returns a single row
     *
     * @param strings - Template strings
     * @param vars - Variables to interpolate into the query
     * @returns Promise resolving to a single result record or null
     */
    single: (strings: TemplateStringsArray, ...vars: any[]) => Promise<Record<string, any> | null>;
    /**
     * Executes a SQL query using template literals and returns a single value
     *
     * @param strings - Template strings
     * @param vars - Variables to interpolate into the query
     * @returns Promise resolving to a single value (first column of first row)
     */
    pluck: (strings: TemplateStringsArray, ...vars: any[]) => Promise<any>;
    /**
     * Executes a SQL query using template literals without returning results
     *
     * @param strings - Template strings
     * @param vars - Variables to interpolate into the query
     * @returns Promise that resolves when the query completes
     */
    execute: (strings: TemplateStringsArray, ...vars: any[]) => Promise<void>;
    /**
     * Alias for many() - Executes a SQL query and returns multiple rows
     */
    oo: (strings: TemplateStringsArray, ...vars: any[]) => Promise<Record<string, any>[]>;
    /**
     * Alias for single() - Executes a SQL query and returns a single row
     */
    oO: (strings: TemplateStringsArray, ...vars: any[]) => Promise<Record<string, any> | null>;
    /**
     * Alias for pluck() - Executes a SQL query and returns a single value
     */
    ox: (strings: TemplateStringsArray, ...vars: any[]) => Promise<any>;
    /**
     * Alias for execute() - Executes a SQL query without returning results
     */
    xx: (strings: TemplateStringsArray, ...vars: any[]) => Promise<void>;
    /**
     * Executes a raw SQL query with parameterized values
     *
     * @param str - SQL query string
     * @param vars - Variables to use as parameters
     * @returns Promise resolving to query result with rows and count
     */
    query: (str: string, ...vars: any[]) => Promise<{
        rows: Record<string, any>[];
        rowCount: number;
    }>;
    /**
     * Synchronizes database schema with provided SQL DDL
     * Creates tables if they don't exist and adds missing columns
     *
     * @param schema - SQL schema definition with CREATE TABLE statements
     * @returns Promise that resolves when schema is synchronized
     */
    syncSchema?: (schema: string) => Promise<void>;
    /**
     * Initialize database schemas from JSON manifest
     * Supports dependency resolution and schema overrides
     *
     * @param options - Schema initialization options
     * @returns Promise that resolves when schemas are initialized
     */
    initializeSchemas?: (options: SchemaInitializationOptions) => Promise<void>;
    /**
     * Executes a callback within a database transaction
     * Automatically commits on success or rolls back on error
     *
     * @param callback - Function to execute within transaction
     * @returns Promise resolving to callback result
     */
    transaction?: <T>(callback: (tx: DatabaseInterface) => Promise<T>) => Promise<T>;
}
/**
 * Simplified interface for table-specific operations
 */
export interface TableInterface {
    /**
     * Inserts one or more records into the table
     *
     * @param data - Single record or array of records to insert
     * @returns Promise resolving to operation result
     */
    insert: (data: Record<string, any> | Record<string, any>[]) => Promise<QueryResult>;
    /**
     * Retrieves a single record from the table matching the where criteria
     *
     * @param where - Criteria to match records
     * @returns Promise resolving to matching record or null if not found
     */
    get: (where: Record<string, any>) => Promise<Record<string, any> | null>;
    /**
     * Retrieves multiple records from the table matching the where criteria
     *
     * @param where - Criteria to match records
     * @returns Promise resolving to array of matching records
     */
    list: (where: Record<string, any>) => Promise<Record<string, any>[]>;
}
//# sourceMappingURL=types.d.ts.map