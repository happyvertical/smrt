import { SmrtConfig } from './types.js';
/**
 * Set runtime configuration
 * These override file-based configs
 */
export declare function setConfig(config: Partial<SmrtConfig>): void;
/**
 * Get runtime configuration
 */
export declare function getRuntimeConfig(): Partial<SmrtConfig>;
/**
 * Clear runtime configuration
 * Useful for testing
 */
export declare function clearRuntimeConfig(): void;
/**
 * Merge configurations with priority:
 * 1. Runtime config (highest)
 * 2. File config
 * 3. Defaults (lowest)
 */
export declare function mergeConfigs<T extends Record<string, unknown>>(defaults: T, fileConfig: Partial<T>, runtime: Partial<T>): T;
//# sourceMappingURL=merge.d.ts.map