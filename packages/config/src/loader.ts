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

/**
 * Get/set cached config from globalThis
 */
function getCachedConfig(): SmrtConfig | null {
  return globalThis.__smrtLoaderCachedConfig ?? null;
}

function setCachedConfig(config: SmrtConfig | null): void {
  globalThis.__smrtLoaderCachedConfig = config;
}

/**
 * Get/set cosmiconfig explorer from globalThis
 */
function getExplorer(): ReturnType<typeof cosmiconfig> | null {
  return globalThis.__smrtLoaderExplorer ?? null;
}

function setExplorer(exp: ReturnType<typeof cosmiconfig> | null): void {
  globalThis.__smrtLoaderExplorer = exp;
}

/**
 * Load and parse configuration from project root
 * Searches for smrt.config.{js,ts,json} files
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
 * Clear the config cache
 * Useful for testing or hot-reloading
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

/**
 * Check if config is loaded and cached
 */
export function isConfigLoaded(): boolean {
  return getCachedConfig() !== null;
}
