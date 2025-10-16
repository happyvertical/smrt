const VALID_OPERATORS = {
  "=": "=",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
  "!=": "!=",
  like: "LIKE",
  in: "IN"
};
const buildWhere = (where, startIndex = 1) => {
  let sql = "";
  const values = [];
  let currIndex = startIndex;
  if (where && Object.keys(where).length > 0) {
    sql = "WHERE ";
    for (const [fullKey, value] of Object.entries(where)) {
      const [field, operator = "="] = fullKey.split(" ");
      const sqlOperator = VALID_OPERATORS[operator] || "=";
      if (sql !== "WHERE ") {
        sql += " AND ";
      }
      if (value === null) {
        sql += `${field} IS ${sqlOperator === "=" ? "NULL" : "NOT NULL"}`;
      } else if (sqlOperator === "IN" && Array.isArray(value)) {
        const placeholders = value.map(() => `$${currIndex++}`).join(", ");
        sql += `${field} IN (${placeholders})`;
        values.push(...value);
      } else {
        sql += `${field} ${sqlOperator} $${currIndex++}`;
        values.push(value);
      }
    }
  }
  return { sql, values };
};
class DatabaseSchemaManager {
  static initializationLock = /* @__PURE__ */ new Map();
  initializedSchemas = /* @__PURE__ */ new Set();
  schemaVersions = /* @__PURE__ */ new Map();
  /**
   * Initialize schemas with dependency resolution
   */
  async initializeSchemas(db, options) {
    const startTime = Date.now();
    const result = {
      initialized: [],
      skipped: [],
      errors: [],
      executionTime: 0
    };
    try {
      let schemas = {};
      if (options.schema) {
        console.log(
          "[schema] Legacy SQL schema provided, converting to manifest format"
        );
        if (db.syncSchema) {
          await db.syncSchema(options.schema);
          result.initialized.push("legacy-sql");
        }
        result.executionTime = Date.now() - startTime;
        return result;
      }
      if (options.manifest) {
        schemas = { ...options.manifest.schemas };
      }
      if (options.overrides) {
        schemas = { ...schemas, ...options.overrides };
      }
      if (Object.keys(schemas).length === 0) {
        console.warn("[schema] No schemas provided for initialization");
        result.executionTime = Date.now() - startTime;
        return result;
      }
      const dependencyGraph = this.buildDependencyGraph(schemas);
      const initializationOrder = this.resolveDependencies(dependencyGraph);
      if (options.debug) {
        console.log("[schema] Initialization order:", initializationOrder);
      }
      for (const schemaName of initializationOrder) {
        const schema = schemas[schemaName];
        if (!schema) continue;
        try {
          await this.initializeSchema(db, schemaName, schema, {
            force: options.force,
            debug: options.debug
          });
          result.initialized.push(schemaName);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          result.errors.push({ schema: schemaName, error: errorMessage });
          if (options.debug) {
            console.error(
              `[schema] Failed to initialize ${schemaName}:`,
              error
            );
          }
        }
      }
      result.executionTime = Date.now() - startTime;
      if (options.debug) {
        console.log("[schema] Initialization complete:", result);
      }
      return result;
    } catch (error) {
      result.executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push({
        schema: "dependency-resolution",
        error: errorMessage
      });
      return result;
    }
  }
  /**
   * Initialize a single schema
   */
  async initializeSchema(db, schemaName, schema, options) {
    const { tableName, version } = schema;
    const lockKey = `${schemaName}:${tableName}`;
    if (DatabaseSchemaManager.initializationLock.has(lockKey)) {
      await DatabaseSchemaManager.initializationLock.get(lockKey);
      return;
    }
    if (!options.force && this.isSchemaUpToDate(schemaName, version)) {
      if (options.debug) {
        console.log(`[schema] Skipping ${schemaName} - already up to date`);
      }
      return;
    }
    const initPromise = this.performSchemaInitialization(
      db,
      schemaName,
      schema,
      options
    );
    DatabaseSchemaManager.initializationLock.set(lockKey, initPromise);
    try {
      await initPromise;
      this.markSchemaInitialized(schemaName, version);
    } finally {
      DatabaseSchemaManager.initializationLock.delete(lockKey);
    }
  }
  /**
   * Perform the actual schema initialization
   */
  async performSchemaInitialization(db, schemaName, schema, options) {
    const { tableName, columns, indexes, triggers } = schema;
    if (options.debug) {
      console.log(`[schema] Initializing ${schemaName} (${tableName})`);
    }
    const tableExists2 = await db.tableExists(tableName);
    if (!tableExists2) {
      await this.createTable(db, schema);
      for (const index2 of indexes) {
        await this.createIndex(db, tableName, index2);
      }
      for (const trigger of triggers) {
        await this.createTrigger(db, trigger);
      }
    } else if (options.force) {
      await db.query(`DROP TABLE IF EXISTS ${tableName}`);
      await this.createTable(db, schema);
      for (const index2 of indexes) {
        await this.createIndex(db, tableName, index2);
      }
      for (const trigger of triggers) {
        await this.createTrigger(db, trigger);
      }
    } else {
      await this.updateSchemaIfNeeded(db, schema);
    }
  }
  /**
   * Create table from schema definition
   */
  async createTable(db, schema) {
    const { tableName, columns, foreignKeys } = schema;
    const columnDefinitions = [];
    for (const [columnName, columnDef] of Object.entries(columns)) {
      let def = `${columnName} ${columnDef.type}`;
      if (columnDef.primaryKey) def += " PRIMARY KEY";
      if (columnDef.unique && !columnDef.primaryKey) def += " UNIQUE";
      if (columnDef.notNull) def += " NOT NULL";
      if (columnDef.defaultValue !== void 0) {
        def += ` DEFAULT ${columnDef.defaultValue}`;
      }
      if (columnDef.check) def += ` CHECK (${columnDef.check})`;
      columnDefinitions.push(def);
    }
    for (const fk of foreignKeys) {
      let fkDef = `FOREIGN KEY (${fk.column}) REFERENCES ${fk.referencesTable}(${fk.referencesColumn})`;
      if (fk.onDelete) fkDef += ` ON DELETE ${fk.onDelete}`;
      if (fk.onUpdate) fkDef += ` ON UPDATE ${fk.onUpdate}`;
      columnDefinitions.push(fkDef);
    }
    const createTableSQL = `CREATE TABLE ${tableName} (
  ${columnDefinitions.join(",\n  ")}
)`;
    await db.query(createTableSQL);
  }
  /**
   * Create index from definition
   */
  async createIndex(db, tableName, index2) {
    const uniqueClause = index2.unique ? "UNIQUE " : "";
    const whereClause = index2.where ? ` WHERE ${index2.where}` : "";
    const createIndexSQL = `CREATE ${uniqueClause}INDEX ${index2.name} ON ${tableName} (${index2.columns.join(", ")})${whereClause}`;
    await db.query(createIndexSQL);
  }
  /**
   * Create trigger from definition
   */
  async createTrigger(db, trigger) {
    const conditionClause = trigger.condition ? ` WHEN ${trigger.condition}` : "";
    const createTriggerSQL = `CREATE TRIGGER ${trigger.name} ${trigger.when} ${trigger.event} ON ${trigger.table}${conditionClause} BEGIN ${trigger.body} END`;
    await db.query(createTriggerSQL);
  }
  /**
   * Update schema if changes are detected
   */
  async updateSchemaIfNeeded(db, schema) {
    console.log(
      `[schema] Schema update logic not yet implemented for ${schema.tableName}`
    );
  }
  /**
   * Build dependency graph from schemas
   */
  buildDependencyGraph(schemas) {
    const graph = /* @__PURE__ */ new Map();
    for (const [schemaName, schema] of Object.entries(schemas)) {
      const dependencies = schema.dependencies.filter(
        (dep) => Object.values(schemas).some((s) => s.tableName === dep)
      );
      graph.set(
        schemaName,
        dependencies.map(
          (dep) => Object.entries(schemas).find(
            ([_, s]) => s.tableName === dep
          )?.[0] || dep
        )
      );
    }
    return graph;
  }
  /**
   * Resolve dependencies using topological sort
   */
  resolveDependencies(graph) {
    const resolved = [];
    const visited = /* @__PURE__ */ new Set();
    const visiting = /* @__PURE__ */ new Set();
    const visit = (node) => {
      if (visiting.has(node)) {
        throw new Error(`Circular dependency detected involving ${node}`);
      }
      if (visited.has(node)) return;
      visiting.add(node);
      const dependencies = graph.get(node) || [];
      for (const dep of dependencies) {
        if (graph.has(dep)) {
          visit(dep);
        }
      }
      visiting.delete(node);
      visited.add(node);
      resolved.push(node);
    };
    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        visit(node);
      }
    }
    return resolved;
  }
  /**
   * Check if schema is up to date
   */
  isSchemaUpToDate(schemaName, version) {
    return this.initializedSchemas.has(schemaName) && this.schemaVersions.get(schemaName) === version;
  }
  /**
   * Mark schema as initialized
   */
  markSchemaInitialized(schemaName, version) {
    this.initializedSchemas.add(schemaName);
    this.schemaVersions.set(schemaName, version);
  }
  /**
   * Reset initialization state (for testing)
   */
  reset() {
    this.initializedSchemas.clear();
    this.schemaVersions.clear();
    DatabaseSchemaManager.initializationLock.clear();
  }
}
function isDatabaseInstance(value) {
  return value && typeof value === "object" && typeof value.client !== "undefined" && typeof value.insert === "function" && typeof value.get === "function" && typeof value.query === "function";
}
async function getDatabase(options = {}) {
  if (isDatabaseInstance(options)) {
    return options;
  }
  if (!options.type && (options.url?.startsWith("file:") || options.url === ":memory:")) {
    options.type = "sqlite";
  }
  if (options.type === "postgres") {
    const postgres = await import("./chunks/postgres-B7IAgBFj.js");
    return postgres.getDatabase(options);
  }
  if (options.type === "sqlite") {
    const sqlite = await import("./chunks/sqlite-BJQU7fQj.js");
    return sqlite.getDatabase(options);
  }
  if (options.type === "duckdb") {
    const duckdb = await import("./chunks/duckdb-C5s83PXT.js");
    return duckdb.getDatabase(options);
  }
  if (options.type === "json") {
    const json = await import("./chunks/json-DY66pnr2.js");
    return json.getDatabase(options);
  }
  throw new Error("Invalid database type");
}
async function syncSchema(options) {
  const { db, schema } = options;
  if (!db || !schema) {
    throw new Error("db and schema are required");
  }
  if (db.syncSchema) {
    await db.syncSchema(schema);
  } else {
    throw new Error("Database adapter does not support schema synchronization");
  }
}
async function tableExists(db, tableName) {
  return db.tableExists(tableName);
}
function escapeSqlValue(value) {
  if (value === null) {
    return "NULL";
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}
function validateColumnName(column) {
  if (!/^[a-zA-Z0-9_.]+$/.test(column)) {
    throw new Error(`Invalid column name: ${column}`);
  }
  return column;
}
const index = { getDatabase, syncSchema, tableExists, buildWhere };
export {
  DatabaseSchemaManager,
  buildWhere,
  index as default,
  escapeSqlValue,
  getDatabase,
  syncSchema,
  tableExists,
  validateColumnName
};
//# sourceMappingURL=index.js.map
