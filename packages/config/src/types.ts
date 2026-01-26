/**
 * Global SMRT framework options
 * These apply to all modules unless overridden
 */
export interface SmrtGlobalConfig {
  cacheDir?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  environment?: 'development' | 'production' | 'test';

  /**
   * Schema migration strategy when parent class schema changes
   *
   * Options:
   * - 'warn': Log warning about schema mismatch, require manual migration (safest)
   * - 'auto-add': Automatically ALTER TABLE to add new parent fields (default, convenient)
   *
   * Note: Removing columns is never automatic - always requires manual migration
   *
   * @default 'auto-add'
   */
  schemaMigration?: {
    strategy?: 'warn' | 'auto-add';
  };

  /**
   * Inheritance configuration
   */
  inheritance?: {
    /**
     * Behavior when an ancestor class is missing from the registry
     *
     * Options:
     * - 'error': Throw an error (strict, catches bugs)
     * - 'warn': Log warning and skip (lenient, default)
     *
     * @default 'warn'
     */
    onMissingAncestor?: 'error' | 'warn';

    /**
     * Size of LRU cache for inheritance chains and merged fields
     *
     * Higher values improve performance but use more memory.
     * Each entry stores one inheritance chain (array of strings).
     *
     * @default 200
     */
    cacheSize?: number;
  };

  /**
   * Embedding configuration for semantic search
   *
   * Project-level settings that apply to all SMRT objects
   * unless overridden in the @smrt() decorator.
   */
  embeddings?: {
    /**
     * Standard dimensions for embeddings in this project
     *
     * All embeddings should use the same dimensions for consistency.
     * Common values: 384, 768, 1536
     *
     * @default 768
     */
    dimensions?: number;

    /**
     * Embedding provider type
     *
     * - 'local': Use local Node.js model (@xenova/transformers)
     * - 'ai': Use AI library (OpenAI, etc.)
     * - 'auto': Try local first, fallback to AI
     *
     * @default 'local'
     */
    provider?: 'local' | 'ai' | 'auto';

    /**
     * Local model to use (when provider is 'local' or 'auto')
     *
     * Hugging Face model ID for @xenova/transformers.
     * Model is downloaded on first use (~440MB for bge-base-en-v1.5).
     *
     * @default 'Xenova/bge-base-en-v1.5'
     */
    localModel?: string;

    /**
     * AI model to use (when provider is 'ai' or fallback)
     *
     * OpenAI embedding model name.
     *
     * @default 'text-embedding-3-small'
     */
    aiModel?: string;

    /**
     * Whether to fallback to AI if local embedding fails
     *
     * Only applies when provider is 'auto'.
     *
     * @default true
     */
    fallbackToAI?: boolean;
  };

  [key: string]: unknown;
}

// ============================================================================
// Migrations Configuration Types
// ============================================================================

/**
 * PostgreSQL-specific migration settings
 */
export interface MigrationsPostgresConfig {
  /**
   * Use CREATE INDEX CONCURRENTLY for index creation
   * Avoids table locks but cannot run in a transaction
   *
   * @default true
   */
  useConcurrently?: boolean;

  /**
   * Lock timeout for migration statements
   *
   * @default '30s'
   */
  lockTimeout?: string;

  /**
   * Statement timeout for migration execution
   *
   * @default '60s'
   */
  statementTimeout?: string;
}

/**
 * Database migrations configuration
 *
 * Controls how migrations are generated, stored, and applied.
 */
export interface MigrationsConfig {
  /**
   * Directory for migration files (relative to project root)
   *
   * @default './migrations'
   */
  directory?: string;

  /**
   * Table name for tracking applied migrations
   *
   * @default '_smrt_schema_migrations'
   */
  table?: string;

  /**
   * Default format for generated migration files
   *
   * - 'sql': Plain SQL files with UP/DOWN sections
   * - 'typescript': TypeScript files with Migration interface
   *
   * @default 'sql'
   */
  format?: 'sql' | 'typescript';

  /**
   * Migration file naming strategy
   *
   * - 'sequence': Sequential numbers (0001, 0002, ...)
   * - 'timestamp': Unix timestamp-based (20240115143052)
   *
   * @default 'sequence'
   */
  naming?: 'sequence' | 'timestamp';

  /**
   * Migration mode
   *
   * - 'dynamic': Apply schema changes directly from manifest (dev-friendly)
   * - 'file': Require migration files for all changes (production-safe)
   * - 'hybrid': Dynamic in dev, file-based in production
   *
   * @default 'dynamic'
   */
  mode?: 'dynamic' | 'file' | 'hybrid';

  /**
   * Configure mode per environment
   *
   * Overrides the `mode` setting based on NODE_ENV
   */
  modeByEnvironment?: {
    development?: 'dynamic' | 'file' | 'hybrid';
    test?: 'dynamic' | 'file' | 'hybrid';
    staging?: 'dynamic' | 'file' | 'hybrid';
    production?: 'dynamic' | 'file' | 'hybrid';
  };

  /**
   * Automatically generate DOWN scripts where safe
   *
   * Some operations (DROP COLUMN) may lose data and should be reviewed.
   *
   * @default true
   */
  autoGenerateDown?: boolean;

  /**
   * PostgreSQL-specific settings
   */
  postgres?: MigrationsPostgresConfig;
}

/**
 * Database configuration for CLI commands
 */
export interface DatabaseConfig {
  /**
   * Database type
   *
   * @default 'sqlite'
   */
  type?: 'sqlite' | 'postgres' | 'duckdb';

  /**
   * Database connection URL
   *
   * For SQLite: file path or ':memory:'
   * For PostgreSQL: postgresql://user:pass@host:port/dbname
   */
  url?: string;
}

/**
 * CLI package configuration
 *
 * Used by @happyvertical/smrt-cli for database and migration commands.
 */
export interface CliConfig {
  /**
   * Database connection settings
   */
  database?: DatabaseConfig;

  /**
   * Migration settings
   */
  migrations?: MigrationsConfig;
}

// ============================================================================
// Site Configuration Types
// ============================================================================

/**
 * A navigation link item
 */
export interface SiteNavigationLink {
  label: string;
  href: string;
  icon?: string;
}

/**
 * Site navigation structure
 */
export interface SiteNavigation {
  /** Primary navigation links (header) */
  primary: SiteNavigationLink[];
  /** Footer navigation links */
  footer?: SiteNavigationLink[];
}

/**
 * Geographic location for the site
 */
export interface SiteLocation {
  /** Display name (e.g., "Bentley" or "Bentley, AB") */
  name: string;
  /** Latitude coordinate */
  latitude: number;
  /** Longitude coordinate */
  longitude: number;
  /** IANA timezone (e.g., "America/Edmonton") */
  timezone: string;
}

/**
 * Site theme/branding colors
 */
export interface SiteTheme {
  /** Primary brand color (hex) */
  primaryColor: string;
  /** Light variant of primary color */
  primaryLight?: string;
  /** Dark variant of primary color */
  primaryDark?: string;
}

/**
 * Publisher/organization information
 */
export interface SitePublisher {
  /** Organization name (e.g., "Blindman Press") */
  name: string;
  /** Organization website URL */
  url?: string;
  /** GitHub organization URL */
  github?: string;
}

/**
 * Site identity and configuration
 * Used by site templates to define site-specific settings
 */
export interface SiteConfig {
  /** Full site name (e.g., "Bentley Alberta") */
  name: string;
  /** Short name for mobile/compact displays */
  shortName?: string;
  /** Site description for SEO */
  description: string;
  /** Production URL */
  url?: string;
  /** Contact email for the site */
  contactEmail?: string;
  /** Publisher/organization info */
  publisher?: SitePublisher;
  /** Geographic location */
  location: SiteLocation;
  /** Navigation structure */
  navigation: SiteNavigation;
  /** Theme/branding */
  theme?: SiteTheme;
  /** Additional metadata */
  meta?: {
    /** Theme color for mobile browsers */
    themeColor?: string;
    /** Open Graph locale */
    ogLocale?: string;
    /** Google Tag Manager ID */
    gtmId?: string;
  };
}

// ============================================================================
// Export Configuration Types
// ============================================================================

/**
 * Filter operators for export queries
 */
export interface ExportFilterValue {
  /** Equals (shorthand: just the value) */
  eq?: string | number | boolean;
  /** Not equals */
  ne?: string | number | boolean;
  /** Greater than */
  gt?: string | number;
  /** Greater than or equal */
  gte?: string | number;
  /** Less than */
  lt?: string | number;
  /** Less than or equal */
  lte?: string | number;
  /** In array */
  in?: (string | number)[];
  /** Contains (text) */
  contains?: string;
}

/**
 * Configuration for a single export file
 */
export interface ExportFileConfig {
  /**
   * SMRT object types to include in this export
   * Uses className (e.g., 'MeetingRecap', 'Game')
   */
  types: string[];

  /**
   * Field whitelist - only export these fields
   * If specified, overrides exclude and fieldExportDefault
   */
  include?: string[];

  /**
   * Field blacklist - exclude these fields
   * Applied after schema-level exported: false check
   */
  exclude?: string[];

  /**
   * Filters to apply when querying records
   * Keys are field names, values are filter conditions
   *
   * @example
   * filters: {
   *   status: ['published'],  // shorthand for status IN ('published')
   *   publish_date: { gte: '2025-01-01' },
   *   council_slug: ['town-of-bentley'],
   * }
   */
  filters?: Record<string, string[] | number[] | ExportFilterValue>;

  /**
   * Output format for this file
   * @default 'json'
   */
  format?: 'json' | 'ndjson' | 'csv' | 'sqlite';

  /**
   * Field to order by
   * Prefix with '-' for descending (e.g., '-publish_date')
   */
  orderBy?: string;

  /**
   * Maximum records per file
   * If exceeded, creates paginated files (e.g., contents-1.json, contents-2.json)
   */
  limit?: number;

  /**
   * Create separate files per unique value of this field
   * e.g., shardBy: 'year' creates contents-2024.json, contents-2025.json
   */
  shardBy?: string;
}

/**
 * Export configuration for static site generation
 *
 * Controls how data is exported from database to JSON files for build.
 */
export interface ExportConfig {
  /**
   * Default export behavior for fields without explicit `exported` annotation
   *
   * - true: Export all fields by default (simpler, for most sites)
   * - false: Only export fields with explicit `exported: true`
   *
   * @default true
   */
  fieldExportDefault?: boolean;

  /**
   * Default output format for all exports
   * @default 'json'
   */
  format?: 'json' | 'ndjson' | 'csv' | 'sqlite';

  /**
   * Export file configurations
   * Keys become filenames (e.g., 'contents' -> 'contents.json')
   */
  [filename: string]: ExportFileConfig | boolean | string | undefined;
}

// ============================================================================
// Main Configuration
// ============================================================================

/**
 * Main SMRT configuration structure
 */
export interface SmrtConfig {
  // Global SMRT framework options
  smrt?: SmrtGlobalConfig;

  // Site identity and configuration (for site templates)
  site?: SiteConfig;

  // Export configuration for static site generation
  export?: ExportConfig;

  // Module-scoped configurations
  modules?: {
    [moduleName: string]: Record<string, unknown>;
  };

  // Package-scoped configurations
  packages?: {
    [packageName: string]: Record<string, unknown>;
  };
}

/**
 * Options for loading configuration
 */
export interface LoadConfigOptions {
  // Custom config file path (default: auto-detect in cwd)
  configPath?: string;

  // Search parent directories (default: true)
  searchParents?: boolean;

  // Cache loaded config (default: true)
  cache?: boolean;
}
