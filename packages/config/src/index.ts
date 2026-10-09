/**
 * Node entry of `@happyvertical/smrt-config`: the shared config surface plus
 * the filesystem `loadConfig()` (cosmiconfig + jiti). The `browser` export
 * condition resolves `browser.ts` instead, which carries the same surface
 * without the Node-only loader (#3625).
 */
import { setLoadedConfig } from './loaded-config.js';
import { loadConfig as _loadConfig } from './loader.js';
import type { LoadConfigOptions, SmrtConfig } from './types.js';

export * from './shared.js';

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
