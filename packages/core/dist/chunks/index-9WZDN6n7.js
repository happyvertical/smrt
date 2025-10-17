import { createHash } from "crypto";
class SchemaGenerator {
  /**
   * Generate schema definition from SMRT object definition
   */
  generateSchema(objectDef) {
    const tableName = this.getTableName(objectDef);
    const columns = this.generateColumns(objectDef.fields);
    const indexes = this.generateIndexes(objectDef, columns);
    const triggers = this.generateTriggers(objectDef, tableName);
    const foreignKeys = this.extractForeignKeys(columns);
    const dependencies = this.extractDependencies(objectDef, foreignKeys);
    const version = this.generateVersion(objectDef);
    return {
      tableName,
      columns,
      indexes,
      triggers,
      foreignKeys,
      dependencies,
      version,
      packageName: this.extractPackageName(objectDef.filePath),
      baseClass: objectDef.extends
    };
  }
  /**
   * Convert field type to SQL data type
   */
  mapFieldTypeToSQL(fieldType) {
    switch (fieldType) {
      case "text":
        return "TEXT";
      case "integer":
        return "INTEGER";
      case "decimal":
        return "REAL";
      case "boolean":
        return "BOOLEAN";
      case "datetime":
        return "DATETIME";
      case "json":
        return "JSON";
      case "foreignKey":
        return "TEXT";
      // Foreign keys are typically TEXT
      default:
        return "TEXT";
    }
  }
  /**
   * Generate column definitions
   */
  generateColumns(fields) {
    const columns = {};
    columns.id = {
      type: "TEXT",
      primaryKey: true,
      notNull: true,
      description: "Primary identifier"
    };
    columns.created_at = {
      type: "DATETIME",
      notNull: true,
      defaultValue: "datetime('now')",
      description: "Creation timestamp"
    };
    columns.updated_at = {
      type: "DATETIME",
      notNull: true,
      defaultValue: "datetime('now')",
      description: "Last update timestamp"
    };
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      if (fieldName === "id" || fieldName === "created_at" || fieldName === "updated_at") {
        continue;
      }
      const column = {
        type: this.mapFieldTypeToSQL(fieldDef.type),
        notNull: fieldDef.required || false,
        description: fieldDef.description
      };
      if (fieldDef.default !== void 0) {
        column.defaultValue = fieldDef.default;
      } else if (!fieldDef.required && this.mapFieldTypeToSQL(fieldDef.type) === "TEXT") {
        column.notNull = true;
        column.defaultValue = "";
      }
      if (fieldDef.type === "foreignKey" && fieldDef.related) {
        const [table, column_name = "id"] = fieldDef.related.split(".");
        column.foreignKey = {
          table,
          column: column_name,
          onDelete: "CASCADE",
          // Default behavior
          onUpdate: "CASCADE"
        };
      }
      if (fieldName === "slug" || fieldName === "email") {
        column.unique = true;
      }
      columns[fieldName] = column;
    }
    return columns;
  }
  /**
   * Generate index definitions
   */
  generateIndexes(objectDef, columns) {
    const indexes = [];
    const tableName = this.getTableName(objectDef);
    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.foreignKey) {
        indexes.push({
          name: `idx_${tableName}_${columnName}`,
          columns: [columnName],
          description: `Index for foreign key ${columnName}`
        });
      }
    }
    indexes.push({
      name: `idx_${tableName}_updated_at`,
      columns: ["updated_at"],
      description: "Index for timestamp queries"
    });
    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.unique && !columnDef.primaryKey) {
        indexes.push({
          name: `idx_${tableName}_${columnName}_unique`,
          columns: [columnName],
          unique: true,
          description: `Unique index for ${columnName}`
        });
      }
    }
    return indexes;
  }
  /**
   * Generate trigger definitions for automatic timestamp updates
   */
  generateTriggers(objectDef, tableName) {
    return [
      {
        name: `trg_${tableName}_updated_at`,
        when: "BEFORE",
        event: "UPDATE",
        body: `UPDATE ${tableName} SET updated_at = datetime('now') WHERE id = NEW.id;`,
        description: "Automatically update updated_at timestamp"
      }
    ];
  }
  /**
   * Extract foreign key definitions
   */
  extractForeignKeys(columns) {
    const foreignKeys = [];
    for (const [columnName, columnDef] of Object.entries(columns)) {
      if (columnDef.foreignKey) {
        foreignKeys.push({
          column: columnName,
          referencesTable: columnDef.foreignKey.table,
          referencesColumn: columnDef.foreignKey.column,
          onDelete: columnDef.foreignKey.onDelete,
          onUpdate: columnDef.foreignKey.onUpdate
        });
      }
    }
    return foreignKeys;
  }
  /**
   * Extract schema dependencies from foreign keys and inheritance
   */
  extractDependencies(objectDef, foreignKeys) {
    const dependencies = /* @__PURE__ */ new Set();
    for (const fk of foreignKeys) {
      dependencies.add(fk.referencesTable);
    }
    if (objectDef.extends && objectDef.extends !== "SmrtObject" && objectDef.extends !== "SmrtCollection") {
      dependencies.add(this.classNameToTableName(objectDef.extends));
    }
    return Array.from(dependencies);
  }
  /**
   * Generate version hash for schema
   */
  generateVersion(objectDef) {
    const content = JSON.stringify({
      className: objectDef.className,
      fields: objectDef.fields,
      extends: objectDef.extends
    });
    return createHash("sha256").update(content).digest("hex").substring(0, 8);
  }
  /**
   * Get table name from object definition
   */
  getTableName(objectDef) {
    return this.classNameToTableName(objectDef.className);
  }
  /**
   * Convert class name to table name (camelCase to snake_case, pluralized)
   */
  classNameToTableName(className) {
    return className.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "").replace(/s$/, "") + "s";
  }
  /**
   * Extract package name from file path
   */
  extractPackageName(filePath) {
    const match = filePath.match(/packages\/([^/]+)/);
    return match ? match[1] : "unknown";
  }
  /**
   * Generate schema definition from ObjectRegistry fields (runtime)
   *
   * This method builds a SchemaDefinition from ObjectRegistry cached fields,
   * enabling schema generation from decorated classes at runtime.
   *
   * @param className - Class name to look up in ObjectRegistry
   * @param tableName - Table name (from SMRT_TABLE_NAME or derived)
   * @param fields - Map of Field definitions from ObjectRegistry
   * @returns Schema definition object
   */
  generateSchemaFromRegistry(className, tableName, fields) {
    const columns = {};
    let hasCustomPK = false;
    for (const [fieldName, field] of fields.entries()) {
      if (field.options?.primaryKey) {
        hasCustomPK = true;
        break;
      }
    }
    if (!hasCustomPK) {
      columns.id = {
        type: "TEXT",
        primaryKey: true,
        notNull: true,
        description: "Primary identifier"
      };
      columns.slug = {
        type: "TEXT",
        notNull: true,
        description: "URL-friendly identifier"
      };
      columns.context = {
        type: "TEXT",
        notNull: true,
        defaultValue: "",
        description: "Context for slug scoping"
      };
    }
    let hasCreatedAt = false;
    let hasUpdatedAt = false;
    for (const [fieldName, field] of fields.entries()) {
      if (!hasCustomPK && (fieldName === "id" || fieldName === "slug" || fieldName === "context")) {
        continue;
      }
      if (fieldName === "created_at" || fieldName === "createdAt") {
        if (hasCreatedAt) continue;
        hasCreatedAt = true;
      }
      if (fieldName === "updated_at" || fieldName === "updatedAt") {
        if (hasUpdatedAt) continue;
        hasUpdatedAt = true;
      }
      const sqlType = field.getSqlType?.() || "TEXT";
      const columnDef = {
        type: sqlType,
        notNull: field.options?.required || false,
        primaryKey: field.options?.primaryKey || false,
        unique: field.options?.unique || false,
        description: field.options?.description
      };
      if (field.options?.default !== void 0) {
        columnDef.defaultValue = field.options.default;
      } else if (!columnDef.notNull && columnDef.type === "TEXT") {
        columnDef.notNull = true;
        columnDef.defaultValue = "";
      }
      if (field.type === "foreignKey") {
        const relatedName = field.options.related;
        const onDeleteAction = field.options.onDelete;
        if (relatedName) {
          columnDef.foreignKey = {
            table: this.classNameToTableName(relatedName),
            column: "id",
            onDelete: onDeleteAction || "CASCADE",
            onUpdate: "CASCADE"
          };
        }
      }
      columns[this.toSnakeCase(fieldName)] = columnDef;
    }
    if (!hasCreatedAt) {
      columns.created_at = {
        type: "DATETIME",
        notNull: false,
        description: "Creation timestamp"
      };
    }
    if (!hasUpdatedAt) {
      columns.updated_at = {
        type: "DATETIME",
        notNull: false,
        description: "Last update timestamp"
      };
    }
    const indexes = [];
    if (!hasCustomPK) {
      indexes.push({
        name: `${tableName}_id_idx`,
        columns: ["id"],
        description: "Primary key index"
      });
      indexes.push({
        name: `${tableName}_slug_context_idx`,
        columns: ["slug", "context"],
        unique: true,
        description: "Unique index for slug and context"
      });
    } else {
      for (const [colName, colDef] of Object.entries(columns)) {
        if (colDef.primaryKey) {
          indexes.push({
            name: `${tableName}_${colName}_idx`,
            columns: [colName],
            description: `Primary key index`
          });
          break;
        }
      }
    }
    for (const [colName, colDef] of Object.entries(columns)) {
      if (colDef.foreignKey) {
        indexes.push({
          name: `idx_${tableName}_${colName}`,
          columns: [colName],
          description: `Foreign key index for ${colName}`
        });
      }
    }
    return {
      tableName,
      columns,
      indexes,
      triggers: [],
      foreignKeys: this.extractForeignKeys(columns),
      dependencies: [],
      version: createHash("sha256").update(JSON.stringify(columns)).digest("hex").substring(0, 8),
      packageName: "runtime",
      baseClass: "SmrtObject"
    };
  }
  /**
   * Convert camelCase to snake_case
   */
  toSnakeCase(str) {
    return str.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
  }
  /**
   * Generate SQL CREATE TABLE statement from schema definition
   *
   * This is the single source of truth for SQL generation, consolidating
   * logic that was previously duplicated across multiple code paths.
   *
   * @param schema - Schema definition object
   * @returns SQL CREATE TABLE statement with indexes
   */
  generateSQL(schema) {
    const { tableName, columns } = schema;
    let sql = `CREATE TABLE IF NOT EXISTS "${tableName}" (
`;
    for (const [columnName, columnDef] of Object.entries(columns)) {
      const parts = [];
      parts.push(`  ${columnName} ${columnDef.type}`);
      if (columnDef.primaryKey) {
        parts.push("PRIMARY KEY");
      }
      if (columnDef.notNull) {
        parts.push("NOT NULL");
      }
      if (columnDef.unique && !columnDef.primaryKey) {
        parts.push("UNIQUE");
      }
      if (columnDef.defaultValue !== void 0) {
        const defaultSQL = this.formatDefaultValue(
          columnDef.defaultValue,
          columnDef.type
        );
        parts.push(`DEFAULT ${defaultSQL}`);
      }
      sql += parts.join(" ") + ",\n";
    }
    sql = sql.slice(0, -2) + "\n);";
    for (const index of schema.indexes) {
      const indexType = index.unique ? "UNIQUE INDEX" : "INDEX";
      const columnList = index.columns.join(", ");
      sql += `
CREATE ${indexType} IF NOT EXISTS ${index.name} ON ${tableName} (${columnList});`;
    }
    return sql;
  }
  /**
   * Format default value for SQL with proper CAST for DuckDB compatibility
   *
   * DuckDB requires explicit CAST for default values to prevent type inference issues.
   *
   * @param value - Default value
   * @param type - Column SQL type
   * @returns Formatted SQL default value expression
   */
  formatDefaultValue(value, type) {
    if (typeof value === "string" && value.includes("(")) {
      return value;
    }
    if (type === "TEXT") {
      const stringValue = String(value);
      return `CAST('${stringValue.replace(/'/g, "''")}' AS TEXT)`;
    }
    if (type === "INTEGER" || type === "REAL") {
      return `CAST(${value} AS ${type})`;
    }
    if (type === "BOOLEAN") {
      return value ? "TRUE" : "FALSE";
    }
    if (type === "DATETIME") {
      if (typeof value === "string") {
        return `CAST('${value}' AS DATETIME)`;
      }
      return "datetime('now')";
    }
    return `'${String(value).replace(/'/g, "''")}'`;
  }
}
export {
  SchemaGenerator
};
//# sourceMappingURL=index-9WZDN6n7.js.map
