/**
 * Global SMRT framework options that apply to all modules unless overridden.
 *
 * Placed under the `smrt` key in `smrt.config.js`. Values here propagate
 * as the lowest-priority base for every `getModuleConfig()` and
 * `getPackageConfig()` call.
 *
 * @example
 * ```js
 * // smrt.config.js
 * export default defineConfig({
 *   smrt: {
 *     logLevel: 'debug',
 *     environment: 'development',
 *     embeddings: { provider: 'local' },
 *   },
 * });
 * ```
 *
 * @see {@link SmrtConfig}
 * @see {@link getModuleConfig}
 * @see {@link getPackageConfig}
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

    /**
     * Storage mode for embeddings
     *
     * - 'json': Store as JSON text, in-memory similarity (works everywhere)
     * - 'native': Use database vector operations when available, fallback to json
     *
     * @default 'json'
     */
    storage?: 'json' | 'native';
  };

  [key: string]: unknown;
}

// ============================================================================
// Migrations Configuration Types
// ============================================================================

/**
 * PostgreSQL-specific migration settings.
 *
 * Nested under `migrations.postgres` in {@link MigrationsConfig}.
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
 * Database migrations configuration.
 *
 * Controls how migrations are generated, stored, and applied. Placed under
 * the `cli.migrations` key in `smrt.config.js` and consumed by
 * `@happyvertical/smrt-cli` migration commands (`smrt db:migrate`, etc.).
 *
 * @see {@link CliConfig}
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
 * Database connection configuration for CLI commands.
 *
 * Placed under `cli.database` in `smrt.config.js`. Used by
 * `@happyvertical/smrt-cli` to connect for migration and inspection commands.
 *
 * @see {@link CliConfig}
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
 * CLI package configuration.
 *
 * Placed under the `cli` key in `smrt.config.js`. Consumed by
 * `@happyvertical/smrt-cli` for `smrt db:*` and migration commands.
 *
 * @example
 * ```js
 * export default defineConfig({
 *   cli: {
 *     database: { type: 'sqlite', url: 'file:./local.db' },
 *     migrations: { mode: 'file', directory: './migrations' },
 *   },
 * });
 * ```
 *
 * @see {@link DatabaseConfig}
 * @see {@link MigrationsConfig}
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
 * A single navigation link item used in site menus.
 *
 * @see {@link SiteNavigation}
 */
export interface SiteNavigationLink {
  label: string;
  href: string;
  icon?: string;
}

/**
 * Site navigation structure containing primary and optional footer links.
 *
 * @see {@link SiteConfig}
 * @see {@link SiteNavigationLink}
 */
export interface SiteNavigation {
  /** Primary navigation links (header) */
  primary: SiteNavigationLink[];
  /** Footer navigation links */
  footer?: SiteNavigationLink[];
}

/**
 * Geographic location for the site, used for proximity search and display.
 *
 * @see {@link SiteConfig}
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
 * Site theme and branding color palette.
 *
 * Colors should be provided as CSS hex values (e.g., `'#3b82f6'`).
 *
 * @see {@link SiteConfig}
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
 * Publisher or organization information displayed in site footers and metadata.
 *
 * @see {@link SiteConfig}
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
 * Site identity and configuration for SMRT site templates.
 *
 * Placed under the `site` key in `smrt.config.js`. Retrieved at runtime
 * via {@link getSiteConfig}. Used by site templates
 * (`template-sveltekit`, `template-site-static-json`) to define name,
 * description, navigation, location, and theme.
 *
 * @example
 * ```js
 * export default defineConfig({
 *   site: {
 *     name: 'Bentley Alberta',
 *     description: 'Community news for Bentley, AB',
 *     url: 'https://bentley.ca',
 *     location: { name: 'Bentley', latitude: 52.4, longitude: -113.9, timezone: 'America/Edmonton' },
 *     navigation: { primary: [{ label: 'Home', href: '/' }] },
 *   },
 * });
 * ```
 *
 * @see {@link getSiteConfig}
 * @see {@link SiteLocation}
 * @see {@link SiteNavigation}
 * @see {@link SiteTheme}
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
 * Filter operators for export queries.
 *
 * Used as values in {@link ExportFileConfig.filters} to build SQL `WHERE`
 * clauses when exporting records to static files.
 *
 * @example
 * ```js
 * filters: {
 *   publishDate: { gte: '2025-01-01', lt: '2026-01-01' },
 *   status: { in: ['published', 'featured'] },
 * }
 * ```
 *
 * @see {@link ExportFileConfig}
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
 * Configuration for a single SSG export file.
 *
 * Each key in {@link ExportConfig} (besides `fieldExportDefault` and `format`)
 * becomes the output filename. Records are queried from the database, filtered,
 * ordered, and written to `{key}.json` (or the specified format).
 *
 * @example
 * ```js
 * export default defineConfig({
 *   export: {
 *     articles: {
 *       types: ['Article'],
 *       filters: { status: ['published'] },
 *       orderBy: '-publishDate',
 *       limit: 500,
 *     },
 *   },
 * });
 * ```
 *
 * @see {@link ExportConfig}
 * @see {@link ExportFilterValue}
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
 * Export configuration for static site generation.
 *
 * Placed under the `export` key in `smrt.config.js`. Controls how database
 * records are exported to static files during SSG builds. Each additional
 * key beyond `fieldExportDefault` and `format` defines a named export file.
 *
 * @example
 * ```js
 * export default defineConfig({
 *   export: {
 *     fieldExportDefault: true,
 *     articles: { types: ['Article'], filters: { status: ['published'] } },
 *     games: { types: ['Game'], orderBy: '-date', format: 'ndjson' },
 *   },
 * });
 * ```
 *
 * @see {@link ExportFileConfig}
 * @see {@link exportConfig}
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
 * Root SMRT configuration structure.
 *
 * This is the shape of the object returned by `smrt.config.{js,ts,json}` and
 * consumed by {@link loadConfig}. Use {@link defineConfig} for type-safe
 * authoring with IDE auto-completion.
 *
 * Priority order (highest to lowest):
 * 1. Runtime overrides set via {@link setConfig}
 * 2. File-based config loaded by {@link loadConfig}
 * 3. Defaults passed to {@link getModuleConfig} / {@link getPackageConfig}
 *
 * @example
 * ```js
 * // smrt.config.js
 * import { defineConfig } from '@happyvertical/smrt-config';
 *
 * export default defineConfig({
 *   smrt: { logLevel: 'info', environment: 'production' },
 *   site: { name: 'My Site', ... },
 *   modules: { praeco: { rssLimit: 50 } },
 *   packages: { ai: { defaultModel: 'gpt-4o' } },
 * });
 * ```
 *
 * @see {@link loadConfig}
 * @see {@link defineConfig}
 * @see {@link SmrtGlobalConfig}
 */
export interface SmrtConfig {
  /** Global SMRT framework options — lowest-priority base for all modules. */
  smrt?: SmrtGlobalConfig;

  /** Site identity and configuration (for site templates). */
  site?: SiteConfig;

  /** Export configuration for static site generation. */
  export?: ExportConfig;

  /**
   * Module-scoped configurations keyed by module name.
   * Retrieved via {@link getModuleConfig}.
   */
  modules?: {
    [moduleName: string]: Record<string, unknown>;
  };

  /**
   * Package-scoped configurations keyed by package name.
   * Retrieved via {@link getPackageConfig}.
   */
  packages?: {
    [packageName: string]: Record<string, unknown>;
  };
}

/**
 * Options accepted by {@link loadConfig}.
 *
 * All fields are optional; omitting them triggers cosmiconfig's default
 * search behaviour (scan `cwd` upward for `smrt.config.{js,mjs,cjs,json}`).
 */
export interface LoadConfigOptions {
  /**
   * Absolute or relative path to a specific config file.
   * When provided, cosmiconfig loads this file directly instead of searching.
   */
  configPath?: string;

  /**
   * Whether to search parent directories when no config is found in `cwd`.
   *
   * @default true
   */
  searchParents?: boolean;

  /**
   * Whether to cache the loaded config in `globalThis.__smrtLoaderCachedConfig`.
   * Disable for test isolation or hot-reload scenarios.
   *
   * @default true
   */
  cache?: boolean;
}
