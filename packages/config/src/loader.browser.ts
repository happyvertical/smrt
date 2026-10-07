/**
 * Browser build of `loader.ts` (#2838): selected through `package.json#browser`.
 *
 * `loader.ts` discovers `smrt.config.*` on the filesystem with cosmiconfig and
 * transpiles TypeScript configs with jiti, both Node-only. A page has no
 * project directory to search, so like a Node project without a config file
 * it resolves to `{}`; set values with `setConfig()` instead. Asking for a
 * specific file with `configPath` cannot be honored and throws, rather than
 * pretending the file was absent. Typed against `loader.ts`, so the two
 * cannot drift.
 */
import type * as NodeLoader from './loader.js';

export const loadConfig: typeof NodeLoader.loadConfig = async (
  options = {},
) => {
  if (options.configPath) {
    throw new Error(
      `Failed to load smrt config "${options.configPath}": configuration files cannot be read in a browser; use setConfig()`,
    );
  }
  if (options.cache !== false) {
    globalThis.__smrtLoaderCachedConfig = {};
  }
  return {};
};

export const clearConfigCache: typeof NodeLoader.clearConfigCache = () => {
  globalThis.__smrtLoaderCachedConfig = null;
};
