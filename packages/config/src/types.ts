/**
 * Global SMRT framework options
 * These apply to all modules unless overridden
 */
export interface SmrtGlobalConfig {
  cacheDir?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  environment?: 'development' | 'production' | 'test';
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
