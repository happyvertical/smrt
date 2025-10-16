import { DatabaseError } from '@have/utils';
import type { Client } from '@libsql/client';
import type {
  DatabaseInterface,
  QueryResult,
  TableInterface,
  SchemaInitializationOptions,
} from './shared/types';
import { buildWhere } from './shared/utils';
import { DatabaseSchemaManager } from './schema-manager';

/**
 * Creates a LibSQL client using the default client implementation
 * Supports in-memory databases and remote LibSQL URLs
 *
 * @param options - SQLite connection options
 * @returns Promise resolving to a LibSQL client instance
 */
async function createLibSQLClient(options: SqliteOptions): Promise<Client> {
  const { url = ':memory:', authToken, encryptionKey } = options;

  // Normalize URLs: add file:// prefix for local paths
  let libsqlUrl = url;
  if (
    url !== ':memory:' &&
    !url.startsWith('http://') &&
    !url.startsWith('https://') &&
    !url.startsWith('libsql://') &&
    !url.startsWith('file:')
  ) {
    // Local file path - resolve to absolute and add file:// prefix
    const { resolve } = await import('node:path');
    const absolutePath = resolve(url);
    // Use file:// format (file URL scheme with authority component omitted)
    libsqlUrl = `file://${absolutePath}`;
  }

  try {
    // Use explicit external import to avoid bundling
    const libsqlClient = '@libsql/client';
    const { createClient } = await import(/* @vite-ignore */ libsqlClient);
    return createClient({ url: libsqlUrl, authToken, encryptionKey });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Provide helpful error messages for common issues
    if (errorMessage?.includes('URL_SCHEME_NOT_SUPPORTED')) {
      throw new DatabaseError(
        `Unsupported URL scheme. Use ':memory:' for in-memory databases or 'libsql://' for remote LibSQL databases. Original: ${url}, Converted: ${libsqlUrl}`,
        { url: libsqlUrl, originalError: errorMessage },
      );
    }

    // Re-throw other errors with context
    throw new DatabaseError(`Failed to create LibSQL client: ${errorMessage}`, {
      url: libsqlUrl,
      originalError: errorMessage,
    });
  }
}

/**
 * Configuration options for SQLite database connections
 */
export interface SqliteOptions {
  /**
   * Connection URL for SQLite database
   * Supported schemes:
   * - ':memory:' for in-memory databases
   * - 'file:path/to/database.db' for local file databases
   * - 'libsql://...' for remote LibSQL/Turso databases
   */
  url?: string;

  /**
   * Authentication token for Turso/LibSQL remote connections
   */
  authToken?: string;

  /**
   * Encryption key for encrypted SQLite databases (LibSQL feature)
   */
  encryptionKey?: string;
}

/**
 * Creates a SQLite database adapter
 *
 * @param options - SQLite connection options
 * @returns Database interface for SQLite
 */
export async function getDatabase(
  options: SqliteOptions = {},
): Promise<DatabaseInterface> {
  const client = await createLibSQLClient(options);

  /**
   * Inserts one or more records into a table
   *
   * @param table - Table name
   * @param data - Single record or array of records to insert
   * @returns Promise resolving to operation result
   * @throws Error if the insert operation fails
   */
  const insert = async (
    table: string,
    data: Record<string, any> | Record<string, any>[],
  ): Promise<QueryResult> => {
    let sql: string;
    let values: any[];

    if (Array.isArray(data)) {
      const keys = Object.keys(data[0]);
      const placeholders = data
        .map(() => `(${keys.map(() => '?').join(', ')})`)
        .join(', ');
      sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES ${placeholders}`;
      values = data.reduce(
        (acc, row) => acc.concat(Object.values(row)),
        [] as any[],
      );
    } else {
      const keys = Object.keys(data);
      const placeholders = keys.map(() => '?').join(', ');
      sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
      values = Object.values(data);
    }
    try {
      const result = await client.execute({ sql: sql, args: values });
      return { operation: 'insert', affected: result.rowsAffected };
    } catch (e) {
      throw new DatabaseError('Failed to insert records into table', {
        table,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Retrieves a single record matching the where criteria
   *
   * @param table - Table name
   * @param where - Criteria to match records
   * @returns Promise resolving to matching record or null if not found
   * @throws Error if the query fails
   */
  const get = async (
    table: string,
    where: Record<string, any>,
  ): Promise<Record<string, any> | null> => {
    const keys = Object.keys(where);
    const values = Object.values(where);
    const whereClause = keys.map((key) => `${key} = ?`).join(' AND ');
    const sql = `SELECT * FROM ${table} WHERE ${whereClause}`;
    try {
      const result = await client.execute({ sql: sql, args: values });
      return result.rows[0] || null;
    } catch (e) {
      throw new DatabaseError('Failed to retrieve record from table', {
        table,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Retrieves multiple records matching the where criteria
   *
   * @param table - Table name
   * @param where - Criteria to match records
   * @returns Promise resolving to array of matching records
   * @throws Error if the query fails
   */
  const list = async (
    table: string,
    where: Record<string, any>,
  ): Promise<Record<string, any>[]> => {
    const { sql: whereClause, values } = buildWhere(where);
    const sql = `SELECT * FROM ${table} ${whereClause}`;
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows;
    } catch (e) {
      throw new DatabaseError('Failed to list records from table', {
        table,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Updates records matching the where criteria
   *
   * @param table - Table name
   * @param where - Criteria to match records to update
   * @param data - New data to set
   * @returns Promise resolving to operation result
   * @throws Error if the update operation fails
   */
  const update = async (
    table: string,
    where: Record<string, any>,
    data: Record<string, any>,
  ): Promise<QueryResult> => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = keys.map((key) => `${key} = ?`).join(', ');
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClause = whereKeys.map((key) => `${key} = ?`).join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    try {
      const result = await client.execute({
        sql,
        args: [...values, ...whereValues],
      });
      return { operation: 'update', affected: result.rowsAffected };
    } catch (e) {
      throw new DatabaseError('Failed to update records in table', {
        table,
        sql,
        values: [...values, ...whereValues],
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Inserts a record or updates it if it already exists (UPSERT)
   *
   * @param table - Table name
   * @param conflictColumns - Columns that define the uniqueness constraint
   * @param data - Data to insert or update
   * @returns Promise resolving to operation result
   * @throws Error if the upsert operation fails
   */
  const upsert = async (
    table: string,
    conflictColumns: string[],
    data: Record<string, any>,
  ): Promise<QueryResult> => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => '?').join(', ');
    const updateSet = keys
      .map((key) => `${key} = excluded.${key}`)
      .join(', ');
    const conflict = conflictColumns.join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSet}`;

    try {
      const result = await client.execute({ sql, args: values });
      return { operation: 'upsert', affected: result.rowsAffected };
    } catch (e) {
      throw new DatabaseError('Failed to upsert record into table', {
        table,
        sql,
        values,
        conflictColumns,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Gets a record matching the where criteria or inserts it if not found
   *
   * @param table - Table name
   * @param where - Criteria to match existing record
   * @param data - Data to insert if no record found
   * @returns Promise resolving to the record (either retrieved or newly inserted)
   * @throws Error if the operation fails or if the record cannot be retrieved after insert
   */
  const getOrInsert = async (
    table: string,
    where: Record<string, any>,
    data: Record<string, any>,
  ): Promise<Record<string, any>> => {
    const result = await get(table, where);
    if (result) return result;
    await insert(table, data);

    const inserted = await get(table, where);
    if (!inserted) {
      throw new DatabaseError('Failed to insert and retrieve record', {
        table,
        where,
        data,
      });
    }
    return inserted;
  };

  /**
   * Checks if a table exists in the database
   *
   * @param tableName - Name of the table to check
   * @returns Promise resolving to boolean indicating if the table exists
   */
  const tableExists = async (tableName: string): Promise<boolean> => {
    const tableExists =
      !!(await pluck`SELECT name FROM sqlite_master WHERE type='table' AND name=${tableName}`);
    return tableExists;
  };

  /**
   * Synchronizes database schema with provided SQL DDL
   * Creates tables if they don't exist and adds missing columns
   *
   * @param schema - SQL schema definition with CREATE TABLE statements
   * @returns Promise that resolves when schema is synchronized
   */
  const syncSchema = async (schema: string): Promise<void> => {
    const commands = schema
      .trim()
      .split(';')
      .filter((command) => command.trim() !== '');

    for (const command of commands) {
      const createTableRegex =
        /CREATE TABLE (IF NOT EXISTS )?(\w+) \(([\s\S]+)\)/i;
      const match = command.match(createTableRegex);

      if (match) {
        const tableName = match[2];
        const columns = match[3].trim().split(',\n');

        // Check if table exists
        const exists = await tableExists(tableName);

        if (!exists) {
          // Table doesn't exist, create it
          await client.execute({ sql: command });
        } else {
          // Table exists, check for missing columns
          for (const column of columns) {
            const columnDef = column.trim();
            const columnMatch = columnDef.match(/(\w+)\s+(\w+[^,]*)/);

            if (columnMatch) {
              const columnName = columnMatch[1];

              // Skip constraint definitions
              if (
                columnName.toUpperCase() === 'PRIMARY' ||
                columnName.toUpperCase() === 'FOREIGN' ||
                columnName.toUpperCase() === 'UNIQUE' ||
                columnName.toUpperCase() === 'CHECK' ||
                columnName.toUpperCase() === 'CONSTRAINT'
              ) {
                continue;
              }

              try {
                // Check if column exists using pragma_table_info
                const columnInfo = await single`
                  SELECT *
                  FROM pragma_table_info(${tableName})
                  WHERE name = ${columnName}
                `;

                if (!columnInfo) {
                  // Column doesn't exist, add it
                  const alterCommand = `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`;
                  await client.execute({ sql: alterCommand });
                }
              } catch (_error) {
                // If there's an error checking/adding the column, try alternate method
                try {
                  const alterCommand = `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`;
                  await client.execute({ sql: alterCommand });
                } catch (alterError) {
                  // Column might already exist, continue
                  console.error(
                    `Error adding column ${columnName} to ${tableName}:`,
                    alterError,
                  );
                }
              }
            }
          }
        }
      }
    }
  };

  /**
   * Executes a callback within a database transaction
   * Automatically commits on success or rolls back on error
   *
   * @param callback - Function to execute within transaction
   * @returns Promise resolving to callback result
   */
  const transaction = async <T>(
    callback: (tx: DatabaseInterface) => Promise<T>,
  ): Promise<T> => {
    try {
      await client.execute({ sql: 'BEGIN TRANSACTION' });

      // Create a transaction-scoped database interface
      // SQLite doesn't have separate transaction clients, so we reuse the same client
      const txDb: DatabaseInterface = {
        client,
        insert,
        get,
        list,
        update,
        upsert,
        getOrInsert,
        table,
        many,
        single,
        pluck,
        execute,
        query,
        oo: many,
        oO: single,
        ox: pluck,
        xx: execute,
        tableExists,
        syncSchema,
        transaction,
      };

      const result = await callback(txDb);
      await client.execute({ sql: 'COMMIT' });
      return result;
    } catch (error) {
      await client.execute({ sql: 'ROLLBACK' });
      throw error;
    }
  };

  /**
   * Creates a table-specific interface for simplified table operations
   *
   * @param tableName - Table name
   * @returns TableInterface for the specified table
   */
  const table = (tableName: string): TableInterface => ({
    insert: (data) => insert(tableName, data),
    get: (where) => get(tableName, where),
    list: (where) => list(tableName, where),
  });

  /**
   * Parses a tagged template literal into a SQL query and values
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Object with SQL query and values array
   */
  const parseTemplate = (strings: TemplateStringsArray, ...vars: any[]) => {
    let sql = strings[0];
    const values = [];
    for (let i = 0; i < vars.length; i++) {
      values.push(vars[i]);
      sql += `?${strings[i + 1]}`;
    }
    return { sql, values };
  };

  /**
   * Executes a SQL query using template literals and returns a single value
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Promise resolving to a single value (first column of first row)
   * @throws Error if the query fails
   */
  const pluck = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<any> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows[0]?.[Object.keys(result.rows[0])[0]] ?? null;
    } catch (e) {
      throw new DatabaseError('Failed to execute pluck query', {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Executes a SQL query using template literals and returns a single row
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Promise resolving to a single result record or null
   * @throws Error if the query fails
   */
  const single = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<Record<string, any> | null> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows[0] || null;
    } catch (e) {
      throw new DatabaseError('Failed to execute single query', {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Executes a SQL query using template literals and returns multiple rows
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Promise resolving to array of result records
   * @throws Error if the query fails
   */
  const many = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<Record<string, any>[]> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows;
    } catch (e) {
      throw new DatabaseError('Failed to execute many query', {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Executes a SQL query using template literals without returning results
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Promise that resolves when the query completes
   * @throws Error if the query fails
   */
  const execute = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<void> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      await client.execute({ sql, args: values });
    } catch (e) {
      throw new DatabaseError('Failed to execute query', {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Executes a raw SQL query with parameterized values
   *
   * @param str - SQL query string
   * @param values - Variables to use as parameters
   * @returns Promise resolving to query result with rows and metadata
   * @throws Error if the query fails
   */
  const query = async (str: string, ...values: any[]) => {
    const sql = str;
    const args = Array.isArray(values[0]) ? values[0] : values;
    try {
      const result = await client.execute({ sql, args });
      return {
        command: sql.split(' ')[0].toUpperCase(),
        rowCount: result.rowsAffected ?? result.rows.length,
        oid: null,
        fields: Object.keys(result.rows[0] || {}).map((name) => ({
          name,
          tableID: 0,
          columnID: 0,
          dataTypeID: 0,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: 'text',
        })),
        rows: result.rows,
      };
    } catch (e) {
      throw new DatabaseError('Failed to execute raw query', {
        sql,
        args,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Shorthand aliases for query methods
  const oo = many; // (o)bjective-(o)bjects: returns multiple rows
  const oO = single; // (o)bjective-(O)bject: returns a single row
  const ox = pluck; // (o)bjective-(x): returns a single value
  const xx = execute; // (x)ecute-(x)ecute: executes without returning

  /**
   * Initialize database schemas from JSON manifest
   * Supports dependency resolution and schema overrides
   *
   * @param options - Schema initialization options
   * @returns Promise that resolves when schemas are initialized
   */
  const initializeSchemas = async (
    options: SchemaInitializationOptions,
  ): Promise<void> => {
    const schemaManager = new DatabaseSchemaManager();
    const currentDb: DatabaseInterface = {
      client,
      query,
      insert,
      update,
      upsert,
      get,
      list,
      getOrInsert,
      table,
      tableExists,
      many,
      single,
      pluck,
      execute,
      oo,
      oO,
      ox,
      xx,
      syncSchema,
      transaction,
    };

    await schemaManager.initializeSchemas(currentDb, options);
  };

  return {
    client,
    query,
    insert,
    update,
    upsert,
    get,
    list,
    getOrInsert,
    table,
    tableExists,
    many,
    single,
    pluck,
    execute,
    oo,
    oO,
    ox,
    xx,
    syncSchema,
    initializeSchemas,
    transaction,
  };
}
