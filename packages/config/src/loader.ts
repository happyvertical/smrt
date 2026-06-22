import { cosmiconfig } from 'cosmiconfig';
import type { LoadConfigOptions, SmrtConfig } from './types.js';

const MODULE_NAME = 'smrt';

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
function getCachedConfig(): SmrtConfig | null {
  return globalThis.__smrtLoaderCachedConfig ?? null;
}

/** Write the config (or null to invalidate) into the globalThis singleton store. */
function setCachedConfig(config: SmrtConfig | null): void {
  globalThis.__smrtLoaderCachedConfig = config;
}

/** Retrieve the cosmiconfig explorer instance from the globalThis singleton store. */
function getExplorer(): ReturnType<typeof cosmiconfig> | null {
  return globalThis.__smrtLoaderExplorer ?? null;
}

/** Write the cosmiconfig explorer instance into the globalThis singleton store. */
function setExplorer(exp: ReturnType<typeof cosmiconfig> | null): void {
  globalThis.__smrtLoaderExplorer = exp;
}

/**
 * Load and parse configuration from the project root using cosmiconfig.
 *
 * Searches for `smrt.config.{js,mjs,cjs,json}` starting from `cwd`, walking
 * up the directory tree unless `searchParents` is `false`. The result is
 * cached in `globalThis.__smrtLoaderCachedConfig` so that all modules sharing
 * the same runtime (including pnpm workspace symlinks) see the same config.
 *
 * Returns an empty object (`{}`) when no config file is found or when the
 * file fails to parse — callers should always treat every field as optional.
 *
 * @param options - Search and caching options.
 * @returns The parsed {@link SmrtConfig}, or `{}` if no file is found.
 *
 * @example
 * ```ts
 * import { loadConfig } from '@happyvertical/smrt-config';
 *
 * const config = await loadConfig();
 * console.log(config.smrt?.logLevel); // 'debug'
 * ```
 *
 * @example Load a specific file (useful in tests):
 * ```ts
 * const config = await loadConfig({ configPath: './fixtures/smrt.config.js', cache: false });
 * ```
 *
 * @see {@link LoadConfigOptions}
 * @see {@link clearConfigCache}
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<SmrtConfig> {
  const { configPath, searchParents = true, cache = true } = options;

  // Return cached config if available
  const cached = getCachedConfig();
  if (cache && cached) {
    return cached;
  }

  // Initialize or reuse cosmiconfig explorer
  let explorer = getExplorer();
  if (!explorer || !cache) {
    explorer = cosmiconfig(MODULE_NAME, {
      searchPlaces: [
        `${MODULE_NAME}.config.js`,
        `${MODULE_NAME}.config.mjs`,
        `${MODULE_NAME}.config.cjs`,
        `${MODULE_NAME}.config.json`,
      ],
      stopDir: searchParents ? undefined : process.cwd(),
      cache: cache, // Respect cache option
    });
    setExplorer(explorer);
  }

  let result: Awaited<ReturnType<typeof explorer.load>> = null;

  // Load from specific path or search
  try {
    if (configPath) {
      result = await explorer.load(configPath);
    } else {
      result = await explorer.search();
    }
  } catch (_error) {
    // Return empty config on error
    return {};
  }

  const config: SmrtConfig = result?.config || {};

  // Cache the config
  if (cache) {
    setCachedConfig(config);
  }

  return config;
}

/**
 * Clear the internal loader cache.
 *
 * Resets `globalThis.__smrtLoaderCachedConfig` and invalidates the cosmiconfig
 * explorer so that the next `loadConfig()` call performs a fresh file search.
 *
 * This is a low-level helper. Consumer code should call {@link clearCache}
 * from `index.ts` instead, which also clears the runtime-override store.
 *
 * @see {@link clearCache}
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
