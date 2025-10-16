import { DatabaseError } from "@have/utils";
import { DatabaseSchemaManager, buildWhere } from "../index.js";
async function createLibSQLClient(options) {
  const { url = ":memory:", authToken, encryptionKey } = options;
  let libsqlUrl = url;
  if (url !== ":memory:" && !url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("libsql://") && !url.startsWith("file:")) {
    const { resolve } = await import("node:path");
    const absolutePath = resolve(url);
    libsqlUrl = `file://${absolutePath}`;
  }
  try {
    const libsqlClient = "@libsql/client";
    const { createClient } = await import(
      /* @vite-ignore */
      libsqlClient
    );
    return createClient({ url: libsqlUrl, authToken, encryptionKey });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage?.includes("URL_SCHEME_NOT_SUPPORTED")) {
      throw new DatabaseError(
        `Unsupported URL scheme. Use ':memory:' for in-memory databases or 'libsql://' for remote LibSQL databases. Original: ${url}, Converted: ${libsqlUrl}`,
        { url: libsqlUrl, originalError: errorMessage }
      );
    }
    throw new DatabaseError(`Failed to create LibSQL client: ${errorMessage}`, {
      url: libsqlUrl,
      originalError: errorMessage
    });
  }
}
async function getDatabase(options = {}) {
  const client = await createLibSQLClient(options);
  const insert = async (table2, data) => {
    let sql;
    let values;
    if (Array.isArray(data)) {
      const keys = Object.keys(data[0]);
      const placeholders = data.map(() => `(${keys.map(() => "?").join(", ")})`).join(", ");
      sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES ${placeholders}`;
      values = data.reduce(
        (acc, row) => acc.concat(Object.values(row)),
        []
      );
    } else {
      const keys = Object.keys(data);
      const placeholders = keys.map(() => "?").join(", ");
      sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES (${placeholders})`;
      values = Object.values(data);
    }
    try {
      const result = await client.execute({ sql, args: values });
      return { operation: "insert", affected: result.rowsAffected };
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
    const keys = Object.keys(where);
    const values = Object.values(where);
    const whereClause = keys.map((key) => `${key} = ?`).join(" AND ");
    const sql = `SELECT * FROM ${table2} WHERE ${whereClause}`;
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows[0] || null;
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
    const { sql: whereClause, values } = buildWhere(where);
    const sql = `SELECT * FROM ${table2} ${whereClause}`;
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows;
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
    const values = Object.values(data);
    const setClause = keys.map((key) => `${key} = ?`).join(", ");
    const whereKeys = Object.keys(where);
    const whereValues = Object.values(where);
    const whereClause = whereKeys.map((key) => `${key} = ?`).join(" AND ");
    const sql = `UPDATE ${table2} SET ${setClause} WHERE ${whereClause}`;
    try {
      const result = await client.execute({
        sql,
        args: [...values, ...whereValues]
      });
      return { operation: "update", affected: result.rowsAffected };
    } catch (e) {
      throw new DatabaseError("Failed to update records in table", {
        table: table2,
        sql,
        values: [...values, ...whereValues],
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const upsert = async (table2, conflictColumns, data) => {
    const keys = Object.keys(data);
    const values = Object.values(data);
    const placeholders = keys.map(() => "?").join(", ");
    const updateSet = keys.map((key) => `${key} = excluded.${key}`).join(", ");
    const conflict = conflictColumns.join(", ");
    const sql = `INSERT INTO ${table2} (${keys.join(", ")}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO UPDATE SET ${updateSet}`;
    try {
      const result = await client.execute({ sql, args: values });
      return { operation: "upsert", affected: result.rowsAffected };
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
    const tableExists2 = !!await pluck`SELECT name FROM sqlite_master WHERE type='table' AND name=${tableName}`;
    return tableExists2;
  };
  const syncSchema = async (schema) => {
    const commands = schema.trim().split(";").filter((command) => command.trim() !== "");
    for (const command of commands) {
      const createTableRegex = /CREATE TABLE (IF NOT EXISTS )?(\w+) \(([\s\S]+)\)/i;
      const match = command.match(createTableRegex);
      if (match) {
        const tableName = match[2];
        const columns = match[3].trim().split(",\n");
        const exists = await tableExists(tableName);
        if (!exists) {
          await client.execute({ sql: command });
        } else {
          for (const column of columns) {
            const columnDef = column.trim();
            const columnMatch = columnDef.match(/(\w+)\s+(\w+[^,]*)/);
            if (columnMatch) {
              const columnName = columnMatch[1];
              if (columnName.toUpperCase() === "PRIMARY" || columnName.toUpperCase() === "FOREIGN" || columnName.toUpperCase() === "UNIQUE" || columnName.toUpperCase() === "CHECK" || columnName.toUpperCase() === "CONSTRAINT") {
                continue;
              }
              try {
                const columnInfo = await single`
                  SELECT *
                  FROM pragma_table_info(${tableName})
                  WHERE name = ${columnName}
                `;
                if (!columnInfo) {
                  const alterCommand = `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`;
                  await client.execute({ sql: alterCommand });
                }
              } catch (_error) {
                try {
                  const alterCommand = `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`;
                  await client.execute({ sql: alterCommand });
                } catch (alterError) {
                  console.error(
                    `Error adding column ${columnName} to ${tableName}:`,
                    alterError
                  );
                }
              }
            }
          }
        }
      }
    }
  };
  const transaction = async (callback) => {
    try {
      await client.execute({ sql: "BEGIN TRANSACTION" });
      const txDb = {
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
        transaction
      };
      const result = await callback(txDb);
      await client.execute({ sql: "COMMIT" });
      return result;
    } catch (error) {
      await client.execute({ sql: "ROLLBACK" });
      throw error;
    }
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
      sql += `?${strings[i + 1]}`;
    }
    return { sql, values };
  };
  const pluck = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows[0]?.[Object.keys(result.rows[0])[0]] ?? null;
    } catch (e) {
      throw new DatabaseError("Failed to execute pluck query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const single = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows[0] || null;
    } catch (e) {
      throw new DatabaseError("Failed to execute single query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const many = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      const result = await client.execute({ sql, args: values });
      return result.rows;
    } catch (e) {
      throw new DatabaseError("Failed to execute many query", {
        sql,
        values,
        originalError: e instanceof Error ? e.message : String(e)
      });
    }
  };
  const execute = async (strings, ...vars) => {
    const { sql, values } = parseTemplate(strings, ...vars);
    try {
      await client.execute({ sql, args: values });
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
      const result = await client.execute({ sql, args });
      return {
        command: sql.split(" ")[0].toUpperCase(),
        rowCount: result.rowsAffected ?? result.rows.length,
        oid: null,
        fields: Object.keys(result.rows[0] || {}).map((name) => ({
          name,
          tableID: 0,
          columnID: 0,
          dataTypeID: 0,
          dataTypeSize: -1,
          dataTypeModifier: -1,
          format: "text"
        })),
        rows: result.rows
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
  const initializeSchemas = async (options2) => {
    const schemaManager = new DatabaseSchemaManager();
    const currentDb = {
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
      transaction
    };
    await schemaManager.initializeSchemas(currentDb, options2);
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
    transaction
  };
}
export {
  getDatabase
};
//# sourceMappingURL=sqlite-BJQU7fQj.js.map
