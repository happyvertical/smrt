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
  // Site configuration types
  SiteConfig,
  SiteLocation,
  SiteNavigation,
  SiteNavigationLink,
  SitePublisher,
  SiteTheme,
  SmrtConfig,
  SmrtGlobalConfig,
} from './types.js';

/**
 * Extend globalThis to include our config cache properties.
 * Using globalThis ensures all module instances share the same config,
 * which is critical in monorepos where the same package can be loaded
 * from different paths (e.g., pnpm store vs workspace symlink).
 *
 * This fixes issue #543: external packages not receiving user config
 * when smrt-cli loads them.
 *
 * @see https://github.com/happyvertical/smrt/issues/543
 */
declare global {
  // eslint-disable-next-line no-var
  var __smrtConfigCache: SmrtConfig | null | undefined;
}

// Use globalThis for cross-module config sharing
// This ensures loadConfig() in smrt-cli affects all packages that use smrt-config
globalThis.__smrtConfigCache ??= null;

/**
 * Get the cached config from globalThis
 */
function getLoadedConfig(): SmrtConfig | null {
  return globalThis.__smrtConfigCache ?? null;
}

/**
 * Set the cached config in globalThis
 */
function setLoadedConfig(config: SmrtConfig | null): void {
  globalThis.__smrtConfigCache = config;
}

/**
 * Load and parse configuration from project root
 *
 * This function caches the config in globalThis, ensuring all module instances
 * (even from different package resolution paths) share the same config.
 */
export async function loadConfig(
  options?: LoadConfigOptions,
): Promise<SmrtConfig> {
  const config = await _loadConfig(options);
  // Always update config cache (even if caching is disabled)
  setLoadedConfig(config);
  return config;
}

/**
 * Get the currently loaded configuration synchronously
 * Returns null if config hasn't been loaded yet via loadConfig()
 *
 * @returns The cached config or null if not loaded
 */
export function getConfig(): SmrtConfig | null {
  return getLoadedConfig();
}

/**
 * Get site configuration from the loaded config
 * Returns the site identity, location, navigation, and theme settings
 *
 * @returns The site config or null if not defined
 */
export function getSiteConfig(): import('./types.js').SiteConfig | null {
  const config = getLoadedConfig() || {};
  return config.site || null;
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
  const fileConfig = getLoadedConfig() || {};
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
  const fileConfig = getLoadedConfig() || {};
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
  setLoadedConfig(null);
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
