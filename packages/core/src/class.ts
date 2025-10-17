import type { AIClientOptions } from '@have/ai';
import { type AIClient, getAI } from '@have/ai';
import type { FilesystemAdapterOptions } from '@have/files';
import { FilesystemAdapter } from '@have/files';
import type { LoggerConfig } from '@have/logger';
import type { DatabaseInterface } from '@have/sql';
import { getDatabase } from '@have/sql';
import type { SignalAdapter } from '@smrt/types';
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
   * Database configuration - unified approach matching @have/sql
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
        type?: 'sqlite' | 'postgres';
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
  protected options: SmrtClassOptions;

  /**
   * Track which databases have had system tables initialized
   * Key is database connection identifier
   */
  private static _systemTablesInitialized = new Set<string>();

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
   * Initializes database, filesystem, and AI client connections
   *
   * This method sets up all required services based on the provided options.
   * It should be called before using any of the service interfaces.
   *
   * @returns Promise that resolves to this instance for chaining
   */
  protected async initialize(): Promise<this> {
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
        this._db = await getDatabase(this.options.db);
      }
      await this.ensureSystemTables();
    }
    if (this.options.fs) {
      this._fs = await FilesystemAdapter.create(this.options.fs);
    }
    if (this.options.ai) {
      // Use getAI() factory to support all AI providers (OpenAI, Anthropic, Gemini, etc.)
      // getAI() returns AIInterface, which we cast to AIClient for backward compatibility
      this._ai = (await getAI(this.options.ai as any)) as any as AIClient;
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

    // Generate unique key for this database connection
    const dbKey = this.getDatabaseKey();

    // Skip if already initialized for this database
    if (SmrtClass._systemTablesInitialized.has(dbKey)) {
      return;
    }

    // Create all system tables
    for (const createTableSQL of ALL_SYSTEM_TABLES) {
      // Execute as raw SQL (not a parameterized query)
      await this._db.query(createTableSQL);
    }

    // Record current schema version
    const id = crypto.randomUUID();
    const version = SMRT_SCHEMA_VERSION;
    const description = 'Initial SMRT system tables';
    await this._db.execute`
      INSERT OR IGNORE INTO _smrt_migrations (id, version, description)
      VALUES (${id}, ${version}, ${description})
    `;

    // Mark this database as initialized
    SmrtClass._systemTablesInitialized.add(dbKey);
  }

  /**
   * Generate unique identifier for database connection
   * Used to track which databases have system tables initialized
   */
  private getDatabaseKey(): string {
    if (!this.options.db) {
      return 'default';
    }

    // Handle string shortcut
    if (typeof this.options.db === 'string') {
      return `sqlite:${this.options.db}`;
    }

    // Handle DatabaseInterface instance
    if ('query' in this.options.db) {
      // Use a generic key for instances (they share the same physical database)
      return 'instance:database';
    }

    // Handle config object
    const dbUrl = this.options.db.url || 'default';
    const dbType = this.options.db.type || 'sqlite';
    return `${dbType}:${dbUrl}`;
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
      const { createLogger, LoggerAdapter } = await import('@have/logger');
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
