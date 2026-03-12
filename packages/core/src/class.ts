import type { AIClientOptions } from '@happyvertical/ai';
import { type AIClient, getAI } from '@happyvertical/ai';
import type { FilesystemAdapterOptions } from '@happyvertical/files';
import { FilesystemAdapter } from '@happyvertical/files';
import type { LoggerConfig } from '@happyvertical/logger';
import type {
  AiTokenUsage,
  AiUsageHandler,
  AiUsageListOptions,
  AiUsageSnapshot,
  AiUsageStats,
  AiUsageSummaryOptions,
  SignalAdapter,
  SmrtAiUsageEvent,
  SmrtAiUsageRecord,
} from '@happyvertical/smrt-types';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  AiUsageCollector,
  AiUsagePersistenceHandler,
} from './adapters/ai-usage.js';
import { estimateAiUsageCost } from './adapters/cost-rates.js';
import type {
  AiUsageConfig,
  GlobalSignalConfig,
  MetricsConfig,
  PubSubConfig,
} from './config.js';
import { config } from './config.js';
import type { DatabaseConfig } from './database.js';
import { SignalBus } from './signals/bus.js';
import { ALL_SYSTEM_TABLES, SMRT_SCHEMA_VERSION } from './system/schema.js';

interface ResolvedAiUsageConfig {
  enabled: boolean;
  persist: boolean;
  estimateCosts: boolean;
  costRates?: Record<string, { input: number; output: number }>;
  handlers: AiUsageHandler[];
}

function normalizeAiUsageTokens(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const promptTokens =
    typeof usage.promptTokens === 'number'
      ? usage.promptTokens
      : typeof usage.inputTokens === 'number'
        ? usage.inputTokens
        : undefined;
  const completionTokens =
    typeof usage.completionTokens === 'number'
      ? usage.completionTokens
      : typeof usage.outputTokens === 'number'
        ? usage.outputTokens
        : undefined;
  const totalTokens =
    typeof usage.totalTokens === 'number'
      ? usage.totalTokens
      : promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

function normalizeAiUsageTags(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const tags: Record<string, string> = {};
  for (const [key, tagValue] of Object.entries(value)) {
    if (tagValue === undefined || tagValue === null) continue;
    tags[key] = String(tagValue);
  }

  return Object.keys(tags).length > 0 ? tags : undefined;
}

function parseAiUsageTags(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  try {
    return normalizeAiUsageTags(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizeAiUsageTimestamp(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }

  return new Date();
}

function getQueryRows(
  result: Awaited<ReturnType<DatabaseInterface['query']>>,
): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
}

/**
 * Configuration options for the SmrtClass
 */
export interface SmrtClassOptions {
  /**
   * Optional custom class name override
   */
  _className?: string;

  /**
   * Database configuration - unified approach matching @happyvertical/sql
   *
   * Supports three formats:
   * - String shortcut: 'products.db' (auto-detects database type)
   * - Config object: { type: 'sqlite', url: 'products.db' }
   * - DatabaseInterface instance: await getDatabase(...)
   *
   * @see DatabaseConfig for type definition
   */
  db?: DatabaseConfig;

  /**
   * Alias for db option - for backward compatibility with documentation
   *
   * @deprecated Use 'db' instead. This alias exists for backward compatibility.
   */
  persistence?: DatabaseConfig;

  /**
   * Filesystem adapter configuration options
   */
  fs?: FilesystemAdapterOptions;

  /**
   * AI client configuration options or instance
   */
  ai?: AIClientOptions | AIClient;

  /**
   * AI usage tracking configuration (overrides global defaults)
   */
  usage?: AiUsageConfig;

  /**
   * Logging configuration (overrides global default)
   */
  logging?: LoggerConfig;

  /**
   * Metrics configuration (overrides global default)
   */
  metrics?: MetricsConfig;

  /**
   * Pub/Sub configuration (overrides global default)
   */
  pubsub?: PubSubConfig;

  /**
   * Sanitization configuration (overrides global default)
   */
  sanitization?: import('./config.js').GlobalSignalConfig['sanitization'];

  /**
   * Custom signal configuration (overrides global default)
   */
  signals?: {
    /** Shared signal bus instance */
    bus?: SignalBus;
    /** Additional custom adapters */
    adapters?: SignalAdapter[];
  };
}

/**
 * Foundation class providing core functionality for the SMRT framework
 *
 * SmrtClass provides unified access to database, filesystem, and AI client
 * interfaces. It serves as the foundation for all other classes in the
 * SMRT framework.
 */
export class SmrtClass {
  /**
   * AI client instance for interacting with AI models
   */
  protected _ai!: AIClient;

  /**
   * Filesystem adapter for file operations
   */
  protected _fs!: FilesystemAdapter;

  /**
   * Database interface for data persistence
   */
  protected _db!: DatabaseInterface;

  /**
   * Class name used for identification
   */
  protected _className!: string;

  /**
   * Signal bus for method execution tracking
   */
  protected _signalBus?: SignalBus;

  /**
   * Adapters registered by this instance (for cleanup)
   */
  private _registeredAdapters: SignalAdapter[] = [];

  /**
   * In-memory AI usage collector for quick inspection.
   */
  private _aiUsageCollector?: AiUsageCollector;

  /**
   * Registered AI usage handlers for this instance.
   */
  private _aiUsageHandlers: AiUsageHandler[] = [];

  /**
   * Configuration options provided to the class
   */
  public options: SmrtClassOptions;

  /**
   * Track which databases have had system tables initialized
   * - WeakSet for :memory: databases (URL not unique, track by instance)
   * - Set<string> for all others (URL is unique identifier)
   */
  private static _systemTablesInitialized = new WeakSet<DatabaseInterface>();
  private static _systemTablesInitializedByUrl = new Set<string>();

  /**
   * Creates a new SmrtClass instance
   *
   * @param options - Configuration options for database, filesystem, and AI clients
   */
  constructor(options: SmrtClassOptions = {}) {
    this.options = options;
    this._className = this.constructor.name;
  }

  /**
   * Determines whether this class requires a database to function
   *
   * Override this method in subclasses that require database access
   * to enable early validation during initialization.
   *
   * @returns True if database is required, false otherwise
   * @example
   * ```typescript
   * class MyDataModel extends SmrtClass {
   *   protected requiresDatabase(): boolean {
   *     return true; // This class needs database access
   *   }
   * }
   * ```
   */
  protected requiresDatabase(): boolean {
    return false; // Base class doesn't require database by default
  }

  /**
   * Initializes database, filesystem, and AI client connections
   *
   * This method sets up all required services based on the provided options.
   * It should be called before using any of the service interfaces.
   *
   * @returns Promise that resolves to this instance for chaining
   * @throws {Error} If database is required but not provided in options
   */
  protected async initialize(): Promise<this> {
    // Map persistence to db for backward compatibility
    if (this.options.persistence && !this.options.db) {
      this.options.db = this.options.persistence;
    }

    // Validate database configuration if required
    if (this.requiresDatabase() && !this.options.db) {
      throw new Error(
        `${this._className} requires a database configuration. ` +
          `Please provide 'db' in options: { db: { url: '...' } } or { db: 'database.db' }`,
      );
    }

    if (this.options.db) {
      // Pass schemas as a lazy function so adapters that don't need them
      // (Postgres, SQLite — they manage tables via migrations) never pay the
      // cost of iterating 200+ classes and generating DDL.  Only JSON and
      // DuckDB adapters call the function.  This eliminates ~2s of CPU work
      // per Collection.create() call on large registries (issue #970).
      const { ObjectRegistry } = await import('./registry.js');
      const schemas = () => ObjectRegistry.getAllSchemas();

      // Handle four db config formats (in implementation order):
      // 1. String URL: 'products.db' (shortcut)
      // 2. DatabaseInterface instance: already initialized db (has 'query' method)
      // 3. Config with client: { type: 'postgres', client: pgPool } (SvelteKit pattern)
      // 4. Config object: { type: 'sqlite', url: 'products.db' }
      if (typeof this.options.db === 'string') {
        // Format 1: String shortcut - let getDatabase auto-detect type from URL
        // Pass dbid for connection caching (JSON adapter requires dbid when schemas provided)
        // EXCEPT for :memory: databases which should NOT be cached across instances
        const isMemoryDb = this.options.db === ':memory:';
        this._db = await getDatabase({
          url: this.options.db,
          schemas,
          ...(isMemoryDb ? {} : { dbid: `smrt:${this.options.db}` }),
        });
      } else if ('query' in this.options.db) {
        // Format 2: Already a DatabaseInterface instance - return as-is
        this._db = this.options.db as DatabaseInterface;
      } else if ('client' in this.options.db && this.options.db.client) {
        // Format 3: Config with pre-created client (e.g., from SvelteKit's $env-based connection)
        // Pass the client to getDatabase which will use it instead of creating a new connection
        const dbConfig = this.options.db as {
          type?: string;
          client: unknown;
          url?: string;
        };
        this._db = await getDatabase({
          type: dbConfig.type || 'postgres',
          client: dbConfig.client,
          url: dbConfig.url,
          schemas,
        } as any);
      } else {
        // Format 4: Config object - pass to getDatabase (handles all types uniformly)
        // Pass dbid for connection caching (JSON adapter requires dbid when schemas provided)
        // EXCEPT for :memory: databases which should NOT be cached across instances
        const dbConfig = this.options.db as { url?: string; type?: string };
        const dbUrl = dbConfig.url || 'memory';
        const isMemoryDb = dbUrl === ':memory:' || dbUrl === 'memory';
        this._db = await getDatabase({
          ...this.options.db,
          schemas,
          ...(isMemoryDb ? {} : { dbid: `smrt:${dbUrl}` }),
        } as any);
      }

      /**
       * INTENTIONAL MUTATION: After resolving the database config,
       * we replace options.db with the actual DatabaseInterface instance.
       * This enables child objects to share the same connection via:
       *
       *   const child = new ChildObject({ db: parent.options.db });
       *
       * Without this, passing this.options to getCollection() would use the config object
       * which causes a NEW db instance to be created, losing data isolation.
       *
       * See issue #567 for context on why this pattern is necessary.
       */
      this.options.db = this._db;

      // For JSON adapter, ensure ALL tables exist upfront (issue #603).
      // JSON adapter loads tables on-demand which causes issues with cross-table
      // queries (JOINs, NOT EXISTS subqueries). Unlike SQLite/Postgres where all
      // tables exist in the database file, JSON needs explicit table creation.
      // Detection: JSON adapter has exportTable method (see schema-manager.ts:50-54)
      if ((this._db as any).exportTable) {
        const { ensureSchema } = await import('./schema/utils.js');
        const classNames = ObjectRegistry.getClassNames();
        for (const className of classNames) {
          const registered = ObjectRegistry.getClass(className);
          if (registered?.extends === 'SmrtCollection') continue;
          try {
            await ensureSchema(this._db, className);
          } catch {
            // Non-critical: some classes may not have schemas yet
          }
        }
      }

      await this.ensureSystemTables();
    }
    if (this.options.fs) {
      this._fs = await FilesystemAdapter.create(this.options.fs);
    }

    // Initialize AI client with environment variable support
    // Priority: instance options > env vars > global config > defaults
    const globalConfig = config.toJSON();
    const usageConfig = this.mergeAiUsageConfig(globalConfig);
    this.initializeAiUsageHandlers(usageConfig);

    if (this.options.ai || globalConfig.ai || process.env.SMRT_AI_PROVIDER) {
      // Check if options.ai is already a client-like object with embed method
      // This allows passing mock AI clients for testing
      const aiOption = this.options.ai as Record<string, unknown> | undefined;
      if (
        aiOption &&
        typeof aiOption === 'object' &&
        typeof aiOption.embed === 'function' &&
        !aiOption.provider
      ) {
        this._ai = aiOption as unknown as AIClient;
      } else {
        const { loadEnvConfig } = await import('@happyvertical/utils');

        // Start with global defaults
        const baseConfig = globalConfig.ai || {};

        // Merge with instance options (takes priority over global)
        const userConfig = { ...baseConfig, ...this.options.ai };

        // Load environment variables and merge (user options take priority)
        const aiConfig = loadEnvConfig<any>(userConfig, {
          packageName: 'ai',
          prefix: 'SMRT',
          schema: {
            provider: 'string',
            model: 'string',
            apiKey: 'string',
            timeout: 'number',
            maxRetries: 'number',
            temperature: 'number',
            maxTokens: 'number',
          },
        });

        const existingOnUsage =
          aiConfig.onUsage ??
          (userConfig as Record<string, unknown>).onUsage ??
          undefined;
        aiConfig.onUsage = async (...args: unknown[]) => {
          if (typeof existingOnUsage === 'function') {
            await (existingOnUsage as (...callbackArgs: unknown[]) => unknown)(
              ...args,
            );
          }
          await this.handleAiUsageCallback(args[0], aiConfig, usageConfig);
        };

        // Only initialize if we have a provider configured
        if (aiConfig.provider || aiConfig.type || aiConfig.apiKey) {
          // Use getAI() factory to support all AI providers (OpenAI, Anthropic, Gemini, etc.)
          // getAI() returns AIInterface, which we cast to AIClient for backward compatibility
          this._ai = (await getAI(aiConfig as any)) as any as AIClient;
        }
      }
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
  private async ensureSystemTables(): Promise<void> {
    if (!this._db) return;

    const dbUrl = this._db.url;

    // Some databases share URLs but are different instances:
    // - :memory: databases (SQLite/DuckDB in-memory)
    // - JSON databases (may have undefined or shared URLs)
    // - Any database with undefined URL
    // Use WeakSet for instance tracking, Set<string> for URL tracking
    const dbConstructorName = this._db.constructor?.name || '';
    const isMemoryDb = dbUrl === ':memory:';
    const isJsonDb = dbConstructorName.toLowerCase().includes('json');
    const hasUndefinedUrl = !dbUrl;
    const useInstanceTracking = isMemoryDb || isJsonDb || hasUndefinedUrl;

    if (useInstanceTracking) {
      // Check WeakSet for databases that may share URLs (track by instance)
      if (SmrtClass._systemTablesInitialized.has(this._db)) {
        return;
      }
    } else {
      // Check Set<string> for URL-based databases (track by URL)
      if (SmrtClass._systemTablesInitializedByUrl.has(dbUrl)) {
        return;
      }
    }

    try {
      // Fast path: check if system tables already exist by querying _smrt_migrations.
      // This avoids 29 sequential DDL round-trips on high-latency connections
      // (e.g. remote Postgres over Tailscale where each round-trip is ~650ms).
      // If the migrations table doesn't exist, the query will throw and we fall
      // through to the full DDL path.
      const version = SMRT_SCHEMA_VERSION;
      try {
        const rows = await this._db.query(
          `SELECT 1 FROM _smrt_migrations WHERE version = '${version}' LIMIT 1`,
        );
        if (rows && (Array.isArray(rows) ? rows.length > 0 : true)) {
          // System tables already at current version — skip DDL
          if (useInstanceTracking) {
            SmrtClass._systemTablesInitialized.add(this._db);
          } else {
            SmrtClass._systemTablesInitializedByUrl.add(dbUrl);
          }
          return;
        }
      } catch {
        // _smrt_migrations doesn't exist yet — fall through to create everything
      }

      // Create all system tables
      // Split multi-statement SQL into individual statements to avoid race conditions
      // Each ALL_SYSTEM_TABLES entry contains CREATE TABLE + CREATE INDEX statements
      const allStatements: string[] = [];
      for (const multiStatementSQL of ALL_SYSTEM_TABLES) {
        // Split on semicolon, filter out empty statements
        const statements = multiStatementSQL
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        allStatements.push(...statements);
      }

      // Use db.query() for system tables — they use CREATE TABLE/INDEX IF NOT EXISTS
      // which databases handle natively in a single round-trip. The syncSchema()
      // approach does per-column existence checks (multiple round-trips per table)
      // which is unnecessary for framework-owned system tables and extremely slow
      // on high-latency connections (e.g. remote postgres over Tailscale).
      for (const statement of allStatements) {
        await this._db.query(statement);
      }

      // Record current schema version
      // Use ON CONFLICT for DuckDB compatibility (not INSERT OR IGNORE)
      const id = crypto.randomUUID();
      const description = 'Initial SMRT system tables';
      await this._db.execute`
        INSERT INTO _smrt_migrations (id, version, description)
        VALUES (${id}, ${version}, ${description})
        ON CONFLICT(version) DO NOTHING
      `;

      // Initialize native vector storage if configured
      try {
        const { ObjectRegistry } = await import('./registry.js');
        const embeddingConfig = ObjectRegistry.getProjectEmbeddingConfig();
        if (embeddingConfig?.storage === 'native') {
          const { EmbeddingStorage } = await import('./embeddings/storage.js');
          const vector = this._db.vector;
          if (vector) {
            const dimensions = embeddingConfig.dimensions || 768;
            await EmbeddingStorage.ensureVectorStorage(
              this._db,
              dimensions,
              vector,
            );
          } else {
            console.warn(
              '[smrt] Embedding storage set to "native" but database has no vector capability. Falling back to JSON storage.',
            );
          }
        }
      } catch (error) {
        // Don't fail system table initialization for vector setup errors
        console.warn(
          `[smrt] Failed to initialize vector storage: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Mark as initialized using appropriate tracking mechanism
      if (useInstanceTracking) {
        SmrtClass._systemTablesInitialized.add(this._db);
      } else {
        SmrtClass._systemTablesInitializedByUrl.add(dbUrl);
      }
    } catch (error) {
      // DO NOT SWALLOW ERRORS - fail loudly so we know what's wrong
      const dbInfo = this._db.constructor?.name || 'unknown database';
      throw new Error(
        `Failed to create system tables for ${dbInfo}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * Access system tables through standard database interface
   * System tables use _smrt_ prefix to avoid conflicts with user tables
   */
  protected get systemDb(): DatabaseInterface {
    return this._db;
  }

  /**
   * Initialize signal bus and adapters
   *
   * Merges global configuration with instance-specific overrides.
   * Registers built-in and custom adapters based on configuration.
   */
  private async initializeSignals(): Promise<void> {
    const globalConfig = config.toJSON();
    const effectiveConfig = this.mergeSignalConfig(globalConfig);

    // If a shared bus is provided, always use it (don't create new adapters)
    if (this.options.signals?.bus) {
      this._signalBus = this.options.signals.bus;
      return;
    }

    // Otherwise, check if we should initialize signals based on config
    if (!this.shouldInitializeSignals(effectiveConfig)) {
      return;
    }

    this._signalBus = new SignalBus({
      sanitization: effectiveConfig.sanitization,
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
  private mergeSignalConfig(
    globalConfig: GlobalSignalConfig,
  ): GlobalSignalConfig {
    return {
      logging: this.options.logging ?? globalConfig.logging,
      metrics: this.options.metrics ?? globalConfig.metrics,
      pubsub: this.options.pubsub ?? globalConfig.pubsub,
      usage: this.mergeAiUsageConfig(globalConfig),
      sanitization: this.options.sanitization ?? globalConfig.sanitization,
      signals: {
        bus: this.options.signals?.bus ?? globalConfig.signals?.bus,
        adapters: [
          ...(globalConfig.signals?.adapters ?? []),
          ...(this.options.signals?.adapters ?? []),
        ],
      },
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
  private shouldInitializeSignals(config: GlobalSignalConfig): boolean {
    return !!(
      config.logging !== false ||
      config.metrics?.enabled ||
      config.pubsub?.enabled ||
      config.signals?.adapters?.length
    );
  }

  /**
   * Register signal adapters based on configuration
   *
   * @param config - Effective signal configuration
   */
  private async registerAdapters(config: GlobalSignalConfig): Promise<void> {
    if (!this._signalBus) return;

    // Logging adapter (default: enabled with console)
    if (config.logging !== false) {
      const { createLogger, LoggerAdapter } = await import(
        '@happyvertical/logger'
      );
      const logger = createLogger(config.logging ?? true);
      const adapter = new LoggerAdapter(logger);
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }

    // Metrics adapter (default: disabled)
    if (config.metrics?.enabled) {
      const { MetricsAdapter } = await import('./adapters/metrics.js');
      const adapter = new MetricsAdapter();
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }

    // Pub/Sub adapter (default: disabled)
    if (config.pubsub?.enabled) {
      const { PubSubAdapter } = await import('./adapters/pubsub.js');
      const adapter = new PubSubAdapter();
      this._signalBus.register(adapter);
      this._registeredAdapters.push(adapter);
    }

    // Custom adapters
    if (config.signals?.adapters) {
      for (const adapter of config.signals.adapters) {
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
    // Throw helpful error if database is accessed before initialization
    if (!this._db) {
      throw new Error(
        `Database accessed before initialization. ` +
          `Please call await instance.initialize() before accessing the database.`,
      );
    }
    return this._db;
  }

  /**
   * Gets the AI client instance
   */
  get ai() {
    return this._ai;
  }

  /**
   * Get the in-memory AI usage snapshot for this instance.
   */
  getAiUsageSnapshot(): AiUsageSnapshot | undefined {
    return this._aiUsageCollector?.getSnapshot();
  }

  /**
   * Reset the in-memory AI usage collector.
   */
  resetAiUsage(): void {
    this._aiUsageCollector?.reset();
  }

  /**
   * List persisted AI usage records.
   */
  async listAiUsage(
    options: AiUsageListOptions = {},
  ): Promise<SmrtAiUsageRecord[]> {
    if (!this._db) {
      throw new Error(
        `AI usage requires a database configuration. ` +
          `Please call initialize() with a db option before querying usage.`,
      );
    }

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.since) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(options.since.toISOString());
    }

    if (options.until) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(options.until.toISOString());
    }

    if (options.provider) {
      conditions.push(`provider = $${paramIndex++}`);
      params.push(options.provider);
    }

    if (options.model) {
      conditions.push(`model = $${paramIndex++}`);
      params.push(options.model);
    }

    if (options.operation) {
      conditions.push(`operation = $${paramIndex++}`);
      params.push(options.operation);
    }

    if (options.className) {
      conditions.push(`class_name = $${paramIndex++}`);
      params.push(options.className);
    }

    if (options.tenantId === null) {
      conditions.push(`tenant_id IS NULL`);
    } else if (options.tenantId) {
      conditions.push(`tenant_id = $${paramIndex++}`);
      params.push(options.tenantId);
    }

    let sql = 'SELECT * FROM _smrt_ai_usage';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY ${
      options.orderBy === 'timestamp ASC' ? 'created_at ASC' : 'created_at DESC'
    }`;

    if (options.limit !== undefined) {
      sql += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options.offset !== undefined) {
      sql += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const rows = getQueryRows(await this._db.query(sql, ...params));

    return rows.map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      model: String(row.model),
      operation: String(row.operation),
      usage: normalizeAiUsageTokens({
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
      }),
      estimatedCost:
        row.estimated_cost === null || row.estimated_cost === undefined
          ? undefined
          : Number(row.estimated_cost),
      duration: Number(row.duration ?? 0),
      className:
        row.class_name === null || row.class_name === undefined
          ? undefined
          : String(row.class_name),
      tenantId:
        row.tenant_id === undefined
          ? undefined
          : (row.tenant_id as string | null),
      tags: parseAiUsageTags(row.tags),
      timestamp: normalizeAiUsageTimestamp(row.created_at),
    }));
  }

  /**
   * Summarize persisted AI usage records by a grouping dimension.
   */
  async summarizeAiUsage(
    options: AiUsageSummaryOptions = {},
  ): Promise<Record<string, AiUsageStats>> {
    if (!this._db) {
      throw new Error(
        `AI usage requires a database configuration. ` +
          `Please call initialize() with a db option before querying usage.`,
      );
    }

    const groupBy = options.groupBy ?? 'model';
    const bucketExpression =
      groupBy === 'provider'
        ? `provider`
        : groupBy === 'model'
          ? `provider || ':' || model`
          : groupBy === 'class'
            ? `COALESCE(class_name, 'unknown')`
            : groupBy === 'tenant'
              ? `COALESCE(tenant_id, 'global')`
              : groupBy === 'operation'
                ? `operation`
                : `substr(CAST(created_at AS TEXT), 1, 10)`;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (options.since) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(options.since.toISOString());
    }

    if (options.until) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(options.until.toISOString());
    }

    if (options.provider) {
      conditions.push(`provider = $${paramIndex++}`);
      params.push(options.provider);
    }

    if (options.model) {
      conditions.push(`model = $${paramIndex++}`);
      params.push(options.model);
    }

    if (options.operation) {
      conditions.push(`operation = $${paramIndex++}`);
      params.push(options.operation);
    }

    if (options.className) {
      conditions.push(`class_name = $${paramIndex++}`);
      params.push(options.className);
    }

    if (options.tenantId === null) {
      conditions.push(`tenant_id IS NULL`);
    } else if (options.tenantId) {
      conditions.push(`tenant_id = $${paramIndex++}`);
      params.push(options.tenantId);
    }

    let sql = `
      SELECT ${bucketExpression} AS bucket,
             COUNT(*) AS call_count,
             COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
             COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
             COALESCE(SUM(total_tokens), 0) AS total_tokens,
             COALESCE(SUM(duration), 0) AS total_duration,
             COALESCE(SUM(estimated_cost), 0) AS estimated_cost,
             MAX(created_at) AS last_used
      FROM _smrt_ai_usage
    `;

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ' GROUP BY bucket ORDER BY bucket ASC';

    const rows = getQueryRows(await this._db.query(sql, ...params));
    const summary: Record<string, AiUsageStats> = {};

    for (const row of rows) {
      const bucket = String(row.bucket);
      summary[bucket] = {
        callCount: Number(row.call_count ?? 0),
        promptTokens: Number(row.prompt_tokens ?? 0),
        completionTokens: Number(row.completion_tokens ?? 0),
        totalTokens: Number(row.total_tokens ?? 0),
        totalDuration: Number(row.total_duration ?? 0),
        estimatedCost: Number(row.estimated_cost ?? 0),
        lastUsed: row.last_used ? new Date(String(row.last_used)).getTime() : 0,
      };
    }

    return summary;
  }

  /**
   * Gets the signal bus instance
   *
   * @returns Signal bus if signals are enabled, undefined otherwise
   */
  get signalBus(): SignalBus | undefined {
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
  destroy(): void {
    // Only unregister adapters if we own the bus (not shared)
    if (this._signalBus && !this.options.signals?.bus) {
      for (const adapter of this._registeredAdapters) {
        this._signalBus.unregister(adapter);
      }
      this._registeredAdapters = [];
    }
  }

  private mergeAiUsageConfig(
    globalConfig: GlobalSignalConfig,
  ): ResolvedAiUsageConfig {
    const globalUsage = globalConfig.usage ?? {};
    const instanceUsage = this.options.usage ?? {};

    return {
      enabled: instanceUsage.enabled ?? globalUsage.enabled ?? true,
      persist: instanceUsage.persist ?? globalUsage.persist ?? true,
      estimateCosts:
        instanceUsage.estimateCosts ?? globalUsage.estimateCosts ?? true,
      costRates: {
        ...(globalUsage.costRates ?? {}),
        ...(instanceUsage.costRates ?? {}),
      },
      handlers: [
        ...(globalUsage.handlers ?? []),
        ...(instanceUsage.handlers ?? []),
      ],
    };
  }

  private initializeAiUsageHandlers(config: ResolvedAiUsageConfig): void {
    this._aiUsageCollector = undefined;
    this._aiUsageHandlers = [];

    if (!config.enabled) {
      return;
    }

    this._aiUsageCollector = new AiUsageCollector();
    this._aiUsageHandlers.push(this._aiUsageCollector);

    if (config.persist && this._db) {
      this._aiUsageHandlers.push(new AiUsagePersistenceHandler(this._db));
    }

    this._aiUsageHandlers.push(...config.handlers);
  }

  private async handleAiUsageCallback(
    event: unknown,
    aiConfig: Record<string, unknown>,
    usageConfig: ResolvedAiUsageConfig,
  ): Promise<void> {
    if (!usageConfig.enabled || this._aiUsageHandlers.length === 0) {
      return;
    }

    const normalizedEvent = this.normalizeAiUsageEvent(event, aiConfig);
    if (!normalizedEvent) {
      return;
    }

    if (usageConfig.estimateCosts) {
      normalizedEvent.estimatedCost = estimateAiUsageCost(
        normalizedEvent.provider,
        normalizedEvent.model,
        normalizedEvent.usage,
        usageConfig.costRates,
      );
    }

    await Promise.allSettled(
      this._aiUsageHandlers.map((handler) => handler.handle(normalizedEvent)),
    );
  }

  private normalizeAiUsageEvent(
    event: unknown,
    aiConfig: Record<string, unknown>,
  ): SmrtAiUsageEvent | undefined {
    const raw = (event ?? {}) as Record<string, unknown>;
    const provider =
      typeof raw.provider === 'string'
        ? raw.provider
        : typeof raw.type === 'string'
          ? raw.type
          : typeof aiConfig.provider === 'string'
            ? aiConfig.provider
            : typeof aiConfig.type === 'string'
              ? aiConfig.type
              : undefined;
    const model =
      typeof raw.model === 'string'
        ? raw.model
        : typeof raw.defaultModel === 'string'
          ? raw.defaultModel
          : typeof aiConfig.model === 'string'
            ? aiConfig.model
            : typeof aiConfig.defaultModel === 'string'
              ? aiConfig.defaultModel
              : undefined;
    const operation =
      typeof raw.operation === 'string'
        ? raw.operation
        : typeof raw.kind === 'string'
          ? raw.kind
          : typeof raw.method === 'string'
            ? raw.method
            : 'unknown';
    const usage =
      normalizeAiUsageTokens(raw.usage) ??
      normalizeAiUsageTokens(raw.tokenUsage) ??
      normalizeAiUsageTokens({
        promptTokens: raw.promptTokens,
        completionTokens: raw.completionTokens,
        totalTokens: raw.totalTokens,
      });

    if (!provider || !model) {
      return undefined;
    }

    const duration =
      typeof raw.duration === 'number'
        ? raw.duration
        : typeof raw.durationMs === 'number'
          ? raw.durationMs
          : typeof raw.latency === 'number'
            ? raw.latency
            : 0;
    const tenantId =
      'tenantId' in this &&
      (this as { tenantId?: string | null }).tenantId !== undefined
        ? ((this as { tenantId?: string | null }).tenantId ?? null)
        : undefined;

    return {
      provider,
      model,
      operation,
      usage,
      duration,
      timestamp: normalizeAiUsageTimestamp(raw.timestamp),
      tags: normalizeAiUsageTags(raw.tags),
      className: this._className,
      tenantId,
    };
  }
}
