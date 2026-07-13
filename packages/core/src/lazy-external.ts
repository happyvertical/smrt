/**
 * Bundler-invisible loading of optional heavyweight dependencies.
 *
 * Rollup/Rolldown/esbuild follow `import('literal')` even inside rarely-called
 * methods, so a "lazy at runtime" provider import still lands in downstream
 * server bundles — SvelteKit production builds bundle every dependency unless
 * it is listed in `ssr.external` (#1977/#1978: ~90 MB of googleapis/nodemailer
 * reached ordinary chat consumers this way). Passing the specifier through a
 * function argument keeps the import expression non-analyzable, so the
 * dependency stays out of consumer bundles entirely and is resolved from
 * node_modules at runtime instead.
 *
 * Fully-bundled deployments (no node_modules at runtime) opt back in through
 * an explicit entry point that statically imports the dependency and calls
 * registerOptionalDependency() — the registry lives on globalThis, so ANY
 * package's entry point satisfies EVERY package's lazy import of the same
 * specifier.
 */

const OPTIONAL_DEPS_KEY = Symbol.for('smrt.optional-dependencies');

function registeredModules(): Map<string, unknown> {
  const root = globalThis as typeof globalThis & {
    [OPTIONAL_DEPS_KEY]?: Map<string, unknown>;
  };
  root[OPTIONAL_DEPS_KEY] ??= new Map();
  return root[OPTIONAL_DEPS_KEY];
}

/**
 * Registers a statically-imported module as the resolution for `specifier`,
 * making importOptionalDependency() work in fully-bundled deployments.
 * Called by explicit entry points such as `@happyvertical/smrt-core/filesystem`
 * and `@happyvertical/smrt-assets/filesystem`. The last registration wins.
 */
export function registerOptionalDependency(
  specifier: string,
  module: unknown,
): void {
  registeredModules().set(specifier, module);
}

/**
 * Imports `specifier` without creating a statically-analyzable module edge.
 *
 * Resolution order: a module registered via registerOptionalDependency()
 * wins; otherwise the specifier resolves through the runtime module graph,
 * which succeeds wherever the calling package's own dependencies are
 * installed (Node, tsx, vite dev, externalized SSR). In a fully-bundled
 * deployment with neither, the error names the explicit entry point that
 * restores the capability.
 *
 * @param specifier - Bare module specifier of the optional dependency
 * @param enableHint - One sentence naming the explicit entry point (or
 *   registration call) that makes the capability available in bundled builds
 */
export async function importOptionalDependency(
  specifier: string,
  enableHint: string,
): Promise<unknown> {
  const registered = registeredModules().get(specifier);
  if (registered !== undefined) return registered;
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (cause) {
    throw new Error(
      `Optional dependency '${specifier}' is not available in this runtime or build. ${enableHint}`,
      { cause },
    );
  }
}
