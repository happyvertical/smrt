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
 */

/**
 * Imports `specifier` without creating a statically-analyzable module edge.
 *
 * Resolution follows the runtime module graph, so this succeeds wherever the
 * calling package's own dependencies are installed (Node, tsx, vite dev,
 * externalized SSR). In a fully-bundled deployment that ships no
 * node_modules, resolution fails and the error tells the operator which
 * explicit entry point restores the capability.
 *
 * @param specifier - Bare module specifier of the optional dependency
 * @param enableHint - One sentence naming the explicit entry point (or
 *   registration call) that makes the capability available in bundled builds
 */
export async function importOptionalDependency(
  specifier: string,
  enableHint: string,
): Promise<unknown> {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (cause) {
    throw new Error(
      `Optional dependency '${specifier}' is not available in this runtime or build. ${enableHint}`,
      { cause },
    );
  }
}
