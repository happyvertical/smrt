import { cosmiconfig } from 'cosmiconfig';
import type { LoadConfigOptions, SmrtConfig } from './types.js';

const MODULE_NAME = 'smrt';

// Singleton cache
let cachedConfig: SmrtConfig | null = null;

/**
 * Load and parse configuration from project root
 * Searches for smrt.config.{js,ts,json} files
 */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<SmrtConfig> {
  const { configPath, searchParents = true, cache = true } = options;

  // Return cached config if available
  if (cache && cachedConfig) {
    return cachedConfig;
  }

  // Initialize cosmiconfig
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      `${MODULE_NAME}.config.js`,
      `${MODULE_NAME}.config.mjs`,
      `${MODULE_NAME}.config.cjs`,
      `${MODULE_NAME}.config.json`,
    ],
    stopDir: searchParents ? undefined : process.cwd(),
    cache: cache, // Respect cache option
  });

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
    cachedConfig = config;
  }

  return config;
}

/**
 * Clear the config cache
 * Useful for testing or hot-reloading
 */
export function clearConfigCache(): void {
  cachedConfig = null;

  // Clear Node's require cache for config files
  // This is necessary for testing when config files are modified
  const cacheKeys = Object.keys(require.cache);
  for (const key of cacheKeys) {
    if (key.includes('smrt.config')) {
      delete require.cache[key];
    }
  }
}

/**
 * Check if config is loaded and cached
 */
export function isConfigLoaded(): boolean {
  return cachedConfig !== null;
}
