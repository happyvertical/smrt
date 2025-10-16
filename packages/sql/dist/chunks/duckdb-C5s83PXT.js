import { DatabaseError } from "@have/utils";
import { DatabaseSchemaManager, buildWhere } from "../index.js";
import { readdir } from "node:fs/promises";
import { extname, join, basename } from "node:path";
async function createDuckDBConnection(options) {
  const {
    url = ":memory:",
    dataDir = "./data",
    autoRegisterJSON = true
  } = options;
  try {
    const duckdbModule = "@duckdb/node-api";
    const { DuckDBInstance } = await import(
      /* @vite-ignore */
      duckdbModule
    );
    const instance = await DuckDBInstance.create(url);
    const connection = await instance.connect();
    if (autoRegisterJSON && dataDir) {
      await registerJSONFiles(connection, dataDir);
    }
    return connection;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new DatabaseError(`Failed to create DuckDB connection: ${errorMessage}`, {
      url,
      originalError: errorMessage
    });
  }
}
async function registerJSONFiles(connection, dataDir) {
  try {
    const files = await readdir(dataDir);
    const jsonFiles = files.filter((file) => extname(file).toLowerCase() === ".json");
    for (const file of jsonFiles) {
      const filePath = join(dataDir, file);
      const tableName = basename(file, ".json");
      await connection.run(
        `CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM read_json('${filePath}', auto_detect=true, format='auto')`
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new DatabaseError(`Failed to register JSON files from ${dataDir}`, {
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
async function getDatabase(options = {}) {
  const connection = await createDuckDBConnection(options);
  const writeStrategy = options.writeStrategy || "none";
  const dataDir = options.dataDir || "./data";
  const insert = async (table2, data) => {
    const records = Array.isArray(data) ? data : [data];
    if (records.length === 0) {
      return { operation: "insert", affected: 0 };
    }
    const keys = Object.keys(records[0]);
    const placeholders = records.map((_, idx) => `(${keys.map((__, colIdx) => `$${idx * keys.length + colIdx + 1}`).join(", ")})`).join(", ");
    const sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES ${placeholders}`;
    const values = records.flatMap((record) => Object.values(record));
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
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(", ");
    const updateSet = keys.map((key, idx) => `${key} = $${idx + 1}`).join(", ");
    const conflict = conflictColumns.join(", ");
    const sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSet}`;
    try {
      await connection.run(sql, values);
      if (writeStrategy === "immediate") {
        await exportTableToJSON(connection, table2, dataDir);
      }
      return { operation: "upsert", affected: 1 };
    } catch (e) {
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
        "Cannot export table: write strategy is set to none",
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
    // DuckDB-specific export method
    exportTable
  };
}
export {
  getDatabase
};
//# sourceMappingURL=duckdb-C5s83PXT.js.map
