/**
 * Compiled application registration for out-of-bundle Node processes (#3117).
 *
 * A SvelteKit app registers its own `@smrt()` objects through the generated
 * `smrt-register.ts`, which only the Vite build compiles — and adapter-node
 * re-bundles the server from its own entries, so that module never exists as
 * an importable file in `build/`. A deployed task or schedule worker is plain
 * ESM run by `node`, so without this artifact `ObjectRegistry.getClass()`
 * cannot resolve any application object and every app-defined job throws
 * `Unknown object type` before its method runs.
 *
 * After a production build, this compiles that same generated module into
 * `.smrt/runtime/register.js`: one ESM entry that registers the app's local
 * objects AND its consumed packages' objects (via the `.smrt/register.js` it
 * imports), with each class's package-qualified identity and isolated
 * manifest exactly as the web server registers them. Application sources are
 * bundled; every package import stays external and is resolved from
 * `node_modules` at runtime, like the rest of the deployed image — so the
 * worker and `@happyvertical/smrt-core` share one registry.
 */

import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Alias, ResolvedConfig } from 'vite';

/** Directory (under the project root) the compiled registration is written to. */
export const WORKER_REGISTRATION_DIR = '.smrt/runtime';

/** Entry file name inside {@link WORKER_REGISTRATION_DIR}. */
export const WORKER_REGISTRATION_ENTRY = 'register.js';

/** Project-relative path a worker imports: `.smrt/runtime/register.js`. */
export const WORKER_REGISTRATION_PATH = `${WORKER_REGISTRATION_DIR}/${WORKER_REGISTRATION_ENTRY}`;

/** Is `child` the project root or inside it (and not under node_modules)? */
function isProjectSource(projectRoot: string, child: string): boolean {
  const rel = relative(projectRoot, child);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  return !rel.split(/[\\/]/).includes('node_modules');
}

/**
 * The resolved aliases that point at the application's own sources (e.g.
 * SvelteKit's `$lib` → `src/lib`). Aliases that map a package name elsewhere
 * are dropped: the compiled registration must import packages exactly as the
 * deployed process resolves them, from `node_modules`.
 */
export function projectSourceAliases(
  projectRoot: string,
  aliases: readonly Alias[] | undefined,
): Alias[] {
  return (aliases ?? []).filter(
    (alias) =>
      typeof alias.replacement === 'string' &&
      isAbsolute(alias.replacement) &&
      isProjectSource(projectRoot, alias.replacement),
  );
}

function matchesAlias(id: string, alias: Alias): boolean {
  const { find } = alias;
  if (typeof find === 'string') return id === find || id.startsWith(`${find}/`);
  find.lastIndex = 0;
  return find.test(id);
}

/**
 * Rollup `external` predicate: bundle relative, absolute (resolved), virtual,
 * and project-alias imports; keep every other bare specifier external.
 */
export function createWorkerRegistrationExternal(
  aliases: readonly Alias[],
): (id: string) => boolean {
  return (id) => {
    if (id.startsWith('.') || id.startsWith('\0') || isAbsolute(id)) {
      return false;
    }
    if (aliases.some((alias) => matchesAlias(id, alias))) return false;
    return true;
  };
}

export interface BuildWorkerRegistrationOptions {
  /** The application root (where `.smrt/` lives). */
  projectRoot: string;
  /** The generated `smrt-register.ts` to compile. */
  registrationFile: string;
  /** The consumer build's resolved config (aliases, decorator transform, mode). */
  resolvedConfig: Pick<ResolvedConfig, 'mode' | 'oxc' | 'resolve'>;
}

/**
 * Compile the generated registration into `.smrt/runtime/register.js`.
 * Returns the absolute output path. Throws on failure: a worker without it
 * cannot run any application-defined job, so the build must fail closed.
 */
export async function buildWorkerRegistration(
  options: BuildWorkerRegistrationOptions,
): Promise<string> {
  const { projectRoot, registrationFile, resolvedConfig } = options;
  const outDir = resolve(projectRoot, WORKER_REGISTRATION_DIR);
  const aliases = projectSourceAliases(
    projectRoot,
    resolvedConfig.resolve.alias,
  );
  const { build } = await import('vite');
  await build({
    configFile: false,
    envFile: false,
    root: projectRoot,
    mode: resolvedConfig.mode,
    logLevel: 'warn',
    clearScreen: false,
    publicDir: false,
    // No consumer plugins: the generated module is plain TypeScript over the
    // app's decorated classes, and re-running smrtPlugin here would recurse.
    plugins: [],
    resolve: { alias: aliases },
    oxc: resolvedConfig.oxc,
    // Externalization is decided by `external` below, not Vite's SSR
    // heuristics, so a package import can never be inlined into the bundle.
    ssr: { target: 'node', noExternal: true },
    build: {
      ssr: registrationFile,
      outDir,
      emptyOutDir: true,
      copyPublicDir: false,
      minify: false,
      sourcemap: true,
      reportCompressedSize: false,
      rollupOptions: {
        external: createWorkerRegistrationExternal(aliases),
        output: {
          format: 'es',
          entryFileNames: WORKER_REGISTRATION_ENTRY,
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  });
  return join(outDir, WORKER_REGISTRATION_ENTRY);
}
