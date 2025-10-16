import { DatabaseError } from '@have/utils';
import type {
  DatabaseInterface,
  QueryResult,
  TableInterface,
  DuckDBOptions,
  SchemaInitializationOptions,
} from './shared/types';
import { buildWhere } from './shared/utils';
import { DatabaseSchemaManager } from './schema-manager';
import { readdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

/**
 * Creates a DuckDB connection instance
 *
 * @param options - DuckDB connection options
 * @returns Promise resolving to a DuckDB connection
 */
async function createDuckDBConnection(options: DuckDBOptions) {
  const {
    url = ':memory:',
    dataDir = './data',
    autoRegisterJSON = true,
  } = options;

  try {
    // Dynamic import to avoid bundling
    const duckdbModule = '@duckdb/node-api';
    const { DuckDBInstance } = await import(/* @vite-ignore */ duckdbModule);

    // Create DuckDB instance
    const instance = await DuckDBInstance.create(url);
    const connection = await instance.connect();

    // Auto-register JSON files if enabled
    if (autoRegisterJSON && dataDir) {
      await registerJSONFiles(connection, dataDir);
    }

    return connection;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Failed to create DuckDB connection: ${errorMessage}`, {
      url,
      originalError: errorMessage,
    });
  }
}

/**
 * Scans the data directory and registers JSON files as queryable tables
 *
 * @param connection - DuckDB connection
 * @param dataDir - Directory containing JSON files
 */
async function registerJSONFiles(connection: any, dataDir: string) {
  try {
    const files = await readdir(dataDir);
    const jsonFiles = files.filter((file) => extname(file).toLowerCase() === '.json');

    for (const file of jsonFiles) {
      const filePath = join(dataDir, file);
      const tableName = basename(file, '.json');

      // Create view that reads from JSON file
      // DuckDB automatically infers schema
      await connection.run(
        `CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM read_json('${filePath}', auto_detect=true, format='auto')`
      );
    }
  } catch (error) {
    // If directory doesn't exist, that's okay - user might not have JSON files yet
    if ((error as any).code !== 'ENOENT') {
      throw new DatabaseError(`Failed to register JSON files from ${dataDir}`, {
        dataDir,
        originalError: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Converts BigInt values to regular numbers in an object
 *
 * @param obj - Object that may contain BigInt values
 * @returns Object with BigInts converted to numbers
 */
function convertBigInts(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return Number(obj);
  if (Array.isArray(obj)) return obj.map(convertBigInts);
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = convertBigInts(obj[key]);
    }
    return result;
  }
  return obj;
}

/**
 * Creates a DuckDB database adapter
 *
 * @param options - DuckDB connection options
 * @returns Database interface for DuckDB
 */
export async function getDatabase(
  options: DuckDBOptions = {},
): Promise<DatabaseInterface> {
  const connection = await createDuckDBConnection(options);
  const writeStrategy = options.writeStrategy || 'none';
  const dataDir = options.dataDir || './data';

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
    const records = Array.isArray(data) ? data : [data];

    if (records.length === 0) {
      return { operation: 'insert', affected: 0 };
    }

    const keys = Object.keys(records[0]);
    const placeholders = records
      .map((_, idx) => `(${keys.map((__, colIdx) => `$${idx * keys.length + colIdx + 1}`).join(', ')})`)
      .join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES ${placeholders}`;
    const values = records.flatMap((record) => Object.values(record));

    try {
      await connection.run(sql, values);
      const affected = records.length;

      // Handle write-back strategy
      if (writeStrategy === 'immediate') {
        await exportTableToJSON(connection, table, dataDir);
      }

      return { operation: 'insert', affected };
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
    const { sql: whereClause, values } = buildWhere(where, 1);
    const sql = `SELECT * FROM ${table} ${whereClause} LIMIT 1`;

    try {
      const reader = await connection.runAndReadAll(sql, values);
      const rows = reader.getRowObjects();
      return rows.length > 0 ? convertBigInts(rows[0]) : null;
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
    const { sql: whereClause, values } = buildWhere(where, 1);
    const sql = `SELECT * FROM ${table} ${whereClause}`;

    try {
      const reader = await connection.runAndReadAll(sql, values);
      return convertBigInts(reader.getRowObjects());
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
    const setClause = keys.map((key, idx) => `${key} = $${idx + 1}`).join(', ');
    const { sql: whereClause, values: whereValues } = buildWhere(where, keys.length + 1);

    const sql = `UPDATE ${table} SET ${setClause} ${whereClause}`;
    const values = [...Object.values(data), ...whereValues];

    try {
      await connection.run(sql, values);

      // Handle write-back strategy
      if (writeStrategy === 'immediate') {
        await exportTableToJSON(connection, table, dataDir);
      }

      // DuckDB doesn't return rowsAffected in the same way, estimate from where clause
      return { operation: 'update', affected: 1 };
    } catch (e) {
      throw new DatabaseError('Failed to update records in table', {
        table,
        sql,
        values,
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
    const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(', ');
    const updateSet = keys
      .map((key, idx) => `${key} = $${idx + 1}`)
      .join(', ');
    const conflict = conflictColumns.join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSet}`;

    try {
      await connection.run(sql, values);

      // Handle write-back strategy
      if (writeStrategy === 'immediate') {
        await exportTableToJSON(connection, table, dataDir);
      }

      return { operation: 'upsert', affected: 1 };
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
   * @throws Error if the operation fails
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
    try {
      // Try to query the table - simpler and works for both tables and views
      await connection.runAndReadAll(`SELECT * FROM ${tableName} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Exports a table to a JSON file (for write-back strategies)
   *
   * @param connection - DuckDB connection
   * @param table - Table name
   * @param dataDir - Directory to write JSON file
   */
  const exportTableToJSON = async (
    connection: any,
    table: string,
    dataDir: string,
  ): Promise<void> => {
    const filePath = join(dataDir, `${table}.json`);
    await connection.run(
      `COPY (SELECT * FROM ${table}) TO '${filePath}' (FORMAT JSON, ARRAY true)`
    );
  };

  /**
   * Manual export method for 'manual' write strategy
   *
   * @param table - Table name to export
   * @returns Promise that resolves when export completes
   */
  const exportTable = async (table: string): Promise<void> => {
    if (writeStrategy === 'none') {
      throw new DatabaseError(
        'Cannot export table: write strategy is set to none',
        { table, writeStrategy }
      );
    }
    await exportTableToJSON(connection, table, dataDir);
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
      sql += `$${i + 1}${strings[i + 1]}`;
    }
    return { sql, values };
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
      const reader = await connection.runAndReadAll(sql, values);
      return convertBigInts(reader.getRowObjects());
    } catch (e) {
      throw new DatabaseError('Failed to execute many query', {
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
      const reader = await connection.runAndReadAll(sql, values);
      const rows = reader.getRowObjects();
      return rows[0] ? convertBigInts(rows[0]) : null;
    } catch (e) {
      throw new DatabaseError('Failed to execute single query', {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
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
      const reader = await connection.runAndReadAll(sql, values);
      const rows = reader.getRowObjects();
      if (rows.length === 0) return null;
      const firstRow = rows[0];
      const firstKey = Object.keys(firstRow)[0];
      return convertBigInts(firstRow[firstKey]);
    } catch (e) {
      throw new DatabaseError('Failed to execute pluck query', {
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
      await connection.run(sql, values);
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
      const reader = await connection.runAndReadAll(sql, args);
      const rows = convertBigInts(reader.getRowObjects());

      return {
        command: sql.split(' ')[0].toUpperCase(),
        rowCount: rows.length,
        oid: null,
        fields: rows.length > 0
          ? Object.keys(rows[0]).map((name) => ({
              name,
              tableID: 0,
              columnID: 0,
              dataTypeID: 0,
              dataTypeSize: -1,
              dataTypeModifier: -1,
              format: 'text',
            }))
          : [],
        rows,
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
  const xx = execute; // e(x)ecute-e(x)ecute: executes without returning

  /**
   * Synchronizes database schema with provided SQL DDL
   * Note: DuckDB has different schema handling than SQLite
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
      try {
        await connection.run(command);
      } catch (e) {
        // Log but don't fail on schema sync errors
        console.error('Schema sync error:', e);
      }
    }
  };

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
      client: connection,
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
    };

    await schemaManager.initializeSchemas(currentDb, options);
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
      await connection.run('BEGIN TRANSACTION');

      // Create a transaction-scoped database interface
      const txDb: DatabaseInterface = {
        client: connection,
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
        oo,
        oO,
        ox,
        xx,
        tableExists,
        syncSchema,
        transaction,
      };

      const result = await callback(txDb);
      await connection.run('COMMIT');
      return result;
    } catch (error) {
      await connection.run('ROLLBACK');
      throw error;
    }
  };

  return {
    client: connection,
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
    // DuckDB-specific export method
    exportTable,
  } as DatabaseInterface & { exportTable: (table: string) => Promise<void> };
}
