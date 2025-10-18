import { loadConfig as _loadConfig, clearConfigCache } from './loader.js';
import {
  setConfig as _setConfig,
  clearRuntimeConfig,
  getRuntimeConfig,
  mergeConfigs,
} from './merge.js';
import type { LoadConfigOptions, SmrtConfig } from './types.js';

// Re-export types
export type {
  LoadConfigOptions,
  SmrtConfig,
  SmrtGlobalConfig,
} from './types.js';

// Cached loaded config
let loadedConfig: SmrtConfig | null = null;

/**
 * Load and parse configuration from project root
 */
export async function loadConfig(
  options?: LoadConfigOptions,
): Promise<SmrtConfig> {
  const config = await _loadConfig(options);
  // Always update loadedConfig (even if caching is disabled)
  loadedConfig = config;
  return config;
}

/**
 * Get configuration for a specific module
 * Merges global smrt config with module-specific config
 *
 * @param moduleName - Name of the module
 * @param defaults - Default configuration values
 * @returns Merged configuration
 */
export function getModuleConfig<T extends Record<string, unknown>>(
  moduleName: string,
  defaults?: T,
): T {
  // Ensure config is loaded (will use empty config if not loaded)
  const fileConfig = loadedConfig || {};
  const runtime = getRuntimeConfig();

  // Get global smrt config
  const globalConfig = (fileConfig.smrt || {}) as Partial<T>;

  // Get module-specific config
  const moduleConfig = (fileConfig.modules?.[moduleName] || {}) as Partial<T>;

  // Get runtime module config
  const runtimeModuleConfig = (runtime.modules?.[moduleName] ||
    {}) as Partial<T>;

  // Merge: defaults < global < module < runtime
  const defaultsWithGlobal = mergeConfigs(
    defaults || ({} as T),
    globalConfig,
    {},
  );
  const withModuleConfig = mergeConfigs(defaultsWithGlobal, moduleConfig, {});
  const final = mergeConfigs(withModuleConfig, runtimeModuleConfig, {});

  return final;
}

/**
 * Get configuration for a specific package
 * Merges global smrt config with package-specific config
 *
 * @param packageName - Name of the package
 * @param defaults - Default configuration values
 * @returns Merged configuration
 */
export function getPackageConfig<T extends Record<string, unknown>>(
  packageName: string,
  defaults?: T,
): T {
  // Ensure config is loaded (will use empty config if not loaded)
  const fileConfig = loadedConfig || {};
  const runtime = getRuntimeConfig();

  // Get global smrt config
  const globalConfig = (fileConfig.smrt || {}) as Partial<T>;

  // Get package-specific config
  const packageConfig = (fileConfig.packages?.[packageName] ||
    {}) as Partial<T>;

  // Get runtime package config
  const runtimePackageConfig = (runtime.packages?.[packageName] ||
    {}) as Partial<T>;

  // Merge: defaults < global < package < runtime
  const defaultsWithGlobal = mergeConfigs(
    defaults || ({} as T),
    globalConfig,
    {},
  );
  const withPackageConfig = mergeConfigs(defaultsWithGlobal, packageConfig, {});
  const final = mergeConfigs(withPackageConfig, runtimePackageConfig, {});

  return final;
}

/**
 * Set configuration at runtime
 * Merged with file-based config, runtime config takes priority
 */
export function setConfig(config: Partial<SmrtConfig>): void {
  _setConfig(config);
}

/**
 * Clear all cached configuration
 * Useful for testing or hot-reloading
 */
export function clearCache(): void {
  loadedConfig = null;
  clearConfigCache(); // Clear loader.ts cache
  clearRuntimeConfig(); // Clear runtime config
}

/**
 * Helper to define config with TypeScript support
 * Provides auto-completion in config files
 */
export function defineConfig(config: SmrtConfig): SmrtConfig {
  return config;
}
