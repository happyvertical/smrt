class Field {
  type;
  options;
  value;
  constructor(type, options = {}) {
    this.type = type;
    this.options = options;
    this.value = options.default;
  }
  /**
   * String coercion - allows Field instances to be used naturally in string contexts
   * @returns String representation of the field's value
   * @example
   * ```typescript
   * const name = text({ default: 'John' });
   * console.log(name.toLowerCase()); // 'john' - toString() called automatically
   * ```
   */
  toString() {
    return this.value?.toString() || "";
  }
  /**
   * Value coercion - returns the actual value for comparisons and operations
   * @returns The field's value
   * @example
   * ```typescript
   * const age = integer({ default: 25 });
   * console.log(age + 5); // 30 - valueOf() called automatically
   * ```
   */
  valueOf() {
    return this.value;
  }
  /**
   * JSON serialization - returns the value for JSON.stringify()
   * @returns The field's value for JSON serialization
   * @example
   * ```typescript
   * const data = { name: text({ default: 'John' }) };
   * JSON.stringify(data); // {"name":"John"} - toJSON() called automatically
   * ```
   */
  toJSON() {
    return this.value;
  }
  /**
   * Get the SQL type for this field based on the field type
   *
   * @returns SQL type string (e.g., 'TEXT', 'INTEGER', 'REAL')
   * @example
   * ```typescript
   * const nameField = text();
   * console.log(nameField.getSqlType()); // 'TEXT'
   * ```
   */
  getSqlType() {
    switch (this.type) {
      case "text":
        return "TEXT";
      case "integer":
        return "INTEGER";
      case "decimal":
        return "REAL";
      case "boolean":
        return "INTEGER";
      case "datetime":
        return "DATETIME";
      case "json":
        return "TEXT";
      case "foreignKey":
        return "TEXT";
      default:
        return "TEXT";
    }
  }
  /**
   * Get field constraints for SQL DDL statements
   *
   * @returns Array of SQL constraint strings (e.g., ['NOT NULL', 'UNIQUE', 'PRIMARY KEY'])
   * @example
   * ```typescript
   * const emailField = text({ required: true, unique: true });
   * console.log(emailField.getSqlConstraints()); // ['NOT NULL', 'UNIQUE']
   *
   * const slugField = text({ primaryKey: true });
   * console.log(slugField.getSqlConstraints()); // ['PRIMARY KEY']
   * ```
   */
  getSqlConstraints() {
    const constraints = [];
    if (this.options.primaryKey) {
      constraints.push("PRIMARY KEY");
      return constraints;
    }
    if (this.options.required) {
      constraints.push("NOT NULL");
    }
    if (this.options.unique) {
      constraints.push("UNIQUE");
    }
    if (this.options.default !== void 0) {
      const sqlType = this.getSqlType();
      const escapedValue = this.escapeSqlValue(this.options.default);
      if (sqlType === "TEXT" && (this.options.default === "" || this.options.default === null)) {
        constraints.push(`DEFAULT CAST(${escapedValue} AS TEXT)`);
      } else {
        constraints.push(`DEFAULT ${escapedValue}`);
      }
    } else if (!this.options.required && this.getSqlType() === "TEXT") {
      constraints.push("NOT NULL DEFAULT ''");
    }
    return constraints;
  }
  /**
   * Escapes a value for safe inclusion in SQL statements
   *
   * @param value - Value to escape
   * @returns Escaped SQL value string
   * @private
   */
  escapeSqlValue(value) {
    if (value === null) return "NULL";
    if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === "boolean") return value ? "1" : "0";
    return String(value);
  }
}
function text(options = {}) {
  return new Field("text", options);
}
function integer(options = {}) {
  return new Field("integer", options);
}
function decimal(options = {}) {
  return new Field("decimal", options);
}
function boolean(options = {}) {
  return new Field("boolean", options);
}
function datetime(options = {}) {
  return new Field("datetime", options);
}
function json(options = {}) {
  return new Field("json", options);
}
function foreignKey(relatedClass, options = {}) {
  let relatedName;
  if (typeof relatedClass === "string") {
    relatedName = relatedClass;
  } else if (typeof relatedClass === "function" && relatedClass.prototype === void 0) {
    const resolvedClass = relatedClass();
    relatedName = resolvedClass.name;
    relatedClass._lazyClass = relatedClass;
  } else {
    relatedName = relatedClass.name;
    if (relatedClass) {
      relatedClass._directClass = relatedClass;
    }
  }
  const field = new Field("foreignKey", {
    ...options,
    related: relatedName
  });
  if (typeof relatedClass !== "string") {
    field.relatedClass = relatedClass;
  }
  return field;
}
function oneToMany(relatedClass, options = {}) {
  let relatedName;
  if (typeof relatedClass === "string") {
    relatedName = relatedClass;
  } else if (typeof relatedClass === "function" && relatedClass.prototype === void 0) {
    const resolvedClass = relatedClass();
    relatedName = resolvedClass.name;
  } else {
    relatedName = relatedClass.name;
  }
  const field = new Field("oneToMany", {
    ...options,
    related: relatedName
  });
  if (typeof relatedClass !== "string") {
    field.relatedClass = relatedClass;
  }
  return field;
}
function manyToMany(relatedClass, options = {}) {
  let relatedName;
  if (typeof relatedClass === "string") {
    relatedName = relatedClass;
  } else if (typeof relatedClass === "function" && relatedClass.prototype === void 0) {
    const resolvedClass = relatedClass();
    relatedName = resolvedClass.name;
  } else {
    relatedName = relatedClass.name;
  }
  const field = new Field("manyToMany", {
    ...options,
    related: relatedName
  });
  if (typeof relatedClass !== "string") {
    field.relatedClass = relatedClass;
  }
  return field;
}
export {
  Field,
  boolean,
  datetime,
  decimal,
  foreignKey,
  integer,
  json,
  manyToMany,
  oneToMany,
  text
};
//# sourceMappingURL=fields.js.map
