import { loadConfig as _loadConfig, clearConfigCache } from './loader.js';
import {
  setConfig as _setConfig,
  clearRuntimeConfig,
  getRuntimeConfig,
  mergeConfigs,
} from './merge.js';
import type { LoadConfigOptions, SmrtConfig } from './types.js';

// Re-export config export utilities
export {
  type ExportConfigOptions,
  exportConfig,
  mergeExportedConfig,
  parseExportedConfig,
  sanitizeConfig,
} from './export.js';
export { clearRuntimeConfig, getRuntimeConfig, mergeConfigs } from './merge.js';

// Re-export types
export type {
  // CLI and migrations configuration types
  CliConfig,
  DatabaseConfig,
  // Export configuration types
  ExportConfig,
  ExportFileConfig,
  ExportFilterValue,
  LoadConfigOptions,
  MigrationsConfig,
  MigrationsPostgresConfig,
  SchemaContractConfig,
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
  // eslint-disable-next-line no-var
  var __smrtRuntimeConfig: Partial<SmrtConfig> | undefined;
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
 * Load and parse configuration from the project root.
 *
 * Searches for `smrt.config.{js,mjs,cjs,json}` starting from the current
 * working directory and walking up the tree (unless `searchParents: false`).
 * The result is stored in `globalThis.__smrtConfigCache` so every module in
 * the process — including pnpm workspace packages loaded from different paths
 * — sees the same instance.
 *
 * Must be called before {@link getConfig}, {@link getModuleConfig}, or
 * {@link getPackageConfig} return meaningful values (they fall back to an
 * empty config if called before loading).
 *
 * @param options - Optional search path, parent traversal, and cache control.
 * @returns The parsed {@link SmrtConfig}. Returns `{}` if no file is found.
 *
 * @example
 * ```ts
 * // Typical app startup
 * import { loadConfig } from '@happyvertical/smrt-config';
 * await loadConfig();
 * ```
 *
 * @example
 * ```ts
 * // Load a specific file (tests / scripts)
 * const config = await loadConfig({ configPath: './fixtures/smrt.config.js', cache: false });
 * ```
 *
 * @see {@link getConfig}
 * @see {@link clearCache}
 * @see {@link LoadConfigOptions}
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
 * Return the full merged configuration synchronously.
 *
 * Reads from `globalThis.__smrtConfigCache` without triggering a file search.
 * Returns `null` when {@link loadConfig} has not been called yet (or after
 * {@link clearCache} resets the cache).
 *
 * @returns The cached {@link SmrtConfig}, or `null` if not yet loaded.
 *
 * @example
 * ```ts
 * const config = getConfig();
 * if (config?.smrt?.logLevel === 'debug') {
 *   console.log('Debug logging enabled');
 * }
 * ```
 *
 * @see {@link loadConfig}
 * @see {@link getSiteConfig}
 * @see {@link getModuleConfig}
 */
export function getConfig(): SmrtConfig | null {
  return getLoadedConfig();
}

/**
 * Return the `site` section of the loaded configuration.
 *
 * Equivalent to `getConfig()?.site ?? null`. Returns `null` both when no
 * config has been loaded and when the loaded config has no `site` key.
 *
 * @returns The {@link SiteConfig} object, or `null` if not defined.
 *
 * @example
 * ```ts
 * const site = getSiteConfig();
 * const title = site?.name ?? 'Untitled Site';
 * ```
 *
 * @see {@link SiteConfig}
 * @see {@link getConfig}
 */
export function getSiteConfig(): import('./types.js').SiteConfig | null {
  const config = getLoadedConfig() || {};
  return config.site || null;
}

/**
 * Return the resolved configuration for a named module.
 *
 * Merges four layers in ascending priority order:
 * 1. `defaults` (caller-supplied fallbacks)
 * 2. Global `smrt` section of the loaded config
 * 3. `modules[moduleName]` section of the loaded config
 * 4. Runtime `modules[moduleName]` overrides set via {@link setConfig}
 *
 * Works synchronously — call {@link loadConfig} first to populate the cache.
 * If no config has been loaded, only `defaults` are returned.
 *
 * @param moduleName - Key in `config.modules` (e.g., `'praeco'`).
 * @param defaults - Optional fallback values used when a key is absent from all
 *   higher-priority layers.
 * @returns The fully merged module config typed as `T`.
 *
 * @example
 * ```ts
 * const config = getModuleConfig('praeco', {
 *   rssLimit: 50,
 *   fetchTimeout: 10_000,
 * });
 * // config.rssLimit may be overridden by smrt.config.js or setConfig()
 * ```
 *
 * @see {@link getPackageConfig}
 * @see {@link setConfig}
 * @see {@link SmrtConfig.modules}
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
 * Return the resolved configuration for a named package.
 *
 * Identical to {@link getModuleConfig} but reads from `config.packages` instead
 * of `config.modules`. Use this inside `@happyvertical/smrt-*` packages that
 * want to expose their own config section without conflicting with user-defined
 * module names.
 *
 * Merges four layers in ascending priority order:
 * 1. `defaults` (caller-supplied fallbacks)
 * 2. Global `smrt` section of the loaded config
 * 3. `packages[packageName]` section of the loaded config
 * 4. Runtime `packages[packageName]` overrides set via {@link setConfig}
 *
 * @param packageName - Key in `config.packages` (e.g., `'ai'`, `'spider'`).
 * @param defaults - Optional fallback values.
 * @returns The fully merged package config typed as `T`.
 *
 * @example
 * ```ts
 * // Inside @happyvertical/smrt-ai package
 * const config = getPackageConfig('ai', {
 *   defaultModel: 'gpt-4o-mini',
 *   maxTokens: 2048,
 * });
 * ```
 *
 * @see {@link getModuleConfig}
 * @see {@link setConfig}
 * @see {@link SmrtConfig.packages}
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
 * Apply runtime configuration overrides.
 *
 * Deep-merges `config` into an in-memory store that takes the highest priority
 * in every subsequent {@link getModuleConfig} / {@link getPackageConfig} call.
 * Successive calls accumulate — they do not replace earlier overrides.
 *
 * Common uses:
 * - Inject test doubles or environment-specific values without a config file.
 * - Apply feature flags from a remote source after startup.
 *
 * @param config - Partial {@link SmrtConfig} to merge into the runtime store.
 *   `null` values are ignored (they do not clear existing keys).
 *
 * @example
 * ```ts
 * setConfig({ modules: { ai: { defaultModel: 'gpt-4o' } } });
 * ```
 *
 * @see {@link clearCache}
 * @see {@link getModuleConfig}
 */
export function setConfig(config: Partial<SmrtConfig>): void {
  _setConfig(config);
}

/**
 * Reset all cached configuration state.
 *
 * Clears three independent caches:
 * 1. `globalThis.__smrtConfigCache` — the merged config loaded by {@link loadConfig}.
 * 2. The internal loader cache (`globalThis.__smrtLoaderCachedConfig`) and the
 *    cosmiconfig explorer instance.
 * 3. The runtime override store populated by {@link setConfig}.
 *
 * After calling this, {@link getConfig} returns `null` and a fresh
 * {@link loadConfig} call will re-read from disk.
 *
 * WARNING: This is a global reset — it affects every module sharing the same
 * runtime, not just the caller. Use with care outside of test teardown.
 *
 * @example
 * ```ts
 * afterEach(() => {
 *   clearCache(); // reset between tests
 * });
 * ```
 *
 * @see {@link loadConfig}
 * @see {@link setConfig}
 */
export function clearCache(): void {
  setLoadedConfig(null);
  clearConfigCache(); // Clear loader.ts cache
  clearRuntimeConfig(); // Clear runtime config
}

/**
 * Type-safe helper for authoring `smrt.config.js` files.
 *
 * This is an identity function — it returns its argument unchanged. Its sole
 * purpose is to provide TypeScript type-checking and IDE auto-completion when
 * writing the config object literal.
 *
 * @param config - The config object to validate against {@link SmrtConfig}.
 * @returns The same object, unchanged.
 *
 * @example
 * ```js
 * // smrt.config.js
 * import { defineConfig } from '@happyvertical/smrt-config';
 *
 * export default defineConfig({
 *   smrt: { logLevel: 'info' },
 *   site: { name: 'My Site', ... },
 * });
 * ```
 *
 * @see {@link SmrtConfig}
 * @see {@link loadConfig}
 */
export function defineConfig(config: SmrtConfig): SmrtConfig {
  return config;
}
