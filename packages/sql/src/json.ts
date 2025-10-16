import { DatabaseError } from '@have/utils';
import type {
  DatabaseInterface,
  QueryResult,
  TableInterface,
  JSONOptions,
  SchemaInitializationOptions,
} from './shared/types';
import { buildWhere } from './shared/utils';
import { DatabaseSchemaManager } from './schema-manager';
import { readdir, mkdir } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';

/**
 * Schema definition extracted from SMRT ObjectRegistry
 */
interface SmrtSchemaDefinition {
  ddl: string;
  indexes: string[];
  tableName: string;
  fields: Map<string, any>;
}

/**
 * Creates a JSON database connection using DuckDB in-memory engine
 *
 * This adapter uses DuckDB as a query engine for JSON files, storing everything
 * in-memory and writing changes back to JSON files. No WAL files or persistent
 * database files are created.
 *
 * @param options - JSON database options
 * @returns Promise resolving to a DuckDB connection
 */
async function createJSONConnection(options: JSONOptions) {
  const {
    dataDir,
    autoRegister = true,
    skipSmrtTables = false,
  } = options;

  if (!dataDir) {
    throw new DatabaseError('dataDir is required for JSON adapter', {
      options,
    });
  }

  try {
    // Dynamic import to avoid bundling
    const duckdbModule = '@duckdb/node-api';
    const { DuckDBInstance } = await import(/* @vite-ignore */ duckdbModule);

    // Always use in-memory database - no persistent files
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();

    // Ensure data directory exists
    try {
      await mkdir(dataDir, { recursive: true });
    } catch (error) {
      // Directory might already exist, that's okay
    }

    // Load JSON files as in-memory tables
    if (autoRegister) {
      await loadJSONTables(connection, dataDir, skipSmrtTables);
    }

    return connection;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Failed to create JSON database connection: ${errorMessage}`, {
      dataDir,
      originalError: errorMessage,
    });
  }
}

/**
 * Scans the data directory and loads JSON files as queryable in-memory tables
 *
 * Unlike the DuckDB adapter which creates views, this creates actual tables
 * so that indexes can be added.
 *
 * When a JSON file corresponds to a registered SMRT object, it will use the
 * SMRT schema definition to create properly-typed tables instead of relying
 * on DuckDB's auto-detection (which fails with empty strings/null values).
 *
 * @param connection - DuckDB connection
 * @param dataDir - Directory containing JSON files
 * @param skipSmrtTables - If true, skip auto-registration for tables with SMRT schemas (default: false)
 */
async function loadJSONTables(
  connection: any,
  dataDir: string,
  skipSmrtTables = false,
) {
  try {
    const files = await readdir(dataDir);
    const jsonFiles = files.filter((file) =>
      extname(file).toLowerCase() === '.json',
    );

    for (const file of jsonFiles) {
      const filePath = join(dataDir, file);
      const tableName = basename(file, '.json');

      // Check if this table has a SMRT schema definition
      const smrtSchema = await getSmrtSchemaForTable(tableName);

      if (smrtSchema && skipSmrtTables) {
        // Skip SMRT tables - they will be created by SMRT framework
        console.log(
          `[json-adapter] Skipping ${tableName} - will be created by SMRT framework`,
        );
        continue;
      }

      if (smrtSchema) {
        // Create table with SMRT-derived types
        console.log(
          `[json-adapter] Creating ${tableName} with SMRT schema definition`,
        );
        await createTableFromSmrtSchema(connection, tableName, smrtSchema);

        // Load JSON data into properly-typed table
        // IMPORTANT: Don't use read_json() with auto_detect because DuckDB will
        // re-infer types from the data, causing ANY type issues with empty strings.
        // Instead, read JSON file and insert records using our CAST logic.
        try {
          const { readFile } = await import('node:fs/promises');
          const jsonContent = await readFile(filePath, 'utf-8');
          const records = JSON.parse(jsonContent);

          if (Array.isArray(records) && records.length > 0) {
            // Use a helper to insert records with proper CAST handling
            await insertRecordsWithCast(connection, tableName, records);
          }
        } catch (error) {
          // If INSERT fails (e.g., empty file, parse error), that's okay - table structure is what matters
          console.warn(
            `[json-adapter] Could not load data for ${tableName}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } else {
        // Fallback to auto-detection for non-SMRT tables
        await connection.run(
          `CREATE TABLE ${tableName} AS SELECT * FROM read_json('${filePath}', auto_detect=true, format='auto', ignore_errors=true)`,
        );
      }
    }
  } catch (error) {
    // If directory doesn't exist or is empty, that's okay
    if ((error as any).code !== 'ENOENT') {
      throw new DatabaseError(`Failed to load JSON tables from ${dataDir}`, {
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
 * Attempts to get schema definition from SMRT ObjectRegistry for a table
 *
 * @param tableName - Name of the table to look up (snake_case plural form)
 * @returns Schema definition or null if not found in registry
 */
async function getSmrtSchemaForTable(
  tableName: string,
): Promise<SmrtSchemaDefinition | null> {
  try {
    // Try to import ObjectRegistry from @have/smrt
    const smrtPackage = await import('@have/smrt');
    const { ObjectRegistry } = smrtPackage;

    // Get all registered classes
    const allClasses = ObjectRegistry.getAllClasses();

    // Search for a class whose table name matches
    for (const [className, registered] of allClasses) {
      const schema = ObjectRegistry.getSchema(className);

      if (schema && schema.tableName === tableName) {
        return {
          ddl: schema.ddl,
          indexes: schema.indexes,
          tableName: schema.tableName,
          fields: ObjectRegistry.getFields(className),
        };
      }
    }

    return null;
  } catch (error) {
    // @have/smrt not available or ObjectRegistry not initialized
    return null;
  }
}

/**
 * Creates a table from SMRT schema definition with proper typing
 *
 * DuckDB has issues with type inference when DEFAULT values are empty strings.
 * This function explicitly casts all DEFAULT values to their column types to
 * prevent DuckDB from inferring ANY type.
 *
 * @param connection - DuckDB connection
 * @param tableName - Name of the table to create
 * @param schema - Schema definition from SMRT ObjectRegistry
 */
async function createTableFromSmrtSchema(
  connection: any,
  tableName: string,
  schema: SmrtSchemaDefinition,
): Promise<void> {
  // Extract CREATE TABLE statement (without triggers which aren't supported)
  const ddlLines = schema.ddl.split('\n');
  const createTableEnd = ddlLines.findIndex((line) =>
    line.trim().startsWith(');'),
  );

  if (createTableEnd === -1) {
    throw new DatabaseError('Invalid SMRT schema DDL - no closing parenthesis', {
      tableName,
      ddl: schema.ddl,
    });
  }

  // Get CREATE TABLE statement
  let createTableSQL = ddlLines.slice(0, createTableEnd + 1).join('\n');

  // Fix DEFAULT values for DuckDB type inference
  // DuckDB infers ANY type when DEFAULT is an empty string without explicit cast
  // Replace patterns like: DEFAULT '' with DEFAULT CAST('' AS TEXT)
  createTableSQL = createTableSQL.replace(
    /\b(\w+)\s+(TEXT|VARCHAR)\s+DEFAULT\s+''/g,
    "$1 $2 DEFAULT CAST('' AS $2)",
  );

  // Also handle DEFAULT NULL cases to ensure proper typing
  createTableSQL = createTableSQL.replace(
    /\b(\w+)\s+(TEXT|VARCHAR)\s+DEFAULT\s+NULL/g,
    '$1 $2 DEFAULT CAST(NULL AS $2)',
  );

  try {
    await connection.run(createTableSQL);

    // Verify schema was created correctly
    const schemaInfo = await connection.runAndReadAll(
      `PRAGMA table_info(${tableName})`
    );
    const columns = schemaInfo.getRowObjects();

    console.log(`[json-adapter] Created ${tableName} with schema:`, {
      columns: columns.map((col: any) => ({
        name: col.name,
        type: col.type,
        default: col.dflt_value,
        notNull: col.notnull,
        pk: col.pk
      }))
    });

    // Create indexes if defined
    for (const indexSQL of schema.indexes) {
      try {
        await connection.run(indexSQL);
      } catch (error) {
        // Index creation might fail if column doesn't exist or syntax incompatibility
        console.warn(
          `[json-adapter] Failed to create index: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    throw new DatabaseError('Failed to create table from SMRT schema', {
      tableName,
      sql: createTableSQL,
      originalError: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Inserts records with proper CAST handling for empty strings
 *
 * This helper avoids using read_json() with auto_detect, which causes DuckDB
 * to re-infer column types from data (causing ANY type for empty strings).
 * Instead, it uses parameterized INSERT with CAST to maintain table schema.
 *
 * @param connection - DuckDB connection
 * @param tableName - Name of the table to insert into
 * @param records - Array of records to insert
 */
async function insertRecordsWithCast(
  connection: any,
  tableName: string,
  records: Record<string, any>[],
): Promise<void> {
  if (records.length === 0) return;

  const keys = Object.keys(records[0]);

  // Build placeholders - schema has NOT NULL DEFAULT '' to prevent ANY type
  const values: any[] = [];
  let paramIdx = 1;

  const placeholders = records
    .map((record) => {
      const rowPlaceholders = keys.map((key) => {
        const value = record[key];

        if (value === null) {
          return 'NULL';
        } else if (value === '' && typeof value === 'string') {
          // CAST empty strings to TEXT to prevent DuckDB ANY type inference on parameters
          values.push(value);
          return `CAST($${paramIdx++} AS TEXT)`;
        } else if (value instanceof Date) {
          // Convert Date objects to ISO strings for DuckDB
          values.push(value.toISOString());
          return `$${paramIdx++}`;
        } else {
          // Direct parameter binding for other values
          values.push(value);
          return `$${paramIdx++}`;
        }
      });
      return `(${rowPlaceholders.join(', ')})`;
    })
    .join(', ');

  const sql = `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES ${placeholders}`;

  await connection.run(sql, values);
}

/**
 * Checks if a table name corresponds to a registered SMRT object
 *
 * @param tableName - Name of the table to check
 * @returns True if the table matches a SMRT object's table name
 */
async function isSmrtTable(tableName: string): Promise<boolean> {
  const schema = await getSmrtSchemaForTable(tableName);
  return schema !== null;
}

/**
 * Creates a JSON database adapter using DuckDB in-memory engine
 *
 * This adapter provides SQL query capabilities over JSON files without creating
 * persistent database files or WAL files. All data is stored in-memory during
 * runtime and written back to JSON files based on the write strategy.
 *
 * @param options - JSON database options
 * @returns Database interface for JSON files
 */
export async function getDatabase(
  options: JSONOptions,
): Promise<DatabaseInterface> {
  const connection = await createJSONConnection(options);
  const writeStrategy = options.writeStrategy || 'immediate';
  const dataDir = options.dataDir;

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
    // Enforce read-only mode
    if (writeStrategy === 'none') {
      throw new DatabaseError(
        'Cannot insert: write strategy is set to none (read-only mode)',
        { table, writeStrategy }
      );
    }

    const records = Array.isArray(data) ? data : [data];

    if (records.length === 0) {
      return { operation: 'insert', affected: 0 };
    }

    const keys = Object.keys(records[0]);

    // Build placeholders with CAST for empty strings
    const values: any[] = [];
    let paramIdx = 1;

    const placeholders = records
      .map((record) => {
        const rowPlaceholders = keys.map((key) => {
          const value = record[key];

          if (value === null) {
            return 'NULL';
          } else {
            // Direct parameter binding - schema has NOT NULL DEFAULT '' to prevent ANY type
            values.push(value);
            return `$${paramIdx++}`;
          }
        });
        return `(${rowPlaceholders.join(', ')})`;
      })
      .join(', ');

    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES ${placeholders}`;

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
    // Enforce read-only mode
    if (writeStrategy === 'none') {
      throw new DatabaseError(
        'Cannot update: write strategy is set to none (read-only mode)',
        { table, writeStrategy }
      );
    }

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
    // Enforce read-only mode
    if (writeStrategy === 'none') {
      throw new DatabaseError(
        'Cannot upsert: write strategy is set to none (read-only mode)',
        { table, writeStrategy }
      );
    }

    const keys = Object.keys(data);
    const dataValues = Object.values(data);

    // Build placeholders - schema has NOT NULL DEFAULT '' to prevent ANY type
    const placeholders: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const value of dataValues) {
      if (value === null) {
        placeholders.push('NULL');
      } else if (value === '' && typeof value === 'string') {
        // CAST empty strings to TEXT to prevent DuckDB ANY type inference on parameters
        placeholders.push(`CAST($${paramIdx} AS TEXT)`);
        values.push(value);
        paramIdx++;
      } else if (value instanceof Date) {
        // Convert Date objects to ISO strings for DuckDB
        placeholders.push(`$${paramIdx}`);
        values.push(value.toISOString());
        paramIdx++;
      } else {
        // Direct parameter binding for other values
        placeholders.push(`$${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }

    // Build UPDATE SET clause with same approach
    // DO NOT reset paramIdx - parameters must be unique across entire query
    const updateSetParts: string[] = [];

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = dataValues[i];

      if (value === null) {
        updateSetParts.push(`${key} = NULL`);
      } else if (value === '' && typeof value === 'string') {
        // CAST empty strings to TEXT to prevent DuckDB ANY type inference on parameters
        updateSetParts.push(`${key} = CAST($${paramIdx} AS TEXT)`);
        values.push(value);
        paramIdx++;
      } else if (value instanceof Date) {
        // Convert Date objects to ISO strings for DuckDB
        updateSetParts.push(`${key} = $${paramIdx}`);
        values.push(value.toISOString());
        paramIdx++;
      } else {
        // Direct parameter binding for other values
        updateSetParts.push(`${key} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }

    const conflict = conflictColumns.join(', ');
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSetParts.join(', ')}`;

    try {
      await connection.run(sql, values);

      // Handle write-back strategy
      if (writeStrategy === 'immediate') {
        await exportTableToJSON(connection, table, dataDir);
      }

      return { operation: 'upsert', affected: 1 };
    } catch (e) {
      // Log detailed error information for debugging
      console.error('UPSERT failed:', {
        table,
        sql,
        values,
        valueTypes: values.map((v) => `${typeof v} (${v})`),
        conflictColumns,
        error: e instanceof Error ? e.message : String(e),
      });
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
      // Try to query the table
      await connection.runAndReadAll(`SELECT * FROM ${tableName} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Exports a table to a JSON file
   *
   * Overwrites the existing JSON file with the current table contents.
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
   * Allows explicit control over when tables are written back to JSON files.
   *
   * @param table - Table name to export
   * @returns Promise that resolves when export completes
   */
  const exportTable = async (table: string): Promise<void> => {
    if (writeStrategy === 'none') {
      throw new DatabaseError(
        'Cannot export table: write strategy is set to none (read-only mode)',
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
   *
   * Filters out CREATE TRIGGER statements since triggers are not supported
   * in the JSON adapter (timestamps managed at application level).
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
      const trimmedCommand = command.trim().toUpperCase();

      // Skip trigger creation - not supported in JSON adapter
      if (trimmedCommand.startsWith('CREATE TRIGGER')) {
        console.warn('[json-adapter] Skipping trigger creation - timestamps managed at application level');
        continue;
      }

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
    // JSON-specific export method
    exportTable,
  } as DatabaseInterface & { exportTable: (table: string) => Promise<void> };
}
