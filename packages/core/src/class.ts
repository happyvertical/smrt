import type { AIClientOptions } from '@happyvertical/ai';
import { type AIClient, getAI } from '@happyvertical/ai';
import type { FilesystemAdapterOptions } from '@happyvertical/files';
import { FilesystemAdapter } from '@happyvertical/files';
import type { LoggerConfig } from '@happyvertical/logger';
import type { SignalAdapter } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import type {
  GlobalSignalConfig,
  MetricsConfig,
  PubSubConfig,
} from './config.js';
import { config } from './config.js';
import { SignalBus } from './signals/bus.js';
import { ALL_SYSTEM_TABLES, SMRT_SCHEMA_VERSION } from './system/schema.js';

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
   */
  db?:
    | string
    | {
        url?: string;
        type?: 'sqlite' | 'postgres' | 'sql';
        authToken?: string;
        [key: string]: any;
      }
    | DatabaseInterface;

  /**
   * Alias for db option - for backward compatibility with documentation
   *
   * @deprecated Use 'db' instead. This alias exists for backward compatibility.
   */
  persistence?:
    | string
    | {
        url?: string;
        type?: 'sqlite' | 'postgres' | 'sql';
        authToken?: string;
        [key: string]: any;
      }
    | DatabaseInterface;

  /**
   * Filesystem adapter configuration options
   */
  fs?: FilesystemAdapterOptions;

  /**
   * AI client configuration options or instance
   */
  ai?: AIClientOptions | AIClient;

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
      // Handle three db config formats:
      // 1. String: 'products.db' (shortcut)
      // 2. Config object: { type: 'sqlite', url: 'products.db' }
      // 3. DatabaseInterface instance: await getDatabase(...)
      if (typeof this.options.db === 'string') {
        // String shortcut - let getDatabase auto-detect type from URL
        this._db = await getDatabase({ url: this.options.db });
      } else if ('query' in this.options.db) {
        // Already a DatabaseInterface instance
        this._db = this.options.db as DatabaseInterface;
      } else {
        // Config object - pass directly to getDatabase
        // Cast to any to bypass index signature incompatibility
        this._db = await getDatabase(this.options.db as any);
      }
      await this.ensureSystemTables();
    }
    if (this.options.fs) {
      this._fs = await FilesystemAdapter.create(this.options.fs);
    }

    // Initialize AI client with environment variable support
    // Priority: instance options > env vars > global config > defaults
    const globalConfig = config.toJSON();
    if (this.options.ai || globalConfig.ai || process.env.SMRT_AI_PROVIDER) {
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

      // Only initialize if we have a provider configured
      if (aiConfig.provider || aiConfig.apiKey) {
        // Use getAI() factory to support all AI providers (OpenAI, Anthropic, Gemini, etc.)
        // getAI() returns AIInterface, which we cast to AIClient for backward compatibility
        this._ai = (await getAI(aiConfig as any)) as any as AIClient;
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

      // Use syncSchema() if available (works with JSON adapter SDK fix)
      // Fall back to query() for adapters without syncSchema()
      if (this._db.syncSchema) {
        // Execute statements one by one to ensure proper ordering
        for (const statement of allStatements) {
          await this._db.syncSchema(statement);
        }
      } else {
        // Fallback for adapters without syncSchema()
        for (const statement of allStatements) {
          await this._db.query(statement);
        }
      }

      // Record current schema version
      // Use ON CONFLICT for DuckDB compatibility (not INSERT OR IGNORE)
      const id = crypto.randomUUID();
      const version = SMRT_SCHEMA_VERSION;
      const description = 'Initial SMRT system tables';
      await this._db.execute`
        INSERT INTO _smrt_migrations (id, version, description)
        VALUES (${id}, ${version}, ${description})
        ON CONFLICT(version) DO NOTHING
      `;

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
}
