import type { cosmiconfig } from 'cosmiconfig';
import type { SmrtConfig } from './types.js';

/**
 * Loader state lives apart from `loader.ts` so `clearCache()` (browser-safe)
 * can reset it without importing the Node-only loader (cosmiconfig, jiti).
 * This module imports cosmiconfig for types only.
 */

/**
 * Extend globalThis to include loader cache properties.
 * Using globalThis ensures all module instances share the same loader state,
 * which is critical in monorepos where the same package can be loaded
 * from different paths (e.g., pnpm store vs workspace symlink).
 *
 * @see https://github.com/happyvertical/smrt/issues/543
 */
declare global {
  // eslint-disable-next-line no-var
  var __smrtLoaderCachedConfig: SmrtConfig | null | undefined;
  // eslint-disable-next-line no-var
  var __smrtLoaderExplorer: ReturnType<typeof cosmiconfig> | null | undefined;
}

/** Retrieve the cached config from the globalThis singleton store. */
export function getCachedConfig(): SmrtConfig | null {
  return globalThis.__smrtLoaderCachedConfig ?? null;
}

/** Write the config (or null to invalidate) into the globalThis singleton store. */
export function setCachedConfig(config: SmrtConfig | null): void {
  globalThis.__smrtLoaderCachedConfig = config;
}

/** Retrieve the cosmiconfig explorer instance from the globalThis singleton store. */
export function getExplorer(): ReturnType<typeof cosmiconfig> | null {
  return globalThis.__smrtLoaderExplorer ?? null;
}

/** Write the cosmiconfig explorer instance into the globalThis singleton store. */
export function setExplorer(exp: ReturnType<typeof cosmiconfig> | null): void {
  globalThis.__smrtLoaderExplorer = exp;
}

/**
 * Clear the internal loader cache.
 *
 * Resets `globalThis.__smrtLoaderCachedConfig` and invalidates the cosmiconfig
 * explorer so that the next `loadConfig()` call performs a fresh file search.
 *
 * This is a low-level helper. Consumer code should call `clearCache`
 * from the package entry instead, which also clears the runtime-override store.
 */
export function clearConfigCache(): void {
  setCachedConfig(null);

  // Clear cosmiconfig's cache
  const explorer = getExplorer();
  if (explorer) {
    explorer.clearCaches();
    setExplorer(null);
  }
}
