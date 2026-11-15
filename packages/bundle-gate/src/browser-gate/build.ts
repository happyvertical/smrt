import { svelte } from '@sveltejs/vite-plugin-svelte';
import { build, type Plugin } from 'vite';
import {
  collectForbiddenFindings,
  type Finding,
  type ImportGraph,
  type ModelPackage,
  matchForbiddenModule,
} from './boundary.js';

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Optional peers the application supplies, kept out of the gated graph.
 *
 * `@happyvertical/sql/pglite` imports `@electric-sql/pglite` lazily, and the
 * package is the app's choice, not model-package code. Its Emscripten loader
 * imports `node:module`, `node:fs`, `zlib` and the like only behind runtime
 * `ENVIRONMENT_IS_NODE` checks, so they are bundler-visible but never run in a
 * browser; `pnpm --filter @happyvertical/smrt-core test:browser` evaluates the
 * real package in Chromium (`--pglite-cascade`). Without this, the gate's result
 * would depend on whether the workspace happens to install PGlite. Only this
 * exact package (and its subpaths) is excluded; a Node-only import in any other
 * module, including core's own, is still reported.
 */
export const BROWSER_PEER_EXTERNALS: RegExp[] = [
  /^@electric-sql\/pglite(?:\/|$)/,
];

interface BundlerError {
  code?: string;
  id?: string;
  exporter?: string;
  message?: string;
}

function errorToFinding(error: BundlerError): Finding {
  const message = (error.message ?? String(error)).replace(ANSI, '');
  if (error.code === 'MISSING_EXPORT' && error.exporter && error.id) {
    const name = /"([^"]+)" is not exported by/.exec(message)?.[1] ?? '?';
    return {
      kind: 'missing-export',
      name,
      exporter: error.exporter,
      importer: error.id,
    };
  }
  return {
    kind: 'build-error',
    message: message.split('\n')[0] ?? message,
    file: error.id,
  };
}

/**
 * Builds one package root for a browser target and returns raw findings:
 * Node-only modules reachable from the root (with importer chains) and
 * bundler errors. Forbidden modules are externalized as they are resolved so
 * a regression reports every offending edge without bundling server code;
 * the module graph is read back to reconstruct the chains. Ownership
 * attribution happens afterwards in `attributeFindings`.
 */
export async function buildPackageForBrowser(
  pkg: ModelPackage,
): Promise<Finding[]> {
  const forbidden = new Set<string>();
  const graph: ImportGraph = new Map();

  const guard: Plugin = {
    name: 'smrt-browser-boundary-guard',
    enforce: 'pre',
    resolveId(source) {
      if (!matchForbiddenModule(source)) return null;
      forbidden.add(source);
      return { id: source, external: true };
    },
    buildEnd() {
      for (const id of this.getModuleIds()) {
        const info = this.getModuleInfo(id);
        if (!info) continue;
        graph.set(id, [
          ...info.importedIds,
          ...(info.dynamicallyImportedIds ?? []),
        ]);
      }
    },
  };

  const findings: Finding[] = [];
  try {
    await build({
      configFile: false,
      root: pkg.dir,
      logLevel: 'silent',
      // Svelte compiler parity with a browser consumer: model roots may
      // re-export .svelte components (products), which must compile.
      plugins: [guard, svelte()],
      build: {
        write: false,
        minify: false,
        sourcemap: false,
        target: 'esnext',
        modulePreload: false,
        rollupOptions: {
          input: { entry: pkg.entry },
          external: BROWSER_PEER_EXTERNALS,
        },
      },
    });
  } catch (error) {
    const errors = (error as { errors?: BundlerError[] }).errors ?? [
      error as BundlerError,
    ];
    findings.push(...errors.map(errorToFinding));
  }
  findings.push(...collectForbiddenFindings(graph, pkg.entry, forbidden));
  return findings;
}
