import type { SmrtConfig } from './types.js';

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
export function getLoadedConfig(): SmrtConfig | null {
  return globalThis.__smrtConfigCache ?? null;
}

/**
 * Set the cached config in globalThis
 */
export function setLoadedConfig(config: SmrtConfig | null): void {
  globalThis.__smrtConfigCache = config;
}
