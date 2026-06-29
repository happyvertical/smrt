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
 * Distinguish "config file does not exist" (a benign, expected condition that
 * falls back to empty config) from "config file exists but failed to load/parse"
 * (a real error that should surface). cosmiconfig reads via Node `fs`, so a
 * missing explicit path raises an `ENOENT` error.
 */
function isFileNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  if ((error as { code?: unknown }).code === 'ENOENT') {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === 'string' &&
    (message.includes('ENOENT') || message.includes('no such file'))
  );
}

/**
 * Load and parse configuration from the project root using cosmiconfig.
 *
 * Searches for `smrt.config.{js,mjs,cjs,json}` starting from `cwd`, walking
 * up the directory tree unless `searchParents` is `false`. The result is
 * cached in `globalThis.__smrtLoaderCachedConfig` so that all modules sharing
 * the same runtime (including pnpm workspace symlinks) see the same config.
 *
 * Returns an empty object (`{}`) when no config file is found, so callers
 * should always treat every field as optional. A config file that **exists but
 * fails to load/parse** (syntax error, bad import, invalid JSON) throws instead
 * of being silently ignored (#1579).
 *
 * @param options - Search and caching options.
 * @returns The parsed {@link SmrtConfig}, or `{}` if no config file is found.
 * @throws If a config file exists but cannot be loaded or parsed.
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
  } catch (error) {
    // A genuinely-absent config file is not an error: an explicit `configPath`
    // that doesn't exist (ENOENT) legitimately falls back to empty config, and
    // `search()` returns null (never throws) when no file is found.
    if (isFileNotFound(error)) {
      return {};
    }
    // A config file that EXISTS but fails to load/parse — syntax error, bad
    // import, invalid JSON — is a real problem. Surface it loudly instead of
    // silently returning {} and falling back to defaults, which masks broken
    // config and leaves the developer thinking their settings applied (#1579).
    const where = configPath ? ` "${configPath}"` : '';
    throw new Error(
      `Failed to load smrt config${where}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
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
