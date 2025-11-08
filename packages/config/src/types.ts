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

  [key: string]: unknown;
}

/**
 * Main SMRT configuration structure
 */
export interface SmrtConfig {
  // Global SMRT framework options
  smrt?: SmrtGlobalConfig;

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
