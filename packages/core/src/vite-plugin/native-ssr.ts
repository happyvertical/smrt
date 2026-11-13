import { isAbsolute, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SmrtDevServer } from './plugin-contract.js';

interface NativeSsrModule {
  externalize: string;
  type: 'module' | 'commonjs';
}

const nativeEntries = new WeakMap<object, Set<Map<string, NativeSsrModule>>>();

/**
 * Reuse the consumer's exact-entry Node boundary across SMRT plugins. Vite's
 * dev import analysis ignores resolveId.external; its SSR transport must hand
 * these files to Node while leaving component and Kit-facing modules in Vite.
 */
export function createDevNativeSsrModules() {
  const modules = new Map<string, NativeSsrModule>();
  const canonicalFiles = new Map<string, NativeSsrModule>();
  let root = '';
  return {
    configureServer(server: SmrtDevServer): void {
      root = server.config.root;
      // Resolution may register entries before Vite configures the server.
      // Add their root-relative aliases once the actual root is available.
      for (const [filename, native] of canonicalFiles) {
        if (filename.startsWith(`${root}/`)) {
          modules.set(filename.slice(root.length), native);
        }
      }
      const ssr = server.environments?.ssr;
      if (!ssr?.fetchModule) return;
      let sources = nativeEntries.get(ssr);
      if (!sources) {
        sources = new Set();
        nativeEntries.set(ssr, sources);
        const fetchModule = ssr.fetchModule.bind(ssr);
        const registered = sources;
        // Install once per environment; consumer and preset registrations
        // compose regardless of configureServer order.
        ssr.fetchModule = async (id, importer, options) => {
          for (const entries of registered) {
            const native = entries.get(id.split('?')[0]);
            if (native) return native;
          }
          return fetchModule(id, importer, options);
        };
      }
      sources.add(modules);
    },
    register(filename: string, type: NativeSsrModule['type']): void {
      if (!isAbsolute(filename)) return;
      const native = { externalize: pathToFileURL(filename).href, type };
      canonicalFiles.set(filename, native);
      modules.set(filename, native);
      modules.set(posix.join('/@fs/', filename), native);
      if (root && filename.startsWith(`${root}/`)) {
        modules.set(filename.slice(root.length), native);
      }
    },
  };
}
