import { LoadConfigOptions, SmrtConfig } from './types.js';
/**
 * Load and parse configuration from project root
 * Searches for smrt.config.{js,ts,json} files
 */
export declare function loadConfig(options?: LoadConfigOptions): Promise<SmrtConfig>;
/**
 * Clear the config cache
 * Useful for testing or hot-reloading
 */
export declare function clearConfigCache(): void;
/**
 * Check if config is loaded and cached
 */
export declare function isConfigLoaded(): boolean;
//# sourceMappingURL=loader.d.ts.map