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
}
export {
  SchemaGenerator
};
//# sourceMappingURL=index-YrRKnEDs.js.map
