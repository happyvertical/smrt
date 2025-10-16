import { DatabaseError } from '@have/utils';
import { Pool } from 'pg';
import type {
  QueryResult as BaseQueryResult,
  DatabaseInterface,
  TableInterface,
  SchemaInitializationOptions,
} from './shared/types';
import { buildWhere } from './shared/utils';
import { DatabaseSchemaManager } from './schema-manager';

/**
 * Configuration options for PostgreSQL database connections
 */
export interface PostgresOptions {
  /**
   * Connection URL for PostgreSQL
   */
  url?: string;

  /**
   * Database name
   */
  database?: string;

  /**
   * Database server hostname
   */
  host?: string;

  /**
   * Username for authentication
   */
  user?: string;

  /**
   * Password for authentication
   */
  password?: string;

  /**
   * Port number for the PostgreSQL server
   */
  port?: number;
}

/**
 * Creates a PostgreSQL database adapter
 *
 * @param options - PostgreSQL connection options
 * @returns Database interface for PostgreSQL
 */
export function getDatabase(options: PostgresOptions = {}): DatabaseInterface {
  const {
    url = process.env.SQLOO_URL,
    database = process.env.SQLOO_DATABASE,
    host = process.env.SQLOO_HOST || 'localhost',
    user = process.env.SQLOO_USER,
    password = process.env.SQLOO_PASSWORD,
    port = Number(process.env.SQLOO_PORT) || 5432,
  } = options;

  // Create a connection pool
  const client = new Pool(
    url
      ? { connectionString: url }
      : {
          host,
          user,
          password,
          port,
          database,
        },
  );

  /**
   * Inserts one or more records into a table
   *
   * @param table - Table name
   * @param data - Single record or array of records to insert
   * @returns Promise resolving to operation result
   * @throws Error if the insert operation fails
   *
   * @example Single record insert:
   * ```typescript
   * await db.insert('users', {
   *   name: 'John Doe',
   *   email: 'john@example.com'
   * });
   * ```
   *
   * @example Multiple record insert:
   * ```typescript
   * await db.insert('users', [
   *   { name: 'John', email: 'john@example.com' },
   *   { name: 'Jane', email: 'jane@example.com' }
   * ]);
   * ```
   */
  const insert = async (
    table: string,
    data: Record<string, any> | Record<string, any>[],
  ): Promise<BaseQueryResult> => {
    // If data is an array, we need to handle multiple rows
    if (Array.isArray(data)) {
      const keys = Object.keys(data[0]);
      const placeholders = data
        .map(
          (_, i) =>
            `(${keys.map((_, j) => `$${i * keys.length + j + 1}`).join(', ')})`,
        )
        .join(', ');
      const query = `INSERT INTO ${table} (${keys.join(
        ', ',
      )}) VALUES ${placeholders}`;
      const values = data.reduce(
        (acc, row) => acc.concat(Object.values(row)),
        [],
      );
      const result = await client.query(query, values);
      return { operation: 'insert', affected: result.rowCount ?? 0 };
    }
    // If data is an object, we handle a single row
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const query = `INSERT INTO ${table} (${keys.join(
      ', ',
    )}) VALUES (${placeholders})`;
    const result = await client.query(query, values);
    return { operation: 'insert', affected: result.rowCount ?? 0 };
  };

  /**
   * Retrieves a single record matching the where criteria
   *
   * @param table - Table name
   * @param where - Criteria to match records
   * @returns Promise resolving to query result
   */
  const get = async (
    table: string,
    where: Record<string, any>,
  ): Promise<Record<string, any> | null> => {
    const keys = Object.keys(where);
    const values = Object.values(where);
    const whereClause = keys
      .map((key, i) => `${key} = $${i + 1}`)
      .join(' AND ');
    const query = `SELECT * FROM ${table} WHERE ${whereClause}`;
    try {
      const result = await client.query(query, values);
      return result.rows[0] || null;
    } catch (e) {
      throw new DatabaseError('Failed to retrieve record from table', {
        table,
        sql: query,
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
   * @returns Promise resolving to array of records
   */
  const list = async (
    table: string,
    where: Record<string, any>,
  ): Promise<Record<string, any>[]> => {
    const { sql: whereClause, values } = buildWhere(where, 1);
    const query = `SELECT * FROM ${table} ${whereClause}`;
    try {
      const result = await client.query(query, values);
      return result.rows;
    } catch (e) {
      throw new DatabaseError('Failed to list records from table', {
        table,
        sql: query,
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
   */
  const update = async (
    table: string,
    where: Record<string, any>,
    data: Record<string, any>,
  ): Promise<BaseQueryResult> => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const setClause = keys.map((key, i) => `${key} = $${i + 1}`).join(', ');
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClause = whereKeys
      .map((key, i) => `${key} = $${i + 1 + values.length}`)
      .join(' AND ');

    const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
    try {
      const result = await client.query(sql, [...values, ...whereValues]);
      return { operation: 'update', affected: result.rowCount ?? 0 };
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
  ): Promise<BaseQueryResult> => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const updateSet = keys
      .map((key, i) => `${key} = $${i + 1}`)
      .join(', ');
    const conflict = conflictColumns.join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSet}`;

    try {
      const result = await client.query(sql, values);
      return { operation: 'upsert', affected: result.rowCount ?? 0 };
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
   * @returns Promise resolving to the query result or insert result
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
   * Creates a table-specific interface for simplified table operations
   *
   * @param tableName - Table name
   * @returns TableMethods interface for the specified table
   */
  const table = (tableName: string): TableInterface => {
    return {
      insert: (data) => insert(tableName, data),
      get: (data) => get(tableName, data),
      list: (data) => list(tableName, data),
    };
  };

  /**
   * Template and values extracted from a tagged template literal
   */
  interface SqlTemplate {
    /**
     * SQL query with parameter placeholders
     */
    sql: string;

    /**
     * Values to use as parameters
     */
    values: any[];
  }

  /**
   * Parses a tagged template literal into a SQL query and values
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Object with SQL query and values array
   */
  const parseTemplate = (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): SqlTemplate => {
    let sql = strings[0];
    const values = [];
    for (let i = 0; i < vars.length; i++) {
      values.push(vars[i]);
      sql += `$${i + 1}${strings[i + 1]}`;
    }
    return { sql, values };
  };

  /**
   * Executes a SQL query using template literals and returns a single value
   *
   * @param strings - Template strings
   * @param vars - Variables to interpolate into the query
   * @returns Promise resolving to a single value (first column of first row)
   */
  const pluck = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<any> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.query(sql, values);
      const firstRow = result.rows[0];
      if (!firstRow) return null;
      // Return the first column value from the first row
      return Object.values(firstRow)[0];
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
   */
  const single = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<Record<string, any> | null> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.query(sql, values);
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
   */
  const many = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<Record<string, any>[]> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.query(sql, values);
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
   */
  const execute = async (
    strings: TemplateStringsArray,
    ...vars: any[]
  ): Promise<void> => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      await client.query(sql, values);
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
   * @param sql - SQL query string
   * @param values - Variables to use as parameters
   * @returns Promise resolving to query result with rows and count
   */
  const query = async (
    sql: string,
    ...values: any[]
  ): Promise<{ rows: Record<string, any>[]; rowCount: number }> => {
    try {
      const result = await client.query(sql, values);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
      };
    } catch (e) {
      throw new DatabaseError('Failed to execute raw query', {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e),
      });
    }
  };

  /**
   * Checks if a table exists in the database
   *
   * @param tableName - Name of the table to check
   * @returns Promise resolving to boolean indicating if the table exists
   */
  const tableExists = async (tableName: string): Promise<boolean> => {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1 AND table_schema = 'public')`,
      [tableName],
    );
    return result.rows[0].exists;
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
          await client.query(command);
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
                // Check if column exists
                const columnExists = await client.query(
                  `SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = $1
                    AND column_name = $2
                    AND table_schema = 'public'
                  )`,
                  [tableName, columnName],
                );

                if (!columnExists.rows[0].exists) {
                  // Column doesn't exist, add it
                  const alterCommand = `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`;
                  await client.query(alterCommand);
                }
              } catch (error) {
                // If there's an error checking/adding the column, log it but continue
                console.error(
                  `Error adding column ${columnName} to ${tableName}:`,
                  error,
                );
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
    // Get a client from the pool for the transaction
    const txClient = await client.connect();

    try {
      await txClient.query('BEGIN');

      // Create a transaction-scoped database interface
      const txDb: DatabaseInterface = {
        client: txClient,
        insert: async (table, data) => {
          // Reuse insert logic but with transaction client
          if (Array.isArray(data)) {
            const keys = Object.keys(data[0]);
            const placeholders = data
              .map(
                (_, i) =>
                  `(${keys.map((_, j) => `$${i * keys.length + j + 1}`).join(', ')})`,
              )
              .join(', ');
            const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES ${placeholders}`;
            const values = data.reduce(
              (acc, row) => acc.concat(Object.values(row)),
              [] as any[],
            );
            const result = await txClient.query(query, values);
            return { operation: 'insert', affected: result.rowCount ?? 0 };
          }
          const keys = Object.keys(data);
          const values = Object.values(data);
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
          const query = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
          const result = await txClient.query(query, values);
          return { operation: 'insert', affected: result.rowCount ?? 0 };
        },
        get: async (table, where) => {
          const keys = Object.keys(where);
          const values = Object.values(where);
          const whereClause = keys
            .map((key, i) => `${key} = $${i + 1}`)
            .join(' AND ');
          const query = `SELECT * FROM ${table} WHERE ${whereClause}`;
          const result = await txClient.query(query, values);
          return result.rows[0] || null;
        },
        list: async (table, where) => {
          const { sql: whereClause, values } = buildWhere(where, 1);
          const query = `SELECT * FROM ${table} ${whereClause}`;
          const result = await txClient.query(query, values);
          return result.rows;
        },
        update: async (table, where, data) => {
          const keys = Object.keys(data);
          const values = Object.values(data);
          const setClause = keys
            .map((key, i) => `${key} = $${i + 1}`)
            .join(', ');
          const whereKeys = Object.keys(where);
          const whereValues = Object.values(where);
          const whereClause = whereKeys
            .map((key, i) => `${key} = $${i + 1 + values.length}`)
            .join(' AND ');
          const sql = `UPDATE ${table} SET ${setClause} WHERE ${whereClause}`;
          const result = await txClient.query(sql, [...values, ...whereValues]);
          return { operation: 'update', affected: result.rowCount ?? 0 };
        },
        upsert: async (table, conflictColumns, data) => {
          const keys = Object.keys(data);
          const values = Object.values(data);
          const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
          const updateSet = keys
            .map((key, i) => `${key} = $${i + 1}`)
            .join(', ');
          const conflict = conflictColumns.join(', ');
          const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSet}`;
          const result = await txClient.query(sql, values);
          return { operation: 'upsert', affected: result.rowCount ?? 0 };
        },
        getOrInsert: async (table, where, data) => {
          const result = await txDb.get(table, where);
          if (result) return result;
          await txDb.insert(table, data);
          const inserted = await txDb.get(table, where);
          if (!inserted) {
            throw new DatabaseError('Failed to insert and retrieve record', {
              table,
              where,
              data,
            });
          }
          return inserted;
        },
        table: (tableName) => ({
          insert: (data) => txDb.insert(tableName, data),
          get: (data) => txDb.get(tableName, data),
          list: (data) => txDb.list(tableName, data),
        }),
        many: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          const result = await txClient.query(sql, values);
          return result.rows;
        },
        single: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          const result = await txClient.query(sql, values);
          return result.rows[0] || null;
        },
        pluck: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          const result = await txClient.query(sql, values);
          const firstRow = result.rows[0];
          if (!firstRow) return null;
          return Object.values(firstRow)[0];
        },
        execute: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          await txClient.query(sql, values);
        },
        query: async (sql, ...values) => {
          const result = await txClient.query(sql, values);
          return {
            rows: result.rows,
            rowCount: result.rowCount ?? 0,
          };
        },
        oo: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          const result = await txClient.query(sql, values);
          return result.rows;
        },
        oO: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          const result = await txClient.query(sql, values);
          return result.rows[0] || null;
        },
        ox: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          const result = await txClient.query(sql, values);
          const firstRow = result.rows[0];
          if (!firstRow) return null;
          return Object.values(firstRow)[0];
        },
        xx: async (strings, ...vars) => {
          const { sql, values } = parseTemplate(strings, ...vars);
          await txClient.query(sql, values);
        },
        tableExists,
        syncSchema,
        transaction,
      };

      const result = await callback(txDb);
      await txClient.query('COMMIT');
      return result;
    } catch (error) {
      await txClient.query('ROLLBACK');
      throw error;
    } finally {
      txClient.release();
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
      insert,
      update,
      upsert,
      get,
      getOrInsert,
      list,
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

    await schemaManager.initializeSchemas(currentDb, options);
  };

  return {
    client,
    insert,
    update,
    upsert,
    get,
    getOrInsert,
    list,
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
    initializeSchemas,
    transaction,
  };
}
