import type { Plugin } from 'vite';

// Returning true on exhaustion is conservative: only a complete walk may prove
// that comment/string matches cannot require Vite's asset transform.
function hasImportMeta(ast: unknown): boolean {
  if (
    !ast ||
    typeof ast !== 'object' ||
    (ast as { type?: unknown }).type !== 'Program' ||
    !Array.isArray((ast as { body?: unknown }).body)
  )
    return true;
  const pending: unknown[] = [ast];
  let visited = 0;
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object') continue;
    if (++visited > 1_000_000) return true;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child && typeof child === 'object') pending.push(child);
      }
      continue;
    }
    const value = node as Record<string, unknown>;
    if (
      value.type === 'MetaProperty' &&
      (value.meta as { name?: string } | undefined)?.name === 'import' &&
      (value.property as { name?: string } | undefined)?.name === 'meta'
    )
      return true;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return false;
}

const unsafeAssetFilter = /new\s+URL.+import\.meta\.url/s;

/**
 * Keep Vite 7 asset URL transforms safe for large browser/Planner workers.
 * The known backtracking prefilter and comment-only eligibility are guarded;
 * Vite still owns asset parsing,
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
          const handler = transform.handler;
          transform.handler = function (...args) {
            try {
              if (!hasImportMeta(this.parse(args[0]))) return null;
            } catch {
              // Unknown syntax/context must retain Vite's original behavior.
            }
            return handler.apply(this, args);
          };
        }
      }
    },
  });
  return createPlugin(true);
}
