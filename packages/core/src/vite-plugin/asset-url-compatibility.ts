import type { Plugin } from 'vite';

const unsafeAssetFilter = /new\s+URL.+import\.meta\.url/s;

/**
 * Keep Vite 7 asset URL transforms safe for large browser/Planner workers.
 * Only the known backtracking prefilter changes; Vite still owns asset parsing,
 * resolution and rewriting. Vite 8 and unrecognized filter shapes are untouched.
 * Install once in root plugins; existing worker plugin factories are preserved.
 */
export function smrtAssetUrlCompatibility(): Plugin {
  let supportedVite = false;
  const createPlugin = (includeWorkers: boolean): Plugin => ({
    name: 'smrt-asset-url-compatibility',
    ...(includeWorkers
      ? ({
          async config(config) {
            const { version } = await import('vite');
            supportedVite = version.startsWith('7.');
            if (!supportedVite) return;
            const existing = config.worker?.plugins;
            return {
              worker: {
                plugins: (...args) => [
                  existing?.(...args) ?? [],
                  createPlugin(false),
                ],
              },
            };
          },
        } satisfies Partial<Plugin>)
      : {}),
    configResolved(config) {
      if (!supportedVite) return;
      for (const plugin of config.plugins) {
        if (plugin.name !== 'vite:asset-import-meta-url') continue;
        const transform = plugin.transform;
        if (!transform || typeof transform !== 'object') continue;
        const filter = transform.filter;
        const code = filter?.code;
        if (
          filter &&
          code instanceof RegExp &&
          code.source === unsafeAssetFilter.source &&
          code.flags === unsafeAssetFilter.flags
        ) {
          filter.code = 'import.meta.url';
        }
      }
    },
  });
  return createPlugin(true);
}
