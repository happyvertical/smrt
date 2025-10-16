import { DatabaseError } from "@have/utils";
import { DatabaseSchemaManager, buildWhere } from "../index.js";
import { mkdir, readdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";
async function createJSONConnection(options) {
  const {
    dataDir,
    autoRegister = true,
    skipSmrtTables = false
  } = options;
  if (!dataDir) {
    throw new DatabaseError("dataDir is required for JSON adapter", {
      options
    });
  }
  try {
    const duckdbModule = "@duckdb/node-api";
    const { DuckDBInstance } = await import(
      /* @vite-ignore */
      duckdbModule
    );
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await mkdir(dataDir, { recursive: true });
    } catch (error) {
    }
    if (autoRegister) {
      await loadJSONTables(connection, dataDir, skipSmrtTables);
    }
    return connection;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Failed to create JSON database connection: ${errorMessage}`, {
      dataDir,
      originalError: errorMessage
    });
  }
}
async function loadJSONTables(connection, dataDir, skipSmrtTables = false) {
  try {
    const files = await readdir(dataDir);
    const jsonFiles = files.filter(
      (file) => extname(file).toLowerCase() === ".json"
    );
    for (const file of jsonFiles) {
      const filePath = join(dataDir, file);
      const tableName = basename(file, ".json");
      const smrtSchema = await getSmrtSchemaForTable(tableName);
      if (smrtSchema && skipSmrtTables) {
        console.log(
          `[json-adapter] Skipping ${tableName} - will be created by SMRT framework`
        );
        continue;
      }
      if (smrtSchema) {
        console.log(
          `[json-adapter] Creating ${tableName} with SMRT schema definition`
        );
        await createTableFromSmrtSchema(connection, tableName, smrtSchema);
        try {
          const { readFile } = await import("node:fs/promises");
          const jsonContent = await readFile(filePath, "utf-8");
          const records = JSON.parse(jsonContent);
          if (Array.isArray(records) && records.length > 0) {
            await insertRecordsWithCast(connection, tableName, records);
          }
        } catch (error) {
          console.warn(
            `[json-adapter] Could not load data for ${tableName}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else {
        await connection.run(
          `CREATE TABLE ${tableName} AS SELECT * FROM read_json('${filePath}', auto_detect=true, format='auto', ignore_errors=true)`
        );
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new DatabaseError(`Failed to load JSON tables from ${dataDir}`, {
        dataDir,
        originalError: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
function convertBigInts(obj) {
  if (obj === null || obj === void 0) return obj;
  if (typeof obj === "bigint") return Number(obj);
  if (Array.isArray(obj)) return obj.map(convertBigInts);
  if (typeof obj === "object") {
    const result = {};
    for (const key in obj) {
      result[key] = convertBigInts(obj[key]);
    }
    return result;
  }
  return obj;
}
async function getSmrtSchemaForTable(tableName) {
  try {
    const smrtPackage = await import("@have/smrt");
    const { ObjectRegistry } = smrtPackage;
    const allClasses = ObjectRegistry.getAllClasses();
    for (const [className, registered] of allClasses) {
      const schema = ObjectRegistry.getSchema(className);
      if (schema && schema.tableName === tableName) {
        return {
          ddl: schema.ddl,
          indexes: schema.indexes,
          tableName: schema.tableName,
          fields: ObjectRegistry.getFields(className)
        };
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}
async function createTableFromSmrtSchema(connection, tableName, schema) {
  const ddlLines = schema.ddl.split("\n");
  const createTableEnd = ddlLines.findIndex(
    (line) => line.trim().startsWith(");")
  );
  if (createTableEnd === -1) {
    throw new DatabaseError("Invalid SMRT schema DDL - no closing parenthesis", {
      tableName,
      ddl: schema.ddl
    });
  }
  let createTableSQL = ddlLines.slice(0, createTableEnd + 1).join("\n");
  createTableSQL = createTableSQL.replace(
    /\b(\w+)\s+(TEXT|VARCHAR)\s+DEFAULT\s+''/g,
    "$1 $2 DEFAULT CAST('' AS $2)"
  );
  createTableSQL = createTableSQL.replace(
    /\b(\w+)\s+(TEXT|VARCHAR)\s+DEFAULT\s+NULL/g,
    "$1 $2 DEFAULT CAST(NULL AS $2)"
  );
  try {
    await connection.run(createTableSQL);
    const schemaInfo = await connection.runAndReadAll(
      `PRAGMA table_info(${tableName})`
    );
    const columns = schemaInfo.getRowObjects();
    console.log(`[json-adapter] Created ${tableName} with schema:`, {
      columns: columns.map((col) => ({
        name: col.name,
        type: col.type,
        default: col.dflt_value,
        notNull: col.notnull,
        pk: col.pk
      }))
    });
    for (const indexSQL of schema.indexes) {
      try {
        await connection.run(indexSQL);
      } catch (error) {
        console.warn(
          `[json-adapter] Failed to create index: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } catch (error) {
    throw new DatabaseError("Failed to create table from SMRT schema", {
      tableName,
      sql: createTableSQL,
      originalError: error instanceof Error ? error.message : String(error)
    });
  }
}
async function insertRecordsWithCast(connection, tableName, records) {
  if (records.length === 0) return;
  const keys = Object.keys(records[0]);
  const values = [];
  let paramIdx = 1;
  const placeholders = records.map((record) => {
    const rowPlaceholders = keys.map((key) => {
      const value = record[key];
      if (value === null) {
        return "NULL";
      } else if (value === "" && typeof value === "string") {
        values.push(value);
        return `CAST($${paramIdx++} AS TEXT)`;
      } else if (value instanceof Date) {
        values.push(value.toISOString());
        return `$${paramIdx++}`;
      } else {
        values.push(value);
        return `$${paramIdx++}`;
      }
    });
    return `(${rowPlaceholders.join(", ")})`;
  }).join(", ");
  const sql = `INSERT INTO ${tableName} (${keys.join(", ")}) VALUES ${placeholders}`;
  await connection.run(sql, values);
}
async function getDatabase(options) {
  const connection = await createJSONConnection(options);
  const writeStrategy = options.writeStrategy || "immediate";
  const dataDir = options.dataDir;
  const insert = async (table2, data) => {
    if (writeStrategy === "none") {
      throw new DatabaseError(
        "Cannot insert: write strategy is set to none (read-only mode)",
        { table: table2, writeStrategy }
      );
    }
    const records = Array.isArray(data) ? data : [data];
    if (records.length === 0) {
      return { operation: "insert", affected: 0 };
    }
    const keys = Object.keys(records[0]);
    const values = [];
    let paramIdx = 1;
    const placeholders = records.map((record) => {
      const rowPlaceholders = keys.map((key) => {
        const value = record[key];
        if (value === null) {
          return "NULL";
        } else {
          values.push(value);
          return `$${paramIdx++}`;
        }
      });
      return `(${rowPlaceholders.join(", ")})`;
    }).join(", ");
    const sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES ${placeholders}`;
    try {
      await connection.run(sql, values);
      const affected = records.length;
      if (writeStrategy === "immediate") {
        await exportTableToJSON(connection, table2, dataDir);
      }
      return { operation: "insert", affected };
    } catch (e) {
      throw new DatabaseError("Failed to insert records into table", {
        table: table2,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const get = async (table2, where) => {
    const { sql: whereClause, values } = buildWhere(where, 1);
    const sql = `SELECT * FROM ${table2} ${whereClause} LIMIT 1`;
    try {
      const reader = await connection.runAndReadAll(sql, values);
      const rows = reader.getRowObjects();
      return rows.length > 0 ? convertBigInts(rows[0]) : null;
    } catch (e) {
      throw new DatabaseError("Failed to retrieve record from table", {
        table: table2,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const list = async (table2, where) => {
    const { sql: whereClause, values } = buildWhere(where, 1);
    const sql = `SELECT * FROM ${table2} ${whereClause}`;
    try {
      const reader = await connection.runAndReadAll(sql, values);
      return convertBigInts(reader.getRowObjects());
    } catch (e) {
      throw new DatabaseError("Failed to list records from table", {
        table: table2,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const update = async (table2, where, data) => {
    if (writeStrategy === "none") {
      throw new DatabaseError(
        "Cannot update: write strategy is set to none (read-only mode)",
        { table: table2, writeStrategy }
      );
    }
    const keys = Object.keys(data);
    const setClause = keys.map((key, idx) => `${key} = $${idx + 1}`).join(", ");
    const { sql: whereClause, values: whereValues } = buildWhere(where, keys.length + 1);
    const sql = `UPDATE ${table2} SET ${setClause} ${whereClause}`;
    const values = [...Object.values(data), ...whereValues];
    try {
      await connection.run(sql, values);
      if (writeStrategy === "immediate") {
        await exportTableToJSON(connection, table2, dataDir);
      }
      return { operation: "update", affected: 1 };
    } catch (e) {
      throw new DatabaseError("Failed to update records in table", {
        table: table2,
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const upsert = async (table2, conflictColumns, data) => {
    if (writeStrategy === "none") {
      throw new DatabaseError(
        "Cannot upsert: write strategy is set to none (read-only mode)",
        { table: table2, writeStrategy }
      );
    }
    const keys = Object.keys(data);
    const dataValues = Object.values(data);
    const placeholders = [];
    const values = [];
    let paramIdx = 1;
    for (const value of dataValues) {
      if (value === null) {
        placeholders.push("NULL");
      } else if (value === "" && typeof value === "string") {
        placeholders.push(`CAST($${paramIdx} AS TEXT)`);
        values.push(value);
        paramIdx++;
      } else if (value instanceof Date) {
        placeholders.push(`$${paramIdx}`);
        values.push(value.toISOString());
        paramIdx++;
      } else {
        placeholders.push(`$${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }
    const updateSetParts = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = dataValues[i];
      if (value === null) {
        updateSetParts.push(`${key} = NULL`);
      } else if (value === "" && typeof value === "string") {
        updateSetParts.push(`${key} = CAST($${paramIdx} AS TEXT)`);
        values.push(value);
        paramIdx++;
      } else if (value instanceof Date) {
        updateSetParts.push(`${key} = $${paramIdx}`);
        values.push(value.toISOString());
        paramIdx++;
      } else {
        updateSetParts.push(`${key} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }
    const conflict = conflictColumns.join(", ");
    const sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSetParts.join(", ")}`;
    try {
      await connection.run(sql, values);
      if (writeStrategy === "immediate") {
        await exportTableToJSON(connection, table2, dataDir);
      }
      return { operation: "upsert", affected: 1 };
    } catch (e) {
      console.error("UPSERT failed:", {
        table: table2,
        sql,
        values,
        valueTypes: values.map((v) => `${typeof v} (${v})`),
        conflictColumns,
        error: e instanceof Error ? e.message : String(e)
      });
      throw new DatabaseError("Failed to upsert record into table", {
        table: table2,
        sql,
        values,
        conflictColumns,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const getOrInsert = async (table2, where, data) => {
    const result = await get(table2, where);
    if (result) return result;
    await insert(table2, data);
    const inserted = await get(table2, where);
    if (!inserted) {
      throw new DatabaseError("Failed to insert and retrieve record", {
        table: table2,
        where,
        data
      });
    }
    return inserted;
  };
  const tableExists = async (tableName) => {
    try {
      await connection.runAndReadAll(`SELECT * FROM ${tableName} LIMIT 1`);
      return true;
    } catch {
      return false;
    }
  };
  const exportTableToJSON = async (connection2, table2, dataDir2) => {
    const filePath = join(dataDir2, `${table2}.json`);
    await connection2.run(
      `COPY (SELECT * FROM ${table2}) TO '${filePath}' (FORMAT JSON, ARRAY true)`
    );
  };
  const exportTable = async (table2) => {
    if (writeStrategy === "none") {
      throw new DatabaseError(
        "Cannot export table: write strategy is set to none (read-only mode)",
        { table: table2, writeStrategy }
      );
    }
    await exportTableToJSON(connection, table2, dataDir);
  };
  const table = (tableName) => ({
    insert: (data) => insert(tableName, data),
    get: (where) => get(tableName, where),
    list: (where) => list(tableName, where)
  });
  const parseTemplate = (strings, ...vars) => {
    let sql = strings[0];
    const values = [];
    for (let i = 0; i < vars.length; i++) {
      values.push(vars[i]);
      sql += `$${i + 1}${strings[i + 1]}`;
    }
    return { sql, values };
  };
  const many = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const reader = await connection.runAndReadAll(sql, values);
      return convertBigInts(reader.getRowObjects());
    } catch (e) {
      throw new DatabaseError("Failed to execute many query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const single = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const reader = await connection.runAndReadAll(sql, values);
      const rows = reader.getRowObjects();
      return rows[0] ? convertBigInts(rows[0]) : null;
    } catch (e) {
      throw new DatabaseError("Failed to execute single query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const pluck = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const reader = await connection.runAndReadAll(sql, values);
      const rows = reader.getRowObjects();
      if (rows.length === 0) return null;
      const firstRow = rows[0];
      const firstKey = Object.keys(firstRow)[0];
      return convertBigInts(firstRow[firstKey]);
    } catch (e) {
      throw new DatabaseError("Failed to execute pluck query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const execute = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      await connection.run(sql, values);
    } catch (e) {
      throw new DatabaseError("Failed to execute query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const query = async (str, ...values) => {
    const sql = str;
    const args = Array.isArray(values[0]) ? values[0] : values;
    try {
      const reader = await connection.runAndReadAll(sql, args);
      const rows = convertBigInts(reader.getRowObjects());
      return {
        command: sql.split(" ")[0].toUpperCase(),
        rowCount: rows.length,
        oid: null,
        fields: rows.length > 0 ? Object.keys(rows[0]).map((name) => ({
          name,
          tableID: 0,
          columnID: 0,
          dataTypeID: 0,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: "text"
        })) : [],
        rows
      };
    } catch (e) {
      throw new DatabaseError("Failed to execute raw query", {
        sql,
        args,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const oo = many;
  const oO = single;
  const ox = pluck;
  const xx = execute;
  const syncSchema = async (schema) => {
    const commands = schema.trim().split(";").filter((command) => command.trim() !== "");
    for (const command of commands) {
      const trimmedCommand = command.trim().toUpperCase();
      if (trimmedCommand.startsWith("CREATE TRIGGER")) {
        console.warn("[json-adapter] Skipping trigger creation - timestamps managed at application level");
        continue;
      }
      try {
        await connection.run(command);
      } catch (e) {
        console.error("Schema sync error:", e);
      }
    }
  };
  const initializeSchemas = async (options2) => {
    const schemaManager = new DatabaseSchemaManager();
    const currentDb = {
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
      syncSchema
    };
    await schemaManager.initializeSchemas(currentDb, options2);
  };
  const transaction = async (callback) => {
    try {
      await connection.run("BEGIN TRANSACTION");
      const txDb = {
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
        transaction
      };
      const result = await callback(txDb);
      await connection.run("COMMIT");
      return result;
    } catch (error) {
      await connection.run("ROLLBACK");
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
    exportTable
  };
}
export {
  getDatabase
};
//# sourceMappingURL=json-DY66pnr2.js.map
