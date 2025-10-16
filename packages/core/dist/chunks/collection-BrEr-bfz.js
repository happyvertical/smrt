import { getDatabase, buildWhere, syncSchema } from "@have/sql";
import { getAI } from "@have/ai";
import { FilesystemAdapter } from "@have/files";
import { makeId } from "@have/utils";
import { O as ObjectRegistry, c as formatDataJs, d as formatDataSql, f as fieldsFromClass, g as generateSchema, t as tableNameFromClass } from "./registry-CfuDpgvg.js";
const DEFAULT_REDACT_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "privateKey",
  "private_key",
  "authToken",
  "auth_token",
  "bearerToken",
  "bearer_token",
  "sessionId",
  "session_id",
  "ssn",
  "creditCard",
  "credit_card",
  "cvv",
  "pin"
];
class SignalSanitizer {
  config;
  constructor(config2 = {}) {
    this.config = {
      redactKeys: config2.redactKeys ?? DEFAULT_REDACT_KEYS,
      replacer: config2.replacer ?? this.defaultReplacer.bind(this),
      redactedValue: config2.redactedValue ?? "[REDACTED]",
      maxStackLines: config2.maxStackLines ?? 10
    };
  }
  /**
   * Default replacer function
   *
   * Redacts sensitive keys and truncates long strings
   */
  defaultReplacer(key, value) {
    const lowerKey = key.toLowerCase();
    if (this.config.redactKeys.some((k) => lowerKey.includes(k.toLowerCase()))) {
      return this.config.redactedValue;
    }
    if (typeof value === "string" && value.length > 1e3) {
      return `${value.substring(0, 1e3)}... [TRUNCATED]`;
    }
    return value;
  }
  /**
   * Sanitize a value using the configured replacer
   */
  sanitizeValue(value, seen = /* @__PURE__ */ new WeakSet()) {
    if (value == null) {
      return value;
    }
    if (typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "[CIRCULAR]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item, seen));
    }
    if (value instanceof Error) {
      return {
        message: value.message,
        name: value.name,
        stack: value.stack ? value.stack.split("\n").slice(0, this.config.maxStackLines).join("\n") : void 0
      };
    }
    const sanitized = {};
    for (const [key, val] of Object.entries(value)) {
      const replacedValue = this.config.replacer(key, val);
      if (replacedValue !== void 0) {
        sanitized[key] = this.sanitizeValue(replacedValue, seen);
      }
    }
    return sanitized;
  }
  /**
   * Sanitize a signal payload
   *
   * @param signal - Signal to sanitize
   * @returns Sanitized signal (new object, doesn't mutate original)
   */
  sanitize(signal) {
    return {
      id: signal.id,
      objectId: signal.objectId,
      className: signal.className,
      method: signal.method,
      type: signal.type,
      timestamp: signal.timestamp,
      ...signal.step && { step: signal.step },
      ...signal.duration !== void 0 && { duration: signal.duration },
      ...signal.args && { args: this.sanitizeValue(signal.args) },
      ...signal.result && { result: this.sanitizeValue(signal.result) },
      ...signal.error && { error: this.sanitizeValue(signal.error) },
      ...signal.metadata && { metadata: this.sanitizeValue(signal.metadata) }
    };
  }
}
class SignalBus {
  adapters = [];
  sanitizer;
  /**
   * Create a new SignalBus
   *
   * @param options - Configuration options
   */
  constructor(options) {
    if (options && options.sanitization !== false && options.sanitization) {
      this.sanitizer = new SignalSanitizer(options.sanitization);
    }
  }
  /**
   * Register a signal adapter
   *
   * @param adapter - Adapter to register
   */
  register(adapter) {
    this.adapters.push(adapter);
  }
  /**
   * Unregister a signal adapter
   *
   * Removes the adapter from the bus to prevent memory leaks.
   *
   * @param adapter - Adapter to unregister
   * @returns True if adapter was found and removed
   */
  unregister(adapter) {
    const index = this.adapters.indexOf(adapter);
    if (index !== -1) {
      this.adapters.splice(index, 1);
      return true;
    }
    return false;
  }
  /**
   * Clear all registered adapters
   *
   * Removes all adapters from the bus. Useful for cleanup or testing.
   */
  clear() {
    this.adapters = [];
  }
  /**
   * Emit a signal to all registered adapters
   *
   * Signals are sanitized (if configured) before being passed to adapters.
   * Adapters are called in fire-and-forget mode - errors are logged
   * but don't interrupt the main execution flow.
   *
   * @param signal - Signal to emit
   */
  async emit(signal) {
    const sanitizedSignal = this.sanitizer ? this.sanitizer.sanitize(signal) : signal;
    const promises = this.adapters.map(async (adapter, index) => {
      try {
        await adapter.handle(sanitizedSignal);
      } catch (error) {
        const adapterName = adapter.constructor.name !== "Object" ? adapter.constructor.name : `Adapter[${index}]`;
        console.error(`SignalBus: ${adapterName} failed to handle signal`, {
          signalId: signal.id,
          signalType: signal.type,
          className: signal.className,
          method: signal.method,
          adapterIndex: index,
          error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack
          } : error
        });
      }
    });
    void Promise.allSettled(promises);
  }
  /**
   * Generate unique execution ID for method invocations
   *
   * @returns Unique execution ID (CUID2)
   */
  generateExecutionId() {
    return makeId();
  }
  /**
   * Get count of registered adapters
   *
   * @returns Number of registered adapters
   */
  get adapterCount() {
    return this.adapters.length;
  }
}
class SmrtConfig {
  static instance;
  config = {
    logging: true
    // Default: console logging at info level
  };
  constructor() {
  }
  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!SmrtConfig.instance) {
      SmrtConfig.instance = new SmrtConfig();
    }
    return SmrtConfig.instance;
  }
  /**
   * Configure global defaults
   *
   * @param config - Configuration to apply
   */
  configure(config2) {
    this.config = { ...this.config, ...config2 };
  }
  /**
   * Get current configuration
   *
   * @returns Current global configuration
   */
  getConfig() {
    return { ...this.config };
  }
  /**
   * Reset to default configuration
   */
  reset() {
    this.config = { logging: true };
  }
}
function config(options) {
  SmrtConfig.getInstance().configure(options);
}
config.reset = () => {
  SmrtConfig.getInstance().reset();
};
config.toJSON = () => SmrtConfig.getInstance().getConfig();
config.toString = () => JSON.stringify(SmrtConfig.getInstance().getConfig(), null, 2);
const CREATE_SMRT_CONTEXTS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_contexts (
  id TEXT PRIMARY KEY,
  owner_class TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  metadata TEXT,
  version INTEGER DEFAULT 1,
  confidence REAL DEFAULT 1.0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME,
  expires_at DATETIME,
  UNIQUE(owner_class, owner_id, scope, key, version)
);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_owner
  ON _smrt_contexts(owner_class, owner_id);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_scope
  ON _smrt_contexts(scope);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_confidence
  ON _smrt_contexts(confidence);

CREATE INDEX IF NOT EXISTS idx_smrt_contexts_last_used
  ON _smrt_contexts(last_used_at);
`;
const CREATE_SMRT_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_migrations (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT,
  checksum TEXT
);
`;
const CREATE_SMRT_REGISTRY_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_registry (
  class_name TEXT PRIMARY KEY,
  schema_version TEXT,
  fields TEXT,
  relationships TEXT,
  config TEXT,
  manifest TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;
const CREATE_SMRT_SIGNALS_TABLE = `
CREATE TABLE IF NOT EXISTS _smrt_signals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source_class TEXT,
  source_id TEXT,
  target_class TEXT,
  target_id TEXT,
  payload TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smrt_signals_source
  ON _smrt_signals(source_class, source_id);

CREATE INDEX IF NOT EXISTS idx_smrt_signals_type
  ON _smrt_signals(type);

CREATE INDEX IF NOT EXISTS idx_smrt_signals_timestamp
  ON _smrt_signals(timestamp);
`;
const ALL_SYSTEM_TABLES = [
  CREATE_SMRT_CONTEXTS_TABLE,
  CREATE_SMRT_MIGRATIONS_TABLE,
  CREATE_SMRT_REGISTRY_TABLE,
  CREATE_SMRT_SIGNALS_TABLE
];
const SMRT_SCHEMA_VERSION = "1.0.0";
class SmrtClass {
  /**
   * AI client instance for interacting with AI models
   */
  _ai;
  /**
   * Filesystem adapter for file operations
   */
  _fs;
  /**
   * Database interface for data persistence
   */
  _db;
  /**
   * Class name used for identification
   */
  _className;
  /**
   * Signal bus for method execution tracking
   */
  _signalBus;
  /**
   * Adapters registered by this instance (for cleanup)
   */
  _registeredAdapters = [];
  /**
   * Configuration options provided to the class
   */
  options;
  /**
   * Track which databases have had system tables initialized
   * Key is database connection identifier
   */
  static _systemTablesInitialized = /* @__PURE__ */ new Set();
  /**
   * Creates a new SmrtClass instance
   *
   * @param options - Configuration options for database, filesystem, and AI clients
   */
  constructor(options = {}) {
    this.options = options;
    this._className = this.constructor.name;
  }
  /**
   * Initializes database, filesystem, and AI client connections
   *
   * This method sets up all required services based on the provided options.
   * It should be called before using any of the service interfaces.
   *
   * @returns Promise that resolves to this instance for chaining
   */
  async initialize() {
    if (this.options.db) {
      if (typeof this.options.db === "string") {
        this._db = await getDatabase({ url: this.options.db });
      } else if ("query" in this.options.db) {
        this._db = this.options.db;
      } else {
        this._db = await getDatabase(this.options.db);
      }
      await this.ensureSystemTables();
    }
    if (this.options.fs) {
      this._fs = await FilesystemAdapter.create(this.options.fs);
    }
    if (this.options.ai) {
      this._ai = await getAI(this.options.ai);
    }
    await this.initializeSignals();
    return this;
  }
  /**
   * Ensure SMRT system tables exist in the database
   *
   * System tables use _smrt_ prefix and store framework metadata:
   * - _smrt_contexts: Context memory storage for remembered patterns
   * - _smrt_migrations: Schema version tracking
   * - _smrt_registry: Object registry persistence
   * - _smrt_signals: Signal history/audit log
   *
   * This method is idempotent and safe to call multiple times.
   * Tables are only created once per database connection.
   */
  async ensureSystemTables() {
    if (!this._db) return;
    const dbKey = this.getDatabaseKey();
    if (SmrtClass._systemTablesInitialized.has(dbKey)) {
      return;
    }
    for (const createTableSQL of ALL_SYSTEM_TABLES) {
      await this._db.query(createTableSQL);
    }
    const id = crypto.randomUUID();
    const version = SMRT_SCHEMA_VERSION;
    const description = "Initial SMRT system tables";
    await this._db.execute`
      INSERT OR IGNORE INTO _smrt_migrations (id, version, description)
      VALUES (${id}, ${version}, ${description})
    `;
    SmrtClass._systemTablesInitialized.add(dbKey);
  }
  /**
   * Generate unique identifier for database connection
   * Used to track which databases have system tables initialized
   */
  getDatabaseKey() {
    if (!this.options.db) {
      return "default";
    }
    if (typeof this.options.db === "string") {
      return `sqlite:${this.options.db}`;
    }
    if ("query" in this.options.db) {
      return "instance:database";
    }
    const dbUrl = this.options.db.url || "default";
    const dbType = this.options.db.type || "sqlite";
    return `${dbType}:${dbUrl}`;
  }
  /**
   * Access system tables through standard database interface
   * System tables use _smrt_ prefix to avoid conflicts with user tables
   */
  get systemDb() {
    return this._db;
  }
  /**
   * Initialize signal bus and adapters
   *
   * Merges global configuration with instance-specific overrides.
   * Registers built-in and custom adapters based on configuration.
   */
  async initializeSignals() {
    const globalConfig = config.toJSON();
    const effectiveConfig = this.mergeSignalConfig(globalConfig);
    if (this.options.signals?.bus) {
      this._signalBus = this.options.signals.bus;
      return;
    }
    if (!this.shouldInitializeSignals(effectiveConfig)) {
      return;
    }
    this._signalBus = new SignalBus({
      sanitization: effectiveConfig.sanitization
    });
    await this.registerAdapters(effectiveConfig);
  }
  /**
   * Merge global and instance signal configuration
   *
   * Instance configuration takes priority over global defaults.
   *
   * @param globalConfig - Global configuration from smrt.configure()
   * @returns Merged configuration
   */
  mergeSignalConfig(globalConfig) {
    return {
      logging: this.options.logging ?? globalConfig.logging,
      metrics: this.options.metrics ?? globalConfig.metrics,
      pubsub: this.options.pubsub ?? globalConfig.pubsub,
      sanitization: this.options.sanitization ?? globalConfig.sanitization,
      signals: {
        bus: this.options.signals?.bus ?? globalConfig.signals?.bus,
        adapters: [
          ...globalConfig.signals?.adapters ?? [],
          ...this.options.signals?.adapters ?? []
        ]
      }
    };
  }
  /**
   * Check if signals should be initialized
   *
   * Signals are initialized if any adapter is configured.
   *
   * @param config - Effective signal configuration
   * @returns True if signals should be initialized
   */
  shouldInitializeSignals(config2) {
    return !!(config2.logging !== false || config2.metrics?.enabled || config2.pubsub?.enabled || config2.signals?.adapters?.length);
  }
  /**
   * Register signal adapters based on configuration
   *
   * @param config - Effective signal configuration
   */
  async registerAdapters(config2) {
    if (!this._signalBus) return;
    if (config2.logging !== false) {
      const { createLogger, LoggerAdapter } = await import("@have/logger");
      const logger = createLogger(config2.logging ?? true);
      const adapter = new LoggerAdapter(logger);
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }
    if (config2.metrics?.enabled) {
      const { MetricsAdapter } = await import("./metrics-JaU-tpt3.js");
      const adapter = new MetricsAdapter();
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }
    if (config2.pubsub?.enabled) {
      const { PubSubAdapter } = await import("./pubsub-BJ1ZU6QU.js");
      const adapter = new PubSubAdapter();
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }
    if (config2.signals?.adapters) {
      for (const adapter of config2.signals.adapters) {
        this._signalBus.register(adapter);
        this._registeredAdapters.push(adapter);
      }
    }
  }
  /**
   * Gets the filesystem adapter instance
   */
  get fs() {
    return this._fs;
  }
  /**
   * Gets the database interface instance
   */
  get db() {
    return this._db;
  }
  /**
   * Gets the AI client instance
   */
  get ai() {
    return this._ai;
  }
  /**
   * Gets the signal bus instance
   *
   * @returns Signal bus if signals are enabled, undefined otherwise
   */
  get signalBus() {
    return this._signalBus;
  }
  /**
   * Cleanup method to prevent memory leaks
   *
   * Unregisters all adapters from the signal bus that were registered
   * by this instance. Call this when the SmrtClass instance is no longer
   * needed to prevent memory leaks.
   *
   * @example
   * ```typescript
   * const product = new Product({ name: 'Widget' });
   * await product.initialize();
   * // ... use product ...
   * product.destroy(); // Clean up when done
   * ```
   */
  destroy() {
    if (this._signalBus && !this.options.signals?.bus) {
      for (const adapter of this._registeredAdapters) {
        this._signalBus.unregister(adapter);
      }
      this._registeredAdapters = [];
    }
  }
}
class SmrtCollection extends SmrtClass {
  /**
   * Promise tracking the database setup operation
   */
  _db_setup_promise = null;
  /**
   * Gets the class constructor for items in this collection
   */
  get _itemClass() {
    const ctor = this.constructor;
    if (!ctor._itemClass) {
      const className = this.constructor.name;
      const errorMessage = [
        `Collection "${className}" must define a static _itemClass property.`,
        "",
        "Example:",
        `  class ${className} extends SmrtCollection<YourItemClass> {`,
        "    static readonly _itemClass = YourItemClass;",
        "  }",
        "",
        "Make sure your item class is imported and defined before the collection class."
      ].join("\n");
      throw new Error(errorMessage);
    }
    return ctor._itemClass;
  }
  /**
   * Static reference to the item class constructor
   */
  static _itemClass;
  /**
   * Validates that the collection is properly configured
   * Call this during development to catch configuration issues early
   */
  static validate() {
    if (!SmrtCollection._itemClass) {
      const className = SmrtCollection.name;
      const errorMessage = [
        `Collection "${className}" is missing required static _itemClass property.`,
        "",
        "Fix by adding:",
        `  class ${className} extends SmrtCollection<YourItemClass> {`,
        "    static readonly _itemClass = YourItemClass;",
        "  }"
      ].join("\n");
      throw new Error(errorMessage);
    }
    if (typeof SmrtCollection._itemClass !== "function") {
      throw new Error(
        `Collection "${SmrtCollection.name}"._itemClass must be a constructor function`
      );
    }
    const hasCreateMethod = typeof SmrtCollection._itemClass.create === "function" || typeof SmrtCollection._itemClass.prototype?.create === "function";
    if (!hasCreateMethod) {
      console.warn(
        `Collection "${SmrtCollection.name}"._itemClass should have a create() method for optimal functionality`
      );
    }
  }
  /**
   * Database table name for this collection
   */
  _tableName;
  /**
   * Creates a new SmrtCollection instance
   *
   * @deprecated Use the static create() factory method instead
   * @param options - Configuration options
   */
  constructor(options = {}) {
    super(options);
    if (this.constructor !== SmrtCollection && this.constructor._itemClass) {
      const itemClassName = this.constructor._itemClass.name;
      ObjectRegistry.registerCollection(itemClassName, this.constructor);
    }
  }
  /**
   * Static factory method for creating fully initialized collection instances
   *
   * This is the recommended way to create collections. It accepts broad option types
   * (SmrtClassOptions) and handles option extraction internally, then returns a
   * fully initialized, ready-to-use collection instance.
   *
   * TypeScript Note: Uses InstanceType<T> to preserve subclass types through the
   * static factory method, ensuring custom collection methods are properly typed.
   *
   * @param options - Configuration options (accepts both SmrtClassOptions and SmrtCollectionOptions)
   * @returns Promise resolving to a fully initialized collection instance
   *
   * @example
   * ```typescript
   * // Create collection from object options
   * const collection = await ProductCollection.create(smrtObject.options);
   *
   * // Create collection with specific config
   * const collection = await ProductCollection.create({
   *   persistence: { type: 'sql', url: 'products.db' },
   *   ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
   * });
   * ```
   */
  static async create(options = {}) {
    const {
      _className,
      db,
      ai,
      fs,
      logging,
      metrics,
      pubsub,
      sanitization,
      signals
    } = options;
    const collectionOptions = {
      _className,
      db,
      ai,
      fs,
      logging,
      metrics,
      pubsub,
      sanitization,
      signals
    };
    const instance = new this(collectionOptions);
    await instance.initialize();
    return instance;
  }
  /**
   * Initializes the collection, setting up database tables
   *
   * @returns Promise that resolves to this instance for chaining
   */
  async initialize() {
    await super.initialize();
    if (this.options.db) {
      await this.setupDb();
    }
    return this;
  }
  /**
   * Retrieves a single object from the collection by ID, slug, or custom filter
   *
   * @param filter - String ID/slug or object with filter conditions
   * @returns Promise resolving to the object or null if not found
   */
  async get(filter) {
    const where = typeof filter === "string" ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      filter
    ) ? { id: filter } : { slug: filter, context: "" } : filter;
    const { sql: whereSql, values: whereValues } = buildWhere(where);
    const { rows } = await this.db.query(
      `SELECT * FROM ${this.tableName} ${whereSql}`,
      whereValues
    );
    if (!rows?.[0]) {
      return null;
    }
    return this.create(formatDataJs(rows[0]));
  }
  /**
   * Lists records from the collection with flexible filtering options
   *
   * @param options - Query options object
   * @param options.where - Record of conditions to filter results. Each key can include an operator
   *                      separated by a space (e.g., 'price >', 'name like'). Default operator is '='.
   * @param options.offset - Number of records to skip
   * @param options.limit - Maximum number of records to return
   * @param options.orderBy - Field(s) to order results by, with optional direction
   *
   * @example
   * ```typescript
   * // Find active products priced between $100-$200
   * await collection.list({
   *   where: {
   *     'price >': 100,
   *     'price <=': 200,
   *     'status': 'active',              // equals operator is default
   *     'category in': ['A', 'B', 'C'],  // IN operator for arrays
   *     'name like': '%shirt%',          // LIKE for pattern matching
   *     'deleted_at !=': null            // exclude deleted items
   *   },
   *   limit: 10,
   *   offset: 0
   * });
   *
   * // Find users matching pattern but not in specific roles
   * await users.list({
   *   where: {
   *     'email like': '%@company.com',
   *     'active': true,
   *     'role in': ['guest', 'blocked'],
   *     'last_login <': lastMonth
   *   }
   * });
   * ```
   *
   * @returns Promise resolving to an array of model instances
   */
  async list(options) {
    const { where, offset, limit, orderBy } = options;
    const { sql: whereSql, values: whereValues } = buildWhere(where || {});
    let orderBySql = "";
    if (orderBy) {
      orderBySql = " ORDER BY ";
      const orderByItems = Array.isArray(orderBy) ? orderBy : [orderBy];
      orderBySql += orderByItems.map((item) => {
        const [field, direction = "ASC"] = item.split(" ");
        if (!/^[a-zA-Z0-9_]+$/.test(field)) {
          throw new Error(`Invalid field name for ordering: ${field}`);
        }
        const normalizedDirection = direction.toUpperCase();
        if (normalizedDirection !== "ASC" && normalizedDirection !== "DESC") {
          throw new Error(
            `Invalid sort direction: ${direction}. Must be ASC or DESC.`
          );
        }
        return `${field} ${normalizedDirection}`;
      }).join(", ");
    }
    let limitOffsetSql = "";
    const limitOffsetValues = [];
    if (limit !== void 0) {
      limitOffsetSql += " LIMIT ?";
      limitOffsetValues.push(limit);
    }
    if (offset !== void 0) {
      limitOffsetSql += " OFFSET ?";
      limitOffsetValues.push(offset);
    }
    const result = await this.db.query(
      `SELECT * FROM ${this.tableName} ${whereSql} ${orderBySql} ${limitOffsetSql}`,
      [...whereValues, ...limitOffsetValues]
    );
    const instances = await Promise.all(
      result.rows.map((item) => this.create(formatDataJs(item)))
    );
    if (options.include && options.include.length > 0) {
      await this.eagerLoadRelationships(instances, options.include);
    }
    return instances;
  }
  /**
   * Eagerly load relationships for a collection of instances
   *
   * Optimizes loading by batching queries for foreignKey relationships to avoid N+1 queries.
   *
   * @param instances - Array of object instances to load relationships for
   * @param relationships - Array of relationship field names to load
   * @private
   */
  async eagerLoadRelationships(instances, relationships) {
    if (instances.length === 0) return;
    for (const fieldName of relationships) {
      const relationshipMeta = ObjectRegistry.getRelationships(
        this._itemClass.name
      );
      const relationship = relationshipMeta.find(
        (r) => r.fieldName === fieldName
      );
      if (!relationship) {
        console.warn(
          `Relationship ${fieldName} not found on ${this._itemClass.name}, skipping eager load`
        );
        continue;
      }
      if (relationship.type === "foreignKey") {
        await this.batchLoadForeignKeys(instances, fieldName, relationship);
      } else if (relationship.type === "oneToMany") {
        await this.batchLoadOneToMany(instances, fieldName, relationship);
      } else if (relationship.type === "manyToMany") {
        console.warn(
          `manyToMany eager loading not yet implemented for ${fieldName}`
        );
      }
    }
  }
  /**
   * Batch load foreignKey relationships to avoid N+1 queries
   *
   * @param instances - Instances to load relationships for
   * @param fieldName - Name of the foreignKey field
   * @param relationship - Relationship metadata
   * @private
   */
  async batchLoadForeignKeys(instances, fieldName, relationship) {
    const foreignKeyValues = /* @__PURE__ */ new Set();
    for (const instance of instances) {
      const value = instance[fieldName];
      if (value && typeof value === "string") {
        foreignKeyValues.add(value);
      }
    }
    if (foreignKeyValues.size === 0) return;
    let targetCollection;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options
      );
    } catch (error) {
      console.warn(
        `Could not get collection for ${relationship.targetClass}:`,
        error
      );
      return;
    }
    const relatedObjects = await targetCollection.list({
      where: { "id in": Array.from(foreignKeyValues) }
    });
    const relatedMap = /* @__PURE__ */ new Map();
    for (const obj of relatedObjects) {
      relatedMap.set(obj.id, obj);
    }
    for (const instance of instances) {
      const foreignKeyValue = instance[fieldName];
      if (foreignKeyValue && typeof foreignKeyValue === "string") {
        const relatedObject = relatedMap.get(foreignKeyValue);
        if (relatedObject) {
          instance._loadedRelationships.set(fieldName, relatedObject);
        }
      }
    }
  }
  /**
   * Batch load oneToMany relationships
   *
   * @param instances - Instances to load relationships for
   * @param fieldName - Name of the oneToMany field
   * @param relationship - Relationship metadata
   * @private
   */
  async batchLoadOneToMany(instances, fieldName, relationship) {
    const inverseRelationships = ObjectRegistry.getInverseRelationships(
      this._itemClass.name
    );
    const inverseForeignKey = inverseRelationships.find(
      (r) => r.sourceClass === relationship.targetClass && r.type === "foreignKey" && r.targetClass === this._itemClass.name
    );
    if (!inverseForeignKey) {
      console.warn(
        `Could not find inverse foreignKey for oneToMany ${fieldName}`
      );
      return;
    }
    const instanceIds = instances.map((i) => i.id).filter((id) => !!id);
    if (instanceIds.length === 0) return;
    let targetCollection;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options
      );
    } catch (error) {
      console.warn(
        `Could not get collection for ${relationship.targetClass}:`,
        error
      );
      return;
    }
    const relatedObjects = await targetCollection.list({
      where: { [`${inverseForeignKey.fieldName} in`]: instanceIds }
    });
    const relatedMap = /* @__PURE__ */ new Map();
    for (const obj of relatedObjects) {
      const foreignKeyValue = obj[inverseForeignKey.fieldName];
      if (!relatedMap.has(foreignKeyValue)) {
        relatedMap.set(foreignKeyValue, []);
      }
      relatedMap.get(foreignKeyValue)?.push(obj);
    }
    for (const instance of instances) {
      const relatedArray = relatedMap.get(instance.id) || [];
      instance._loadedRelationships.set(fieldName, relatedArray);
    }
  }
  /**
   * Creates a new instance of the collection's item class
   *
   * @param options - Options for creating the item
   * @returns New item instance
   */
  async create(options) {
    const params = {
      ai: this.options.ai,
      db: this.options.db,
      _skipLoad: true,
      // Don't try to load from DB - this is a new object
      ...options
    };
    const instance = new this._itemClass(params);
    await instance.initialize();
    return instance;
  }
  /**
   * Gets an existing item or creates a new one if it doesn't exist
   *
   * @param data - Object data to find or create
   * @param defaults - Default values to use if creating a new object
   * @returns Promise resolving to the existing or new object
   */
  async getOrUpsert(data, defaults = {}) {
    data = formatDataSql(data);
    let where = {};
    if (data.id) {
      where = { id: data.id };
    } else if (data.slug) {
      where = { slug: data.slug, context: data.context || "" };
    } else {
      where = data;
    }
    const existing = await this.get(where);
    if (existing) {
      const diff = this.getDiff(existing, data);
      if (diff) {
        Object.assign(existing, diff);
        await existing.save();
        return existing;
      }
      return existing;
    }
    const upsertData = { ...defaults, ...data };
    const upserted = await this.create(upsertData);
    await upserted.save();
    return upserted;
  }
  /**
   * Gets differences between an existing object and new data
   *
   * @param existing - Existing object
   * @param data - New data
   * @returns Object containing only the changed fields
   */
  getDiff(existing, data) {
    const fields = this._itemClass.prototype.getFields();
    return Object.keys(data).reduce(
      (acc, key) => {
        if (fields[key] && existing[key] !== data[key]) {
          acc[key] = data[key];
        }
        return acc;
      },
      {}
    );
  }
  /**
   * Sets up the database schema for this collection
   *
   * @returns Promise that resolves when setup is complete
   */
  async setupDb() {
    if (this._db_setup_promise) {
      return this._db_setup_promise;
    }
    this._db_setup_promise = (async () => {
      try {
        const schema = this.generateSchema();
        console.log(
          `[Collection] Generated schema for ${this.tableName}:`,
          schema
        );
        await syncSchema({ db: this.db, schema });
      } catch (error) {
        this._db_setup_promise = null;
        throw error;
      }
    })();
    return this._db_setup_promise;
  }
  /**
   * Gets field definitions for the collection's item class
   *
   * @returns Object containing field definitions
   */
  getFields() {
    return fieldsFromClass(this._itemClass);
  }
  /**
   * Generates database schema for the collection's item class
   *
   * Leverages ObjectRegistry's cached schema for instant retrieval.
   *
   * @returns Schema object for database setup
   */
  generateSchema() {
    return generateSchema(this._itemClass);
  }
  /**
   * Gets the database table name for this collection
   */
  get tableName() {
    if (!this._tableName) {
      this._tableName = tableNameFromClass(this._itemClass);
    }
    return this._tableName;
  }
  /**
   * Generates a table name from the collection class name
   *
   * @returns Generated table name
   */
  generateTableName() {
    const tableName = this._className.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/([^s])$/, "$1s").replace(/y$/, "ies");
    return tableName;
  }
  /**
   * Counts records in the collection matching the given filters
   *
   * Accepts the same where conditions as list() but ignores limit/offset/orderBy.
   *
   * @param options - Query options object
   * @param options.where - Record of conditions to filter results
   * @returns Promise resolving to the total count of matching records
   */
  async count(options = {}) {
    const { where } = options;
    const { sql: whereSql, values: whereValues } = buildWhere(where || {});
    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${whereSql}`,
      whereValues
    );
    return Number.parseInt(result.rows[0].count, 10);
  }
  /**
   * Remember collection-level context
   *
   * Stores context applicable to all instances of this collection type.
   * Use for patterns that apply to the entire collection (e.g., default parsing strategies).
   *
   * @param options - Context options
   * @returns Promise that resolves when context is stored
   * @example
   * ```typescript
   * // Remember a default parsing strategy for all documents
   * await documentCollection.remember({
   *   scope: 'parser/default',
   *   key: 'selector',
   *   value: { pattern: '.content article' },
   *   confidence: 0.8
   * });
   *
   * // Update an existing context entry by specifying id
   * await documentCollection.remember({
   *   id: 'existing-context-id',
   *   scope: 'parser/default',
   *   key: 'selector',
   *   value: { pattern: '.content main article' },
   *   confidence: 0.85
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
      this._itemClass.name,
      "__collection__",
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
   * Recall collection-level context
   *
   * Retrieves context that applies to all instances of this collection.
   *
   * @param options - Recall options
   * @returns Promise resolving to the context value or null if not found
   * @example
   * ```typescript
   * // Recall default parsing strategy
   * const strategy = await documentCollection.recall({
   *   scope: 'parser/default',
   *   key: 'selector',
   *   minConfidence: 0.5
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
      this._itemClass.name,
      "__collection__",
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
   * Recall all collection-level context in a scope
   *
   * Returns a Map of key -> value for all collection contexts matching the criteria.
   *
   * @param options - Recall options
   * @returns Promise resolving to Map of key -> value pairs
   * @example
   * ```typescript
   * // Get all default strategies
   * const strategies = await documentCollection.recallAll({
   *   scope: 'parser/default',
   *   minConfidence: 0.5
   * });
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
    const params = [this._itemClass.name, "__collection__"];
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
   * Forget collection-level context
   *
   * Deletes collection context by scope and key.
   *
   * @param options - Context identification
   * @returns Promise that resolves when context is deleted
   * @example
   * ```typescript
   * // Remove a default strategy
   * await documentCollection.forget({
   *   scope: 'parser/default',
   *   key: 'selector'
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
      this._itemClass.name,
      "__collection__",
      options.scope,
      options.key
    );
  }
  /**
   * Forget all collection-level context in a scope
   *
   * Deletes all collection contexts matching the scope pattern.
   *
   * @param options - Scope options
   * @returns Promise resolving to number of contexts deleted
   * @example
   * ```typescript
   * // Clear all default strategies
   * const count = await documentCollection.forgetScope({
   *   scope: 'parser/default',
   *   includeDescendants: true
   * });
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
    const params = [this._itemClass.name, "__collection__"];
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
const collection = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null,
  SmrtCollection
}, Symbol.toStringTag, { value: "Module" }));
export {
  ALL_SYSTEM_TABLES as A,
  CREATE_SMRT_CONTEXTS_TABLE as C,
  SmrtCollection as S,
  SmrtClass as a,
  SignalBus as b,
  config as c,
  SignalSanitizer as d,
  CREATE_SMRT_MIGRATIONS_TABLE as e,
  CREATE_SMRT_REGISTRY_TABLE as f,
  CREATE_SMRT_SIGNALS_TABLE as g,
  SMRT_SCHEMA_VERSION as h,
  collection as i
};
//# sourceMappingURL=collection-BrEr-bfz.js.map
