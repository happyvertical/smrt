import { AIClientOptions, AIClient } from '@have/ai';
import { FilesystemAdapterOptions, FilesystemAdapter } from '@have/files';
import { DatabaseInterface } from '@have/sql';
import { ISignalAdapter } from '@smrt/types';
import { LoggerConfig } from '@have/logger';
import { SignalBus } from './signals/bus.js';
import { MetricsConfig, PubSubConfig } from './config.js';
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
    db?: string | {
        url?: string;
        type?: 'sqlite' | 'postgres';
        authToken?: string;
        [key: string]: any;
    } | DatabaseInterface;
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
        adapters?: ISignalAdapter[];
    };
}
/**
 * Foundation class providing core functionality for the SMRT framework
 *
 * SmrtClass provides unified access to database, filesystem, and AI client
 * interfaces. It serves as the foundation for all other classes in the
 * SMRT framework.
 */
export declare class SmrtClass {
    /**
     * AI client instance for interacting with AI models
     */
    protected _ai: AIClient;
    /**
     * Filesystem adapter for file operations
     */
    protected _fs: FilesystemAdapter;
    /**
     * Database interface for data persistence
     */
    protected _db: DatabaseInterface;
    /**
     * Class name used for identification
     */
    protected _className: string;
    /**
     * Signal bus for method execution tracking
     */
    protected _signalBus?: SignalBus;
    /**
     * Adapters registered by this instance (for cleanup)
     */
    private _registeredAdapters;
    /**
     * Configuration options provided to the class
     */
    protected options: SmrtClassOptions;
    /**
     * Track which databases have had system tables initialized
     * Key is database connection identifier
     */
    private static _systemTablesInitialized;
    /**
     * Creates a new SmrtClass instance
     *
     * @param options - Configuration options for database, filesystem, and AI clients
     */
    constructor(options?: SmrtClassOptions);
    /**
     * Initializes database, filesystem, and AI client connections
     *
     * This method sets up all required services based on the provided options.
     * It should be called before using any of the service interfaces.
     *
     * @returns Promise that resolves to this instance for chaining
     */
    protected initialize(): Promise<this>;
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
    private ensureSystemTables;
    /**
     * Generate unique identifier for database connection
     * Used to track which databases have system tables initialized
     */
    private getDatabaseKey;
    /**
     * Access system tables through standard database interface
     * System tables use _smrt_ prefix to avoid conflicts with user tables
     */
    protected get systemDb(): DatabaseInterface;
    /**
     * Initialize signal bus and adapters
     *
     * Merges global configuration with instance-specific overrides.
     * Registers built-in and custom adapters based on configuration.
     */
    private initializeSignals;
    /**
     * Merge global and instance signal configuration
     *
     * Instance configuration takes priority over global defaults.
     *
     * @param globalConfig - Global configuration from smrt.configure()
     * @returns Merged configuration
     */
    private mergeSignalConfig;
    /**
     * Check if signals should be initialized
     *
     * Signals are initialized if any adapter is configured.
     *
     * @param config - Effective signal configuration
     * @returns True if signals should be initialized
     */
    private shouldInitializeSignals;
    /**
     * Register signal adapters based on configuration
     *
     * @param config - Effective signal configuration
     */
    private registerAdapters;
    /**
     * Gets the filesystem adapter instance
     */
    get fs(): FilesystemAdapter;
    /**
     * Gets the database interface instance
     */
    get db(): DatabaseInterface;
    /**
     * Gets the AI client instance
     */
    get ai(): AIClient;
    /**
     * Gets the signal bus instance
     *
     * @returns Signal bus if signals are enabled, undefined otherwise
     */
    get signalBus(): SignalBus | undefined;
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
    destroy(): void;
}
//# sourceMappingURL=class.d.ts.map