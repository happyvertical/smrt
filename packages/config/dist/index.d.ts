import { LoadConfigOptions, SmrtConfig } from './types.js';
export type { LoadConfigOptions, SmrtConfig, SmrtGlobalConfig, } from './types.js';
/**
 * Load and parse configuration from project root
 */
export declare function loadConfig(options?: LoadConfigOptions): Promise<SmrtConfig>;
/**
 * Get configuration for a specific module
 * Merges global smrt config with module-specific config
 *
 * @param moduleName - Name of the module
 * @param defaults - Default configuration values
 * @returns Merged configuration
 */
export declare function getModuleConfig<T extends Record<string, unknown>>(moduleName: string, defaults?: T): T;
/**
 * Get configuration for a specific package
 * Merges global smrt config with package-specific config
 *
 * @param packageName - Name of the package
 * @param defaults - Default configuration values
 * @returns Merged configuration
 */
export declare function getPackageConfig<T extends Record<string, unknown>>(packageName: string, defaults?: T): T;
/**
 * Set configuration at runtime
 * Merged with file-based config, runtime config takes priority
 */
export declare function setConfig(config: Partial<SmrtConfig>): void;
/**
 * Clear all cached configuration
 * Useful for testing or hot-reloading
 */
export declare function clearCache(): void;
/**
 * Helper to define config with TypeScript support
 * Provides auto-completion in config files
 */
export declare function defineConfig(config: SmrtConfig): SmrtConfig;
//# sourceMappingURL=index.d.ts.map