import { staticManifest } from "./static-manifest-BpxVdLxT.js";
import { syncSchema } from "@have/sql";
import { SchemaGenerator } from "./index-NeQe5WqD.js";
function toSnakeCase(str) {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, "");
}
function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}
function keysToSnakeCase(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toSnakeCase(key)] = value;
  }
  return result;
}
function keysToCamelCase(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[toCamelCase(key)] = value;
  }
  return result;
}
function isDateField(key) {
  return key.endsWith("_date") || key.endsWith("_at") || key === "date";
}
function dateAsString(date) {
  if (typeof date === "string") {
    return new Date(date);
  }
  return date;
}
function dateAsObject(date) {
  if (date instanceof Date) {
    return date.toISOString();
  }
  return date;
}
function fieldsFromClass(ClassType, values) {
  const className = ClassType.name;
  const cachedFields = ObjectRegistry.getFields(className);
  if (cachedFields.size === 0) {
    return {};
  }
  const fields = {};
  for (const [key, field] of cachedFields.entries()) {
    fields[key] = {
      name: key,
      type: field.type || "TEXT",
      ...values && key in values ? { value: values[key] } : {}
    };
  }
  return fields;
}
function generateSchema(ClassType, providedFields) {
  const className = ClassType.name;
  const tableName = tableNameFromClass(ClassType);
  const cachedFields = providedFields && providedFields.size > 0 ? providedFields : ObjectRegistry.getFields(className);
  if (cachedFields.size === 0) {
    throw new Error(
      `Cannot generate schema for unregistered class '${className}'. Ensure the class is decorated with @smrt() for schema generation to work. Runtime introspection has been removed in Phase 2 of the schema management refactor.`
    );
  }
  const generator = new SchemaGenerator();
  const schemaDefinition = generator.generateSchemaFromRegistry(
    className,
    tableName,
    cachedFields
  );
  return generator.generateSQL(schemaDefinition);
}
function tableNameFromClass(ClassType) {
  if ("SMRT_TABLE_NAME" in ClassType) {
    return ClassType.SMRT_TABLE_NAME;
  }
  return ClassType.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/([^s])$/, "$1s").replace(/y$/, "ies");
}
function classnameToTablename(className) {
  const tableName = className.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/([^s])$/, "$1s").replace(/y$/, "ies");
  return tableName;
}
const _setupTableFromClassPromises = {};
async function setupTableFromClass(db, ClassType) {
  const tableName = classnameToTablename(ClassType.name);
  if (_setupTableFromClassPromises[tableName] !== void 0 && _setupTableFromClassPromises[tableName] !== null) {
    return _setupTableFromClassPromises[tableName];
  }
  _setupTableFromClassPromises[tableName] = (async () => {
    try {
      const className = ClassType.name;
      const cachedFields = ObjectRegistry.getFields(className);
      const schema = generateSchema(ClassType, cachedFields);
      let _primaryKeyColumn = "id";
      if (cachedFields.size > 0) {
        for (const [key, field] of cachedFields.entries()) {
          if (field.options?.primaryKey) {
            _primaryKeyColumn = toSnakeCase(key);
            break;
          }
        }
      }
      await syncSchema({ db, schema });
    } catch (error) {
      _setupTableFromClassPromises[tableName] = null;
      throw error;
    }
  })();
  return _setupTableFromClassPromises[tableName];
}
function formatDataJs(data) {
  const normalizedData = {};
  for (const [key, value] of Object.entries(data)) {
    const camelKey = toCamelCase(key);
    if (value instanceof Date) {
      normalizedData[camelKey] = value;
    } else if (isDateField(key) && typeof value === "string") {
      normalizedData[camelKey] = new Date(value);
    } else {
      normalizedData[camelKey] = value;
    }
  }
  return normalizedData;
}
function formatDataSql(data) {
  const normalizedData = {};
  for (const [key, value] of Object.entries(data)) {
    const snakeKey = toSnakeCase(key);
    if (value instanceof Date) {
      normalizedData[snakeKey] = value.toISOString();
    } else {
      normalizedData[snakeKey] = value;
    }
  }
  return normalizedData;
}
class ObjectRegistry {
  static classes = /* @__PURE__ */ new Map();
  static collections = /* @__PURE__ */ new Map();
  static collectionCache = /* @__PURE__ */ new Map();
  /**
   * Register a new SMRT object class with the global registry
   *
   * @param constructor - The class constructor extending SmrtObject
   * @param config - Configuration options for API/CLI/MCP generation
   * @throws {Error} If the class cannot be introspected for field definitions
   * @example
   * ```typescript
   * ObjectRegistry.register(Product, {
   *   api: { exclude: ['delete'] },
   *   cli: true,
   *   mcp: { include: ['list', 'get'] }
   * });
   * ```
   */
  static register(ctor, config = {}) {
    const name = config.name || ctor.name;
    if (ObjectRegistry.classes.has(name)) {
      return;
    }
    const manifestEntry = staticManifest.objects[name];
    const fields = /* @__PURE__ */ new Map();
    if (manifestEntry?.fields) {
      for (const [fieldName, fieldDef] of Object.entries(
        manifestEntry.fields
      )) {
        fields.set(fieldName, fieldDef);
      }
    } else {
      try {
        const tempInstance = new ctor({
          db: null,
          ai: null,
          fs: null,
          _skipRegistration: true
        });
        for (const key of Object.getOwnPropertyNames(tempInstance)) {
          if (key.startsWith("_") || key.startsWith("#") || key === "options") {
            continue;
          }
          const value = tempInstance[key];
          if (value && typeof value === "object" && value.type) {
            fields.set(key, value);
          }
        }
        if (fields.size === 0) {
          for (const key of Object.getOwnPropertyNames(tempInstance)) {
            if (key.startsWith("_") || key.startsWith("#") || key === "options") {
              continue;
            }
            const value = tempInstance[key];
            const valueType = typeof value;
            let fieldType = "text";
            if (valueType === "string") fieldType = "text";
            else if (valueType === "number")
              fieldType = Number.isInteger(value) ? "integer" : "decimal";
            else if (valueType === "boolean") fieldType = "boolean";
            else if (value instanceof Date) fieldType = "datetime";
            else if (Array.isArray(value)) fieldType = "json";
            else if (valueType === "object" && value !== null)
              fieldType = "json";
            else continue;
            fields.set(key, {
              type: fieldType,
              options: {}
            });
          }
        }
      } catch (error) {
        console.warn(
          `Warning: Could not extract fields from ${ctor.name}:`,
          error
        );
      }
    }
    const tableName = config.tableName || tableNameFromClass(ctor);
    const schemaDDL = generateSchema(ctor, fields);
    const indexes = [];
    const ddlLines = schemaDDL.split("\n");
    const tableEndIndex = ddlLines.findIndex((line) => line.includes(");"));
    const indexLines = ddlLines.slice(tableEndIndex + 1);
    for (const line of indexLines) {
      if (line.trim().startsWith("CREATE INDEX")) {
        indexes.push(line.trim());
      }
    }
    const schema = {
      ddl: schemaDDL,
      indexes,
      triggers: [],
      // No longer using database triggers - timestamps managed by application
      tableName
    };
    const validators = ObjectRegistry.compileValidators(name, fields);
    ObjectRegistry.classes.set(name, {
      name,
      constructor: ctor,
      config,
      fields,
      schema,
      validators
    });
    console.log(
      `🎯 Registered smrt object: ${name} with schema for ${tableName} and ${validators.length} validators`
    );
  }
  /**
   * Register a collection class for an object
   *
   * @param objectName - Name of the object class this collection manages
   * @param collectionConstructor - The collection class constructor
   * @example
   * ```typescript
   * ObjectRegistry.registerCollection('Product', ProductCollection);
   * ```
   */
  static registerCollection(objectName, collectionConstructor) {
    const registered = ObjectRegistry.classes.get(objectName);
    if (registered) {
      registered.collectionConstructor = collectionConstructor;
    }
    ObjectRegistry.collections.set(objectName, collectionConstructor);
  }
  /**
   * Helper method for case-insensitive class lookup
   * Tries exact match first, then falls back to case-insensitive search
   *
   * @param name - Name of the class to find
   * @returns Registered class information or undefined if not found
   * @private
   */
  static findClass(name) {
    const registered = ObjectRegistry.classes.get(name);
    if (registered) {
      return registered;
    }
    const lowerName = name.toLowerCase();
    for (const [key, value] of ObjectRegistry.classes.entries()) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
    return void 0;
  }
  /**
   * Get a registered class by name (case-insensitive)
   *
   * @param name - Name of the registered class
   * @returns Registered class information or undefined if not found
   * @example
   * ```typescript
   * const productInfo = ObjectRegistry.getClass('Product');
   * // Also works with: 'product', 'PRODUCT', etc.
   * if (productInfo) {
   *   console.log(productInfo.config.api?.exclude);
   * }
   * ```
   */
  static getClass(name) {
    return ObjectRegistry.findClass(name);
  }
  /**
   * Get all registered classes
   *
   * @returns Map of class names to registered class information
   * @example
   * ```typescript
   * const allClasses = ObjectRegistry.getAllClasses();
   * for (const [name, info] of allClasses) {
   *   console.log(`Class: ${name}, Fields: ${info.fields.size}`);
   * }
   * ```
   */
  static getAllClasses() {
    return new Map(ObjectRegistry.classes);
  }
  /**
   * Get class names
   */
  static getClassNames() {
    return Array.from(ObjectRegistry.classes.keys());
  }
  /**
   * Check if a class is registered (case-insensitive)
   */
  static hasClass(name) {
    return ObjectRegistry.findClass(name) !== void 0;
  }
  /**
   * Clear all registered classes (mainly for testing)
   */
  static clear() {
    ObjectRegistry.classes.clear();
    ObjectRegistry.collections.clear();
    ObjectRegistry.collectionCache.clear();
  }
  /**
   * Get or create a cached collection instance (Singleton pattern - Phase 4 optimization)
   *
   * Returns a cached collection if one exists for the given class and options,
   * otherwise creates, initializes, and caches a new instance. This significantly
   * improves performance by avoiding repeated collection initialization.
   *
   * **Performance Impact**: 60-80% reduction in collection initialization overhead
   *
   * **Cache Key Strategy**: Collections are cached based on:
   * - className
   * - persistence configuration (type, url, baseUrl)
   * - db presence (not full config)
   * - ai presence (not full config)
   *
   * Different persistence configurations create separate cached instances.
   *
   * @param className - Name of the object class
   * @param options - Configuration options for the collection
   * @returns Cached or newly created collection instance
   * @throws {Error} If the class is not registered or has no collection
   *
   * @example
   * ```typescript
   * // First call creates and caches the collection
   * const orders1 = await ObjectRegistry.getCollection('Order', {
   *   persistence: { type: 'sql', url: 'orders.db' }
   * });
   *
   * // Subsequent calls return the cached instance (much faster)
   * const orders2 = await ObjectRegistry.getCollection('Order', {
   *   persistence: { type: 'sql', url: 'orders.db' }
   * });
   * console.log(orders1 === orders2); // true (same instance)
   *
   * // Different configuration creates new instance
   * const orders3 = await ObjectRegistry.getCollection('Order', {
   *   persistence: { type: 'sql', url: 'orders-copy.db' }
   * });
   * console.log(orders1 === orders3); // false (different config)
   * ```
   *
   * @see {@link https://github.com/happyvertical/sdk/blob/main/packages/core/CLAUDE.md#singleton-collection-management-phase-4|Phase 4 Documentation}
   */
  static async getCollection(className, options = {}) {
    const cacheKey = `${className}:${JSON.stringify({
      persistence: options.persistence,
      db: options.db ? "present" : void 0,
      ai: options.ai ? "present" : void 0
    })}`;
    if (ObjectRegistry.collectionCache.has(cacheKey)) {
      return ObjectRegistry.collectionCache.get(cacheKey);
    }
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      throw new Error(
        `Class ${className} not found in ObjectRegistry. Make sure to register it with @smrt() decorator or ObjectRegistry.register()`
      );
    }
    let collectionConstructor = registered.collectionConstructor;
    if (!collectionConstructor) {
      const { SmrtCollection: SmrtCollectionClass } = await import("./collection-9MTAhltA.js").then((n) => n.i);
      class DefaultCollection extends SmrtCollectionClass {
        static _itemClass = registered?.constructor;
      }
      collectionConstructor = DefaultCollection;
      registered.collectionConstructor = DefaultCollection;
      ObjectRegistry.collections.set(className, DefaultCollection);
    }
    const collection = await collectionConstructor.create(
      options
    );
    ObjectRegistry.collectionCache.set(cacheKey, collection);
    return collection;
  }
  /**
   * Compile validation functions from field definitions
   *
   * Extracts validation rules from field options and compiles them into
   * efficient validation functions that can be executed at runtime.
   *
   * @param className - Name of the class being validated
   * @param fields - Map of field definitions
   * @returns Array of compiled validation functions
   * @private
   */
  static compileValidators(className, fields) {
    const validators = [];
    for (const [fieldName, field] of fields) {
      const options = field.options || {};
      if (options.required) {
        validators.push(async (instance) => {
          const value = instance[fieldName];
          if (value === null || value === void 0 || value === "") {
            const ValidationError = await import("./errors-D1u9UqLX.js").then(
              (m) => m.ValidationError
            );
            return ValidationError.requiredField(fieldName, className);
          }
          return null;
        });
      }
      if (field.type === "integer" || field.type === "decimal" || field.type === "number") {
        if (options.min !== void 0) {
          validators.push(async (instance) => {
            const value = instance[fieldName];
            if (value !== null && value !== void 0 && value < options.min) {
              const ValidationError = await import("./errors-D1u9UqLX.js").then(
                (m) => m.ValidationError
              );
              return ValidationError.rangeError(
                fieldName,
                value,
                options.min,
                options.max
              );
            }
            return null;
          });
        }
        if (options.max !== void 0) {
          validators.push(async (instance) => {
            const value = instance[fieldName];
            if (value !== null && value !== void 0 && value > options.max) {
              const ValidationError = await import("./errors-D1u9UqLX.js").then(
                (m) => m.ValidationError
              );
              return ValidationError.rangeError(
                fieldName,
                value,
                options.min,
                options.max
              );
            }
            return null;
          });
        }
      }
      if (field.type === "text") {
        if (options.minLength !== void 0) {
          validators.push(async (instance) => {
            const value = instance[fieldName];
            if (value && typeof value === "string" && value.length < options.minLength) {
              const ValidationError = await import("./errors-D1u9UqLX.js").then(
                (m) => m.ValidationError
              );
              return ValidationError.invalidValue(
                fieldName,
                value,
                `string with minimum length ${options.minLength}`
              );
            }
            return null;
          });
        }
        if (options.maxLength !== void 0) {
          validators.push(async (instance) => {
            const value = instance[fieldName];
            if (value && typeof value === "string" && value.length > options.maxLength) {
              const ValidationError = await import("./errors-D1u9UqLX.js").then(
                (m) => m.ValidationError
              );
              return ValidationError.invalidValue(
                fieldName,
                value,
                `string with maximum length ${options.maxLength}`
              );
            }
            return null;
          });
        }
        if (options.pattern) {
          const regex = new RegExp(options.pattern);
          validators.push(async (instance) => {
            const value = instance[fieldName];
            if (value && typeof value === "string" && !regex.test(value)) {
              const ValidationError = await import("./errors-D1u9UqLX.js").then(
                (m) => m.ValidationError
              );
              return ValidationError.invalidValue(
                fieldName,
                value,
                `string matching pattern ${options.pattern}`
              );
            }
            return null;
          });
        }
      }
      if (options.validate && typeof options.validate === "function") {
        validators.push(async (instance) => {
          const value = instance[fieldName];
          try {
            const isValid = await options.validate(value);
            if (!isValid) {
              const ValidationError = await import("./errors-D1u9UqLX.js").then(
                (m) => m.ValidationError
              );
              const message = options.customMessage || `Field ${fieldName} failed custom validation`;
              return ValidationError.invalidValue(fieldName, value, message);
            }
          } catch (error) {
            const ValidationError = await import("./errors-D1u9UqLX.js").then(
              (m) => m.ValidationError
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `custom validation error: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          return null;
        });
      }
    }
    return validators;
  }
  /**
   * Get field definitions for a registered class
   */
  static getFields(name) {
    const registered = ObjectRegistry.classes.get(name);
    return registered ? registered.fields : /* @__PURE__ */ new Map();
  }
  /**
   * Get configuration for a registered class
   */
  static getConfig(name) {
    const registered = ObjectRegistry.classes.get(name);
    return registered ? registered.config : {};
  }
  /**
   * Get cached schema definition for a registered class
   *
   * @param name - Name of the registered class
   * @returns Schema definition or undefined if not found
   * @example
   * ```typescript
   * const schema = ObjectRegistry.getSchema('Product');
   * console.log(schema.tableName); // 'products'
   * console.log(schema.ddl);       // 'CREATE TABLE...'
   * ```
   */
  static getSchema(name) {
    const registered = ObjectRegistry.classes.get(name);
    return registered?.schema;
  }
  /**
   * Get SQL DDL statement for a registered class
   *
   * @param name - Name of the registered class
   * @returns SQL DDL statement or undefined if not found
   * @example
   * ```typescript
   * const ddl = ObjectRegistry.getSchemaDDL('Product');
   * await db.query(ddl);
   * ```
   */
  static getSchemaDDL(name) {
    return ObjectRegistry.getSchema(name)?.ddl;
  }
  /**
   * Get table name for a registered class
   *
   * @param name - Name of the registered class
   * @returns Table name or undefined if not found
   * @example
   * ```typescript
   * const tableName = ObjectRegistry.getTableName('Product');
   * console.log(tableName); // 'products'
   * ```
   */
  static getTableName(name) {
    return ObjectRegistry.getSchema(name)?.tableName;
  }
  /**
   * Get compiled validation functions for a registered class
   *
   * Returns pre-compiled validation functions that can be executed
   * at runtime for efficient validation without repeated setup.
   *
   * @param name - Name of the registered class
   * @returns Array of validation functions or undefined if not found
   * @example
   * ```typescript
   * const validators = ObjectRegistry.getValidators('Product');
   * for (const validator of validators || []) {
   *   const error = await validator(productInstance);
   *   if (error) console.error(error);
   * }
   * ```
   */
  static getValidators(name) {
    const registered = ObjectRegistry.classes.get(name);
    return registered?.validators;
  }
  /**
   * Build dependency graph from foreignKey relationships
   *
   * Returns a map where keys are class names and values are arrays
   * of class names that the key depends on (via foreignKey fields).
   *
   * @returns Map of class name to array of dependency class names
   * @example
   * ```typescript
   * const deps = ObjectRegistry.getDependencyGraph();
   * // { 'Order': ['Customer', 'Product'], 'Customer': [], 'Product': ['Category'] }
   * ```
   */
  static getDependencyGraph() {
    const graph = /* @__PURE__ */ new Map();
    for (const [className] of ObjectRegistry.classes) {
      graph.set(className, []);
    }
    for (const [className, registered] of ObjectRegistry.classes) {
      const dependencies = [];
      for (const [_fieldName, field] of registered.fields) {
        if (field.type === "foreignKey" && field.options?.related) {
          const relatedClass = field.options.related;
          if (ObjectRegistry.classes.has(relatedClass)) {
            dependencies.push(relatedClass);
          }
        }
      }
      graph.set(className, dependencies);
    }
    return graph;
  }
  /**
   * Get initialization order for classes based on dependency graph
   *
   * Uses topological sort to ensure that classes are initialized in
   * an order that respects foreignKey dependencies (dependencies first).
   *
   * @returns Array of class names in initialization order
   * @throws {Error} If circular dependencies are detected
   * @example
   * ```typescript
   * const order = ObjectRegistry.getInitializationOrder();
   * // ['Category', 'Product', 'Customer', 'Order']
   * // Tables are created in this order to avoid foreign key errors
   * ```
   */
  static getInitializationOrder() {
    const graph = ObjectRegistry.getDependencyGraph();
    const visited = /* @__PURE__ */ new Set();
    const visiting = /* @__PURE__ */ new Set();
    const order = [];
    function visit(className) {
      if (visiting.has(className)) {
        throw new Error(
          `Circular dependency detected involving class: ${className}`
        );
      }
      if (visited.has(className)) {
        return;
      }
      visiting.add(className);
      const dependencies = graph.get(className) || [];
      for (const dep of dependencies) {
        visit(dep);
      }
      visiting.delete(className);
      visited.add(className);
      order.push(className);
    }
    for (const className of graph.keys()) {
      if (!visited.has(className)) {
        visit(className);
      }
    }
    return order;
  }
  /**
   * Build comprehensive relationship map from all field types
   *
   * Returns a map containing all relationships (foreignKey, oneToMany, manyToMany)
   * discovered in registered classes. This enables runtime relationship traversal
   * and eager/lazy loading of related objects.
   *
   * @returns Map of class name to array of relationship metadata
   * @example
   * ```typescript
   * const relationships = ObjectRegistry.getRelationshipMap();
   * // {
   * //   'Order': [
   * //     { sourceClass: 'Order', fieldName: 'customerId', targetClass: 'Customer',
   * //       type: 'foreignKey', options: { onDelete: 'restrict' } }
   * //   ],
   * //   'Customer': [
   * //     { sourceClass: 'Customer', fieldName: 'orders', targetClass: 'Order',
   * //       type: 'oneToMany', options: {} }
   * //   ]
   * // }
   * ```
   */
  static getRelationshipMap() {
    const relationshipMap = /* @__PURE__ */ new Map();
    for (const [className] of ObjectRegistry.classes) {
      relationshipMap.set(className, []);
    }
    for (const [className, registered] of ObjectRegistry.classes) {
      const relationships = [];
      for (const [fieldName, field] of registered.fields) {
        if (field.type === "foreignKey" && field.options?.related) {
          relationships.push({
            sourceClass: className,
            fieldName,
            targetClass: field.options.related,
            type: "foreignKey",
            options: field.options
          });
        }
        if (field.type === "oneToMany" && field.options?.related) {
          relationships.push({
            sourceClass: className,
            fieldName,
            targetClass: field.options.related,
            type: "oneToMany",
            options: field.options
          });
        }
        if (field.type === "manyToMany" && field.options?.related) {
          relationships.push({
            sourceClass: className,
            fieldName,
            targetClass: field.options.related,
            type: "manyToMany",
            options: field.options
          });
        }
      }
      relationshipMap.set(className, relationships);
    }
    return relationshipMap;
  }
  /**
   * Get relationships for a specific class
   *
   * @param className - Name of the class to get relationships for
   * @returns Array of relationship metadata for the class
   * @example
   * ```typescript
   * const orderRelationships = ObjectRegistry.getRelationships('Order');
   * // [{ sourceClass: 'Order', fieldName: 'customerId', ... }]
   * ```
   */
  static getRelationships(className) {
    return ObjectRegistry.getRelationshipMap().get(className) || [];
  }
  /**
   * Get complete metadata for a single object (convenience method)
   *
   * Returns all available metadata for an object in a single call, including:
   * - Class information
   * - Field definitions
   * - Configuration
   * - Schema definition
   * - Validators
   * - Relationships
   * - Tools (AI-callable methods)
   *
   * This is a convenience method that aggregates multiple registry queries
   * into a single comprehensive metadata object.
   *
   * @param className - Name of the class to get metadata for
   * @returns Complete metadata object or null if class not found
   * @example
   * ```typescript
   * const productMeta = ObjectRegistry.getObjectMetadata('Product');
   * if (productMeta) {
   *   console.log('Name:', productMeta.name);
   *   console.log('Table:', productMeta.schema.tableName);
   *   console.log('Fields:', productMeta.fields.size);
   *   console.log('API config:', productMeta.config.api);
   *   console.log('Relationships:', productMeta.relationships.length);
   * }
   * ```
   */
  static getObjectMetadata(className) {
    const registered = ObjectRegistry.findClass(className);
    if (!registered) {
      return null;
    }
    return {
      name: registered.name,
      constructor: registered.constructor,
      collectionConstructor: registered.collectionConstructor,
      config: registered.config,
      fields: new Map(registered.fields),
      // Return copy to prevent mutations
      schema: registered.schema,
      validators: registered.validators || [],
      relationships: ObjectRegistry.getRelationships(className),
      inverseRelationships: ObjectRegistry.getInverseRelationships(className),
      tools: registered.tools
    };
  }
  /**
   * Get metadata for all registered objects (convenience method)
   *
   * Returns comprehensive metadata for every registered object, combining
   * multiple registry queries into a single convenient data structure.
   *
   * This is particularly useful for:
   * - Admin dashboards showing all objects
   * - Documentation generation
   * - Schema visualization
   * - Debugging and introspection
   *
   * @returns Array of complete metadata objects for all registered classes
   * @example
   * ```typescript
   * const allMetadata = ObjectRegistry.getAllObjectMetadata();
   *
   * // Generate admin dashboard
   * for (const meta of allMetadata) {
   *   console.log(`${meta.name}:`);
   *   console.log(`  Table: ${meta.schema?.tableName}`);
   *   console.log(`  Fields: ${meta.fields.size}`);
   *   console.log(`  API: ${meta.config.api ? 'enabled' : 'disabled'}`);
   *   console.log(`  Relationships: ${meta.relationships.length}`);
   * }
   *
   * // Generate schema documentation
   * const schemaDoc = allMetadata.map(meta => ({
   *   name: meta.name,
   *   table: meta.schema?.tableName,
   *   fields: Array.from(meta.fields.entries()).map(([name, field]) => ({
   *     name,
   *     type: field.type,
   *     required: field.options?.required || false
   *   })),
   *   relationships: meta.relationships.map(rel => ({
   *     field: rel.fieldName,
   *     target: rel.targetClass,
   *     type: rel.type
   *   }))
   * }));
   * ```
   */
  static getAllObjectMetadata() {
    const allMetadata = [];
    for (const [className] of ObjectRegistry.classes) {
      const metadata = ObjectRegistry.getObjectMetadata(className);
      if (metadata) {
        allMetadata.push(metadata);
      }
    }
    return allMetadata;
  }
  /**
   * Get inverse relationships (relationships where this class is the target)
   *
   * @param className - Name of the class to find inverse relationships for
   * @returns Array of relationship metadata where this class is the target
   * @example
   * ```typescript
   * const customerInverseRels = ObjectRegistry.getInverseRelationships('Customer');
   * // [{ sourceClass: 'Order', fieldName: 'customerId', targetClass: 'Customer', ... }]
   * ```
   */
  static getInverseRelationships(className) {
    const allRelationships = ObjectRegistry.getRelationshipMap();
    const inverseRelationships = [];
    for (const [_sourceClass, relationships] of allRelationships) {
      for (const rel of relationships) {
        if (rel.targetClass === className) {
          inverseRelationships.push(rel);
        }
      }
    }
    return inverseRelationships;
  }
  /**
   * Persist registry state to system tables
   *
   * Saves all registered class metadata to the _smrt_registry system table
   * for runtime introspection and debugging. This enables applications to
   * query what SMRT objects exist and their configurations.
   *
   * @param db - Database interface to persist to
   * @returns Promise that resolves when persistence is complete
   * @example
   * ```typescript
   * // After registering all classes
   * await ObjectRegistry.persistToDatabase(db);
   *
   * // Later, query the system table
   * const rows = await db.all('SELECT * FROM _smrt_registry');
   * console.log('Registered classes:', rows.map(r => r.class_name));
   * ```
   */
  static async persistToDatabase(db) {
    for (const [className, registered] of ObjectRegistry.classes.entries()) {
      const fieldsData = {};
      for (const [key, value] of registered.fields) {
        fieldsData[key] = {
          type: value.type,
          options: value.options
        };
      }
      await db.query(
        `INSERT OR REPLACE INTO _smrt_registry
         (class_name, schema_version, fields, relationships, config, manifest, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        className,
        "1.0.0",
        // Could be derived from package version
        JSON.stringify(fieldsData),
        JSON.stringify(ObjectRegistry.getRelationships(className)),
        JSON.stringify(registered.config),
        JSON.stringify({
          name: registered.name,
          tableName: registered.schema?.tableName,
          tools: registered.tools
        }),
        /* @__PURE__ */ new Date()
      );
    }
  }
  /**
   * Load registry metadata from system tables
   *
   * Reads the _smrt_registry system table to inspect what classes
   * have been registered. This is primarily for introspection and
   * debugging - actual class registration happens via @smrt() decorator.
   *
   * @param db - Database interface to load from
   * @returns Promise resolving to array of class metadata
   * @example
   * ```typescript
   * const metadata = await ObjectRegistry.loadFromDatabase(db);
   * for (const meta of metadata) {
   *   console.log(`Class: ${meta.class_name}`);
   *   console.log(`Table: ${JSON.parse(meta.manifest).tableName}`);
   * }
   * ```
   */
  static async loadFromDatabase(db) {
    const { rows } = await db.query(
      "SELECT * FROM _smrt_registry ORDER BY class_name"
    );
    return rows;
  }
}
function smrt(config = {}) {
  return (ctor) => {
    const tableName = config.tableName || classnameToTablename(ctor.name);
    Object.defineProperty(ctor, "SMRT_TABLE_NAME", {
      value: tableName,
      writable: false,
      enumerable: false,
      configurable: false
    });
    ObjectRegistry.register(ctor, { ...config, tableName });
    return ctor;
  };
}
export {
  ObjectRegistry as O,
  toSnakeCase as a,
  smrt as b,
  formatDataJs as c,
  formatDataSql as d,
  toCamelCase as e,
  fieldsFromClass as f,
  generateSchema as g,
  keysToCamelCase as h,
  isDateField as i,
  dateAsString as j,
  keysToSnakeCase as k,
  dateAsObject as l,
  classnameToTablename as m,
  setupTableFromClass as s,
  tableNameFromClass as t
};
//# sourceMappingURL=registry-Dg2mIESQ.js.map
