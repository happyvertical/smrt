import { a as SmrtClass } from "./chunks/collection-DnmDOjNW.js";
import { A, C, e, f, g, h, b, d, S, c } from "./chunks/collection-DnmDOjNW.js";
import { ValidationError, RuntimeError, DatabaseError, ErrorUtils } from "./chunks/errors-Cl0_Kxat.js";
import { AIError, ConfigurationError, FilesystemError, NetworkError, SmrtError, ValidationReport, ValidationUtils } from "./chunks/errors-Cl0_Kxat.js";
import { Field } from "./fields.js";
import { boolean, datetime, decimal, foreignKey, integer, json, manyToMany, oneToMany, text } from "./fields.js";
import { CLIGenerator, main } from "./generators/cli.js";
import { MCPGenerator } from "./generators/mcp.js";
import { APIGenerator, createRestServer, startRestServer } from "./generators/rest.js";
import { generateOpenAPISpec, setupSwaggerUI } from "./generators/swagger.js";
import { O as ObjectRegistry, f as fieldsFromClass, s as setupTableFromClass, t as tableNameFromClass, a as toSnakeCase } from "./chunks/registry-CzXM0OU7.js";
import { b as b2, b as b3 } from "./chunks/registry-CzXM0OU7.js";
import { a, c as c2, b as b4 } from "./chunks/server-DwHneUSW.js";
import { getManifest } from "./manifest.js";
import { M, c as c3, a as a2, b as b5, s } from "./chunks/manifest-generator-Bb3IuFsV.js";
import { MetricsAdapter } from "./chunks/metrics-JaU-tpt3.js";
import { PubSubAdapter } from "./chunks/pubsub-BJ1ZU6QU.js";
import { s as s2 } from "./chunks/index-BbfsvU_3.js";
import { staticManifest } from "./chunks/static-manifest-CPsB80P8.js";
function validateToolCall(methodName, args, allowedMethods) {
  if (!allowedMethods.includes(methodName)) {
    throw ValidationError.invalidValue(
      "methodName",
      methodName,
      `Method must be one of: ${allowedMethods.join(", ")}`
    );
  }
  if (typeof args !== "object" || args === null) {
    throw ValidationError.invalidValue(
      "arguments",
      args,
      "Arguments must be a valid object"
    );
  }
}
async function executeToolCall(instance, toolCall, allowedMethods, signalBus) {
  const startTime = Date.now();
  const methodName = toolCall.function.name;
  const executionId = signalBus?.generateExecutionId() ?? toolCall.id;
  let args;
  try {
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (parseError) {
      throw ValidationError.invalidValue(
        "arguments",
        toolCall.function.arguments,
        "Arguments must be valid JSON"
      );
    }
    if (!args) {
      throw ValidationError.invalidValue(
        "arguments",
        toolCall.function.arguments,
        "Arguments must be a valid object"
      );
    }
    validateToolCall(methodName, args, allowedMethods);
    if (typeof instance[methodName] !== "function") {
      throw RuntimeError.operationFailed(
        `Method '${methodName}' not found on object`
      );
    }
    if (signalBus) {
      const startSignal = {
        id: executionId,
        objectId: instance.id ?? "unknown",
        className: instance.constructor?.name ?? "Unknown",
        method: methodName,
        type: "start",
        args: [args],
        // Wrap in array for consistency
        timestamp: Date.now()
      };
      await signalBus.emit(startSignal);
    }
    const result = await instance[methodName](args);
    if (signalBus) {
      const endSignal = {
        id: executionId,
        objectId: instance.id ?? "unknown",
        className: instance.constructor?.name ?? "Unknown",
        method: methodName,
        type: "end",
        args: [args],
        result,
        duration: Date.now() - startTime,
        timestamp: Date.now()
      };
      await signalBus.emit(endSignal);
    }
    return {
      id: toolCall.id,
      methodName,
      arguments: args,
      result,
      success: true,
      duration: Date.now() - startTime
    };
  } catch (error) {
    if (signalBus) {
      const errorSignal = {
        id: executionId,
        objectId: instance.id ?? "unknown",
        className: instance.constructor?.name ?? "Unknown",
        method: methodName,
        type: "error",
        // Preserve actual args if parsed, otherwise include raw arguments for debugging
        args: [
          typeof args !== "undefined" ? args : toolCall.function.arguments
        ],
        error: error instanceof Error ? error : new Error(String(error)),
        duration: Date.now() - startTime,
        timestamp: Date.now()
      };
      await signalBus.emit(errorSignal);
    }
    return {
      id: toolCall.id,
      methodName,
      arguments: {},
      result: null,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      duration: Date.now() - startTime
    };
  }
}
async function executeToolCalls(instance, toolCalls, allowedMethods, signalBus) {
  const results = [];
  for (const toolCall of toolCalls) {
    const result = await executeToolCall(
      instance,
      toolCall,
      allowedMethods,
      signalBus
    );
    results.push(result);
    if (!result.success) {
      console.warn(
        `Tool call failed for ${result.methodName}: ${result.error}`
      );
    }
  }
  return results;
}
function formatToolResults(results) {
  return results.map((result) => ({
    role: "tool",
    tool_call_id: result.id,
    content: result.success ? JSON.stringify(result.result) : `Error: ${result.error}`
  }));
}
class SmrtObject extends SmrtClass {
  /**
   * Database table name for this object
   */
  _tableName;
  /**
   * Cache for loaded relationships to avoid repeated database queries
   * Maps fieldName to loaded object(s)
   */
  _loadedRelationships = /* @__PURE__ */ new Map();
  /**
   * Unique identifier for the object
   */
  _id;
  /**
   * URL-friendly identifier
   */
  _slug;
  /**
   * Optional context to scope the slug
   */
  _context;
  /**
   * Human-readable name, primarily for display purposes
   * Can be a string value or a Field instance (for Field-based schema definition)
   */
  name = null;
  /**
   * Creation timestamp
   */
  created_at = null;
  /**
   * Last update timestamp
   */
  updated_at = null;
  /**
   * Creates a new SmrtObject instance
   *
   * @param options - Configuration options including identifiers and metadata
   * @throws Error if options is null
   */
  constructor(options = {}) {
    super(options);
    this.options = options;
    if (options === null) {
      throw new Error("options cant be null");
    }
    this._id = options.id || null;
    this._slug = options.slug || null;
    this._context = options.context || "";
    if (this.constructor !== SmrtObject && !ObjectRegistry.hasClass(this.constructor.name) && !options?._skipRegistration) {
      ObjectRegistry.register(this.constructor, {});
    }
  }
  /**
   * Initialize properties from options after field initializers have run
   * This ensures option values take precedence over default field initializer values
   */
  initializePropertiesFromOptions() {
    const options = this.options;
    if (options.name !== void 0) this.name = options.name;
    if (options.created_at !== void 0) this.created_at = options.created_at;
    if (options.updated_at !== void 0) this.updated_at = options.updated_at;
    const fields = fieldsFromClass(
      this.constructor
    );
    for (const [key, field] of Object.entries(fields)) {
      if (options[key] !== void 0) {
        this[key] = options[key];
        if (field instanceof Field) {
          field.value = options[key];
        }
      }
    }
  }
  /**
   * Gets the unique identifier for this object
   */
  get id() {
    return this._id;
  }
  /**
   * Sets the unique identifier for this object
   *
   * @param value - The ID to set
   * @throws Error if the value is invalid
   */
  set id(value) {
    if (!value || value === "undefined" || value === "null") {
      throw new Error(`id is required, ${value} given`);
    }
    this._id = value;
  }
  /**
   * Gets the URL-friendly slug for this object
   */
  get slug() {
    return this._slug;
  }
  /**
   * Sets the URL-friendly slug for this object
   *
   * @param value - The slug to set
   * @throws Error if the value is invalid
   */
  set slug(value) {
    if (!value || value === "undefined" || value === "null") {
      throw new Error(`slug is invalid, ${value} given`);
    }
    this._slug = value;
  }
  /**
   * Gets the context that scopes this object's slug
   */
  get context() {
    return this._context || "";
  }
  /**
   * Sets the context that scopes this object's slug
   *
   * @param value - The context to set
   * @throws Error if the value is invalid
   */
  set context(value) {
    if (value !== "" && !value) {
      throw new Error(`context is invalid, ${value} given`);
    }
    this._context = value;
  }
  /**
   * Initializes this object, setting up database tables and loading data if identifiers are provided
   *
   * @returns Promise that resolves to this instance for chaining
   */
  async initialize() {
    await super.initialize();
    if (!this.options._extractingFields) {
      this.initializePropertiesFromOptions();
    }
    if (this.options.db) {
      await setupTableFromClass(this.db, this.constructor);
      await this.db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.tableName}_slug_context
        ON ${this.tableName}(slug, context);
      `);
    }
    if (this._id && !this.options._skipLoad) {
      await this.loadFromId();
    } else if (this._slug && !this.options._skipLoad) {
      await this.loadFromSlug();
    }
    return this;
  }
  /**
   * Loads data from a database row into this object's properties
   *
   * @param data - Database row data
   */
  loadDataFromDb(data) {
    const fields = this.getFields();
    for (const field in fields) {
      if (Object.hasOwn(fields, field)) {
        this[field] = data[field];
      }
    }
  }
  /**
   * Gets all property descriptors from this object's prototype
   *
   * @returns Object containing all property descriptors
   */
  allDescriptors() {
    const proto = Object.getPrototypeOf(this);
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    return descriptors;
  }
  /**
   * Gets the database table name for this object
   */
  get tableName() {
    if (!this._tableName) {
      this._tableName = tableNameFromClass(this.constructor);
    }
    return this._tableName;
  }
  /**
   * Gets field definitions and current values for this object
   *
   * @returns Object containing field definitions with current values
   */
  getFields() {
    const fields = fieldsFromClass(
      this.constructor
    );
    for (const key in fields) {
      fields[key].value = this.getPropertyValue(key);
    }
    return fields;
  }
  /**
   * Custom JSON serialization
   * Returns a plain object with all field values for proper JSON.stringify() behavior
   * Field instances automatically call their toJSON() method during serialization
   */
  toJSON() {
    const fields = this.getFields();
    const data = {
      id: this.id,
      slug: this.slug,
      context: this.context,
      name: this.name,
      created_at: this.created_at,
      updated_at: this.updated_at
    };
    for (const [key, field] of Object.entries(fields)) {
      data[key] = field.value;
    }
    return data;
  }
  /**
   * Gets or generates a unique ID for this object
   *
   * @returns Promise resolving to the object's ID
   */
  async getId() {
    const saved = await this.db.pluck`SELECT id FROM ${this.tableName} WHERE slug = ${this.slug} AND context = ${this.context} LIMIT 1`;
    if (saved) {
      this.id = saved;
    }
    if (!this.id) {
      this.id = crypto.randomUUID();
    }
    return this.id;
  }
  /**
   * Gets or generates a slug for this object based on its name
   *
   * @returns Promise resolving to the object's slug
   */
  async getSlug() {
    if (!this.slug && this.name) {
      const nameStr = String(this.name);
      this.slug = nameStr.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    }
    return this.slug;
  }
  /**
   * Gets the ID of this object if it's already saved in the database
   *
   * @returns Promise resolving to the saved ID or null if not saved
   */
  async getSavedId() {
    const { pluck } = this.db;
    const saved = await pluck`SELECT id FROM ${this.tableName} WHERE id = ${this.id} OR slug = ${this.slug} LIMIT 1`;
    return saved;
  }
  /**
   * Checks if this object is already saved in the database
   *
   * @returns Promise resolving to true if saved, false otherwise
   */
  async isSaved() {
    const saved = await this.getSavedId();
    return !!saved;
  }
  /**
   * Saves this object to the database
   *
   * @returns Promise resolving to this object
   */
  async save() {
    try {
      await this.validateBeforeSave();
      if (!this.id) {
        this.id = crypto.randomUUID();
      }
      if (!this.slug) {
        this.slug = await this.getSlug();
      }
      this.updated_at = /* @__PURE__ */ new Date();
      if (!this.created_at) {
        this.created_at = /* @__PURE__ */ new Date();
      }
      try {
        await setupTableFromClass(this.db, this.constructor);
      } catch (error) {
        throw DatabaseError.schemaError(
          this._tableName || this.constructor.name,
          "table setup",
          error instanceof Error ? error : new Error(String(error))
        );
      }
      const jsonData = this.toJSON();
      const data = {};
      for (const [key, value] of Object.entries(jsonData)) {
        data[toSnakeCase(key)] = value;
      }
      await ErrorUtils.withRetry(
        async () => {
          try {
            await this.db.upsert(this.tableName, ["slug", "context"], data);
          } catch (error) {
            if (error instanceof Error) {
              if (error.message.includes("UNIQUE constraint failed")) {
                const field = this.extractConstraintField(error.message);
                throw ValidationError.uniqueConstraint(
                  field,
                  this.getFieldValue(field)
                );
              }
              if (error.message.includes("NOT NULL constraint failed")) {
                const field = this.extractConstraintField(error.message);
                throw ValidationError.requiredField(
                  field,
                  this.constructor.name
                );
              }
              throw DatabaseError.queryFailed(
                `UPSERT INTO ${this.tableName}`,
                error
              );
            }
            throw error;
          }
        },
        3,
        500
      );
      return this;
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw RuntimeError.operationFailed(
        "save",
        `${this.constructor.name}#${this.id}`,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
  /**
   * Validates object state before saving
   * Override in subclasses to add custom validation logic
   */
  async validateBeforeSave() {
    const validators = ObjectRegistry.getValidators(this.constructor.name);
    if (validators && validators.length > 0) {
      const errors = [];
      for (const validator of validators) {
        const error = await validator(this);
        if (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw errors[0];
      }
    } else {
      const fields = fieldsFromClass(this.constructor);
      for (const [fieldName, field] of Object.entries(fields)) {
        if (field instanceof Field && field.options.required) {
          const value = this.getFieldValue(fieldName);
          if (value === null || value === void 0 || value === "") {
            throw ValidationError.requiredField(
              fieldName,
              this.constructor.name
            );
          }
        }
      }
    }
  }
  /**
   * Gets the value of a field on this object
   */
  getFieldValue(fieldName) {
    return this[fieldName];
  }
  /**
   * Gets the actual value from a property, whether it's a plain value or a Field instance
   *
   * Handles both simple and advanced field patterns:
   * - Simple: `name: string = ''` - returns the string directly
   * - Advanced: `name = text()` - extracts and returns field.value
   *
   * @param key - Property name to extract value from
   * @returns The actual value (unwrapped from Field if necessary)
   */
  getPropertyValue(key) {
    const prop = this[key];
    if (prop && typeof prop === "object" && "value" in prop && "type" in prop) {
      return prop.value;
    }
    return prop;
  }
  /**
   * Extracts field name from database constraint error messages
   */
  extractConstraintField(errorMessage) {
    const patterns = [
      /UNIQUE constraint failed: \w+\.(\w+)/,
      /NOT NULL constraint failed: \w+\.(\w+)/,
      /constraint failed: (\w+)/i
    ];
    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
    return "unknown_field";
  }
  /**
   * Loads this object's data from the database using its ID
   *
   * @returns Promise that resolves when loading is complete
   */
  async loadFromId() {
    try {
      if (!this._id) {
        throw ValidationError.requiredField("id", this.constructor.name);
      }
      const sql = `SELECT * FROM ${this.tableName} WHERE id = ?`;
      await ErrorUtils.withRetry(
        async () => {
          try {
            const {
              rows: [existing]
            } = await this.db.query(sql, [this._id]);
            if (existing) {
              this.loadDataFromDb(existing);
            }
          } catch (error) {
            throw DatabaseError.queryFailed(
              sql,
              error instanceof Error ? error : new Error(String(error))
            );
          }
        },
        3,
        250
      );
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }
      throw RuntimeError.operationFailed(
        "loadFromId",
        `${this.constructor.name}#${this._id}`,
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
  /**
   * Loads this object's data from the database using its slug and context
   *
   * @returns Promise that resolves when loading is complete
   */
  async loadFromSlug() {
    const {
      rows: [existing]
    } = await this.db.query(
      `SELECT * FROM ${this.tableName} WHERE slug = ? AND context = ?`,
      [this._slug, this._context || ""]
    );
    if (existing) {
      this.loadDataFromDb(existing);
    }
  }
  /**
   * Evaluates whether this object meets given criteria using AI
   *
   * @param criteria - Criteria to evaluate against
   * @param options - AI message options
   * @returns Promise resolving to true if criteria are met, false otherwise
   * @throws Error if the AI response is invalid
   */
  async is(criteria, options = {}) {
    const prompt = `--- Beginning of criteria ---
${criteria}
--- End of criteria ---
Does the content meet all the given criteria? Reply with a json object with a single boolean 'result' property`;
    const tools = this.getAvailableTools();
    const message = await this.ai.message(prompt, {
      ...options,
      responseFormat: { type: "json_object" },
      tools: tools.length > 0 ? tools : void 0
    });
    try {
      const { result } = JSON.parse(message);
      if (result === true || result === false) {
        return result;
      }
    } catch (_e) {
      throw new Error(`Unexpected answer: ${message}`);
    }
  }
  /**
   * Performs actions on this object based on instructions using AI
   *
   * @param instructions - Instructions for the AI to follow
   * @param options - AI message options
   * @returns Promise resolving to the AI response
   */
  async do(instructions, options = {}) {
    const prompt = `--- Beginning of instructions ---
${instructions}
--- End of instructions ---
Based on the content body, please follow the instructions and provide a response. Never make use of codeblocks.`;
    const tools = this.getAvailableTools();
    const result = await this.ai.message(prompt, {
      ...options,
      tools: tools.length > 0 ? tools : void 0
    });
    return result;
  }
  /**
   * Runs a lifecycle hook if it's defined in the object's configuration
   *
   * @param hookName - Name of the hook to run (e.g., 'beforeDelete', 'afterDelete')
   * @returns Promise that resolves when the hook completes
   */
  async runHook(hookName) {
    const config = ObjectRegistry.getConfig(this.constructor.name);
    const hook = config.hooks?.[hookName];
    if (!hook) {
      return;
    }
    if (typeof hook === "string") {
      const method = this[hook];
      if (typeof method === "function") {
        await method.call(this);
      } else {
        console.warn(
          `Hook method '${hook}' not found on ${this.constructor.name}`
        );
      }
    } else if (typeof hook === "function") {
      await hook(this);
    }
  }
  /**
   * Delete this object from the database
   *
   * @returns Promise that resolves when deletion is complete
   */
  async delete() {
    await this.runHook("beforeDelete");
    await this.db.query(`DELETE FROM ${this.tableName} WHERE id = ?`, [
      this.id
    ]);
    await this.runHook("afterDelete");
  }
  /**
   * Check if a relationship has been loaded
   *
   * @param fieldName - Name of the relationship field
   * @returns True if the relationship is loaded, false otherwise
   * @example
   * ```typescript
   * if (order.isRelatedLoaded('customer')) {
   *   console.log('Customer already loaded');
   * }
   * ```
   */
  isRelatedLoaded(fieldName) {
    return this._loadedRelationships.has(fieldName);
  }
  /**
   * Load a related object for a foreignKey field (lazy loading)
   *
   * Automatically loads the related object from the database using the
   * foreign key value. The loaded object is cached to avoid repeated queries.
   *
   * @param fieldName - Name of the foreignKey field
   * @returns Promise resolving to the related object or null if not found
   * @throws {RuntimeError} If the field is not a foreignKey or target class not found
   * @example
   * ```typescript
   * // Given: class Order with customerId = foreignKey(Customer)
   * const customer = await order.loadRelated('customerId');
   * console.log(customer.name); // Access customer properties
   * ```
   */
  async loadRelated(fieldName) {
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name
    );
    const relationship = relationships.find(
      (r) => r.fieldName === fieldName && r.type === "foreignKey"
    );
    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a foreignKey relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name }
      );
    }
    const foreignKeyValue = this[fieldName];
    if (!foreignKeyValue) {
      this._loadedRelationships.set(fieldName, null);
      return null;
    }
    const targetClassInfo = ObjectRegistry.getClass(relationship.targetClass);
    if (!targetClassInfo) {
      throw RuntimeError.invalidState(
        `Target class ${relationship.targetClass} not found in ObjectRegistry`,
        { targetClass: relationship.targetClass, fieldName }
      );
    }
    const relatedInstance = new targetClassInfo.constructor(this.options);
    await relatedInstance.initialize();
    relatedInstance.id = foreignKeyValue;
    await relatedInstance.loadFromId();
    this._loadedRelationships.set(fieldName, relatedInstance);
    return relatedInstance;
  }
  /**
   * Load related objects for oneToMany or manyToMany fields (lazy loading)
   *
   * Loads all related objects from the database. For oneToMany, queries by
   * the inverse foreign key. For manyToMany, queries through the join table.
   *
   * @param fieldName - Name of the oneToMany or manyToMany field
   * @returns Promise resolving to array of related objects
   * @throws {RuntimeError} If the field is not a relationship or not implemented
   * @example
   * ```typescript
   * // Given: class Customer with orders = oneToMany(Order)
   * const orders = await customer.loadRelatedMany('orders');
   * console.log(`${orders.length} orders found`);
   * ```
   */
  async loadRelatedMany(fieldName) {
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name
    );
    const relationship = relationships.find((r) => r.fieldName === fieldName);
    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name }
      );
    }
    if (relationship.type === "oneToMany") {
      const inverseRelationships = ObjectRegistry.getInverseRelationships(
        this.constructor.name
      );
      const inverseForeignKey = inverseRelationships.find(
        (r) => r.sourceClass === relationship.targetClass && r.type === "foreignKey" && r.targetClass === this.constructor.name
      );
      if (!inverseForeignKey) {
        throw RuntimeError.invalidState(
          `Could not find inverse foreignKey on ${relationship.targetClass} for oneToMany relationship ${fieldName}`,
          { fieldName, targetClass: relationship.targetClass }
        );
      }
      const collection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options
      );
      const relatedObjects = await collection.list({
        where: { [inverseForeignKey.fieldName]: this.id }
      });
      this._loadedRelationships.set(fieldName, relatedObjects);
      return relatedObjects;
    }
    if (relationship.type === "manyToMany") {
      throw RuntimeError.invalidState(
        `manyToMany relationship loading not yet implemented for ${fieldName}`,
        { fieldName, type: "manyToMany" }
      );
    }
    throw RuntimeError.invalidState(
      `Field ${fieldName} is not a oneToMany or manyToMany relationship`,
      { fieldName, type: relationship.type }
    );
  }
  /**
   * Get a related object, loading it if not already loaded
   *
   * Convenience method that checks if the relationship is loaded and
   * loads it if necessary. Automatically detects foreignKey vs oneToMany/manyToMany.
   *
   * @param fieldName - Name of the relationship field
   * @returns Promise resolving to the related object(s)
   * @example
   * ```typescript
   * // Loads customer if not already loaded
   * const customer = await order.getRelated('customerId');
   *
   * // Loads orders if not already loaded
   * const orders = await customer.getRelated('orders');
   * ```
   */
  async getRelated(fieldName) {
    if (this._loadedRelationships.has(fieldName)) {
      return this._loadedRelationships.get(fieldName);
    }
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name
    );
    const relationship = relationships.find((r) => r.fieldName === fieldName);
    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name }
      );
    }
    if (relationship.type === "foreignKey") {
      return this.loadRelated(fieldName);
    }
    return this.loadRelatedMany(fieldName);
  }
  /**
   * Get available AI-callable tools for this object
   *
   * Returns the pre-generated tool definitions from the manifest.
   * Tools are generated at build time based on the @smrt decorator's AI config.
   *
   * @returns Array of AITool definitions for LLM function calling
   * @example
   * ```typescript
   * const tools = document.getAvailableTools();
   * console.log(`${tools.length} AI-callable methods available`);
   * ```
   */
  getAvailableTools() {
    const classInfo = ObjectRegistry.getClass(this.constructor.name);
    return classInfo?.tools || [];
  }
  /**
   * Execute a tool call from AI on this object instance
   *
   * Validates the tool call against allowed methods and executes it with
   * proper error handling and timing.
   *
   * @param toolCall - Tool call from AI response
   * @returns Promise resolving to the tool call result
   * @example
   * ```typescript
   * const toolCall = {
   *   id: 'call_123',
   *   type: 'function',
   *   function: {
   *     name: 'analyze',
   *     arguments: '{"type": "detailed"}'
   *   }
   * };
   *
   * const result = await document.executeToolCall(toolCall);
   * console.log(result.success ? result.result : result.error);
   * ```
   */
  async executeToolCall(toolCall) {
    const tools = this.getAvailableTools();
    const allowedMethods = tools.map((tool) => tool.function.name);
    return executeToolCall(this, toolCall, allowedMethods);
  }
  /**
   * Remember context about this object
   *
   * Stores hierarchical context with confidence tracking for learned patterns.
   * Context is stored in the _smrt_contexts system table.
   *
   * @param options - Context options
   * @returns Promise that resolves when context is stored
   * @example
   * ```typescript
   * // Remember a discovered parsing strategy
   * await agent.remember({
   *   scope: 'discovery/parser/example.com',
   *   key: normalizedUrl,
   *   value: { patterns: ['regex1', 'regex2'] },
   *   metadata: { aiProvider: 'openai' },
   *   confidence: 0.9
   * });
   *
   * // Update an existing context entry by specifying id
   * await agent.remember({
   *   id: 'existing-context-id',
   *   scope: 'discovery/parser/example.com',
   *   key: normalizedUrl,
   *   value: { patterns: ['regex1', 'regex2', 'regex3'] },
   *   confidence: 0.95
   * });
   * ```
   */
  async remember(options) {
    if (!this.systemDb) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    const id = options.id || crypto.randomUUID();
    const now = /* @__PURE__ */ new Date();
    await this.systemDb.query(
      `INSERT OR REPLACE INTO _smrt_contexts (
        id, owner_class, owner_id, scope, key, value, metadata,
        version, confidence, created_at, updated_at, last_used_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this._className,
      this.id,
      options.scope,
      options.key,
      JSON.stringify(options.value),
      options.metadata ? JSON.stringify(options.metadata) : null,
      options.version ?? 1,
      options.confidence ?? 1,
      now,
      now,
      now,
      options.expiresAt ?? null
    );
  }
  /**
   * Recall remembered context for this object
   *
   * Retrieves context values with hierarchical search and confidence filtering.
   * Returns only the value (parsed from JSON if applicable).
   *
   * @param options - Recall options
   * @returns Promise resolving to the context value or null if not found
   * @example
   * ```typescript
   * // Recall a strategy with fallback to parent scopes
   * const strategy = await agent.recall({
   *   scope: 'discovery/parser/example.com/article',
   *   key: normalizedUrl,
   *   includeAncestors: true,
   *   minConfidence: 0.6
   * });
   * ```
   */
  async recall(options) {
    if (!this.systemDb) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    let query = `
      SELECT value, confidence
      FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ? AND scope = ? AND key = ?
    `;
    const params = [
      this._className,
      this.id,
      options.scope,
      options.key
    ];
    if (options.minConfidence !== void 0) {
      query += ` AND confidence >= ?`;
      params.push(options.minConfidence);
    }
    query += ` ORDER BY confidence DESC, version DESC LIMIT 1`;
    const result = await this.systemDb.get(query, params);
    if (result) {
      return JSON.parse(result.value);
    }
    if (options.includeAncestors) {
      const scopeParts = options.scope.split("/");
      while (scopeParts.length > 0) {
        scopeParts.pop();
        const parentScope = scopeParts.join("/") || "global";
        const parentResult = await this.recall({
          ...options,
          scope: parentScope,
          includeAncestors: false
        });
        if (parentResult) return parentResult;
      }
    }
    return null;
  }
  /**
   * Recall all remembered context for this object in a scope
   *
   * Returns a Map of key -> value for all context matching the criteria.
   * Useful for bulk retrieval of strategies or cached patterns.
   *
   * @param options - Recall options without key (returns all keys in scope)
   * @returns Promise resolving to Map of key -> value pairs
   * @example
   * ```typescript
   * // Get all strategies for a domain
   * const strategies = await agent.recallAll({
   *   scope: 'discovery/parser/example.com',
   *   minConfidence: 0.5
   * });
   *
   * for (const [url, pattern] of strategies) {
   *   console.log(`Cached pattern for ${url}:`, pattern);
   * }
   * ```
   */
  async recallAll(options = {}) {
    if (!this.systemDb) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    const results = /* @__PURE__ */ new Map();
    let query = `
      SELECT key, value, confidence
      FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ?
    `;
    const params = [this._className, this.id];
    if (options.scope) {
      if (options.includeDescendants) {
        query += ` AND (scope = ? OR scope LIKE ?)`;
        params.push(options.scope, `${options.scope}/%`);
      } else {
        query += ` AND scope = ?`;
        params.push(options.scope);
      }
    }
    if (options.minConfidence !== void 0) {
      query += ` AND confidence >= ?`;
      params.push(options.minConfidence);
    }
    query += ` ORDER BY confidence DESC`;
    const { rows } = await this.systemDb.query(query, ...params);
    for (const row of rows) {
      results.set(row.key, JSON.parse(row.value));
    }
    return results;
  }
  /**
   * Forget specific remembered context for this object
   *
   * Deletes context by scope and key. Use for invalidating cached strategies
   * or removing outdated patterns.
   *
   * @param options - Context identification (scope and key required)
   * @returns Promise that resolves when context is deleted
   * @example
   * ```typescript
   * // Remove an outdated strategy
   * await agent.forget({
   *   scope: 'discovery/parser/example.com',
   *   key: normalizedUrl
   * });
   * ```
   */
  async forget(options) {
    if (!this.systemDb) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    await this.systemDb.query(
      `DELETE FROM _smrt_contexts
       WHERE owner_class = ? AND owner_id = ? AND scope = ? AND key = ?`,
      this._className,
      this.id,
      options.scope,
      options.key
    );
  }
  /**
   * Forget all remembered context in a scope for this object
   *
   * Deletes all context matching the scope pattern. Useful for clearing
   * cached strategies for an entire domain or category.
   *
   * @param options - Scope options (scope required, includeDescendants optional)
   * @returns Promise resolving to number of contexts deleted
   * @example
   * ```typescript
   * // Clear all strategies for a domain
   * const count = await agent.forgetScope({
   *   scope: 'discovery/parser/example.com',
   *   includeDescendants: true
   * });
   * console.log(`Cleared ${count} cached strategies`);
   * ```
   */
  async forgetScope(options) {
    if (!this.systemDb) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    let query = `
      DELETE FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ?
    `;
    const params = [this._className, this.id];
    if (options.includeDescendants) {
      query += ` AND (scope = ? OR scope LIKE ?)`;
      params.push(options.scope, `${options.scope}/%`);
    } else {
      query += ` AND scope = ?`;
      params.push(options.scope);
    }
    const { rowCount } = await this.systemDb.query(query, ...params);
    return rowCount || 0;
  }
}
class Pleb extends SmrtObject {
  /**
   * Creates a new Pleb instance
   *
   * @param options - Configuration options for the Pleb object
   */
  constructor(options = {}) {
    super(options);
  }
  /**
   * Creates and initializes a new Pleb instance
   *
   * @param options - Configuration options for the Pleb object
   * @returns Promise resolving to the initialized Pleb instance
   * @example
   * ```typescript
   * const pleb = await Pleb.create({
   *   name: 'Sample Object',
   *   db: { url: 'sqlite://data.db' }
   * });
   * ```
   */
  static async create(options) {
    const pleb = new Pleb(options);
    await pleb.initialize();
    return pleb;
  }
  /**
   * Initializes the Pleb instance and sets up database connections
   *
   * @returns Promise that resolves to this instance for chaining
   */
  async initialize() {
    return await super.initialize();
  }
}
export {
  AIError,
  A as ALL_SYSTEM_TABLES,
  APIGenerator,
  CLIGenerator,
  C as CREATE_SMRT_CONTEXTS_TABLE,
  e as CREATE_SMRT_MIGRATIONS_TABLE,
  f as CREATE_SMRT_REGISTRY_TABLE,
  g as CREATE_SMRT_SIGNALS_TABLE,
  ConfigurationError,
  DatabaseError,
  ErrorUtils,
  Field,
  FilesystemError,
  MCPGenerator,
  M as ManifestGenerator,
  MetricsAdapter,
  NetworkError,
  ObjectRegistry,
  Pleb,
  PubSubAdapter,
  RuntimeError,
  h as SMRT_SCHEMA_VERSION,
  b as SignalBus,
  d as SignalSanitizer,
  SmrtClass,
  S as SmrtCollection,
  SmrtError,
  SmrtObject,
  ValidationError,
  ValidationReport,
  ValidationUtils,
  boolean,
  c as config,
  c3 as convertTypeToJsonSchema,
  a as createMCPServer,
  createRestServer,
  c2 as createSmrtClient,
  b4 as createSmrtServer,
  datetime,
  decimal,
  executeToolCall,
  executeToolCalls,
  foreignKey,
  formatToolResults,
  generateOpenAPISpec,
  a2 as generateToolFromMethod,
  b5 as generateToolManifest,
  getManifest,
  integer,
  json,
  main,
  staticManifest as manifest,
  manyToMany,
  oneToMany,
  setupSwaggerUI,
  s as shouldIncludeMethod,
  b2 as smrt,
  s2 as smrtPlugin,
  b3 as smrtRegistry,
  startRestServer,
  text,
  validateToolCall
};
//# sourceMappingURL=index.js.map
