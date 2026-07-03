import type { Loader } from 'cosmiconfig';
import { cosmiconfig } from 'cosmiconfig';
import { createJiti } from 'jiti';
import type { LoadConfigOptions, SmrtConfig } from './types.js';

const MODULE_NAME = 'smrt';

/**
 * Lazily-created jiti instance used to load TypeScript config files.
 *
 * cosmiconfig ships no TypeScript loader (dropped in v8+), so a project whose
 * config is `smrt.config.ts` — the SvelteKit template default — silently fell
 * back to empty config, breaking `smrt db:setup` / `db:migrate` (#1783). jiti
 * transpiles and imports the `.ts`/`.mts`/`.cts` file on demand (it is the same
 * engine cosmiconfig-typescript-loader wraps), honoring the config's own
 * relative imports and `process.env` reads. Created once and reused so repeated
 * `loadConfig()` calls don't rebuild the transform pipeline.
 */
let jitiInstance: ReturnType<typeof createJiti> | undefined;

function getJiti(): ReturnType<typeof createJiti> {
  if (!jitiInstance) {
    // moduleCache: false so a re-read after the file changes on disk (hot
    // reload, or `loadConfig({ cache: false })`) re-evaluates instead of
    // returning jiti's in-memory copy. The common `cache: true` path is already
    // short-circuited by our own config cache before it reaches jiti, so this
    // adds no cost to steady-state loads. fsCache (default) still disk-caches
    // the content-hashed transpile output.
    jitiInstance = createJiti(import.meta.url, { moduleCache: false });
  }
  return jitiInstance;
}

/**
 * cosmiconfig loader for TypeScript config files. Returns the config's default
 * export (or the module namespace when there is no default), matching how the
 * JS loaders treat `export default` / `module.exports`.
 */
const typeScriptLoader: Loader = async (filepath: string) => {
  return getJiti().import(filepath, { default: true });
};

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
 * Searches for `smrt.config.{js,mjs,cjs,ts,mts,cts,json}` starting from `cwd`,
 * walking up the directory tree unless `searchParents` is `false`. TypeScript
 * configs are transpiled on demand via jiti (#1783). The result is
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
  const {
    configPath,
    searchParents = true,
    searchFrom,
    cache = true,
  } = options;

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
        `${MODULE_NAME}.config.ts`,
        `${MODULE_NAME}.config.mts`,
        `${MODULE_NAME}.config.cts`,
        `${MODULE_NAME}.config.json`,
      ],
      // cosmiconfig has no built-in TypeScript loader; register jiti for the TS
      // extensions so a `smrt.config.ts` scaffold loads end to end (#1783).
      loaders: {
        '.ts': typeScriptLoader,
        '.mts': typeScriptLoader,
        '.cts': typeScriptLoader,
      },
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
      result = await explorer.search(searchFrom ?? process.cwd());
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
