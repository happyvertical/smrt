/**
 * Browser entry of `@happyvertical/smrt-config` (`exports['.'].browser`).
 *
 * Everything the Node entry exposes except the filesystem loader: model
 * packages read already-loaded config (`getPackageConfig`, `getModuleConfig`,
 * ...) and must bundle for a browser without reaching cosmiconfig, jiti, or
 * `node:fs` (#3625). `loadConfig()` is the one export that cannot work here;
 * it rejects with an explicit error instead of silently returning `{}`. Seed
 * browser config with `setConfig()`.
 */
import type { LoadConfigOptions, SmrtConfig } from './types.js';

export * from './shared.js';

/**
 * Filesystem config discovery is unavailable in a browser build.
 *
 * @throws Always: use `setConfig()` to provide configuration in the browser.
 * @see {@link setConfig}
 */
export async function loadConfig(
  _options?: LoadConfigOptions,
): Promise<SmrtConfig> {
  throw new Error(
    '@happyvertical/smrt-config: loadConfig() reads smrt.config.* from the filesystem and is not available in a browser build. Provide configuration with setConfig() instead.',
  );
}
