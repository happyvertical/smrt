import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type ViteModule = typeof import('vite');
type ExportTarget = string | { [condition: string]: ExportTarget } | null;

/** Picks the ESM entry of a package `exports["."]` target (string or conditions). */
function esmEntry(target: ExportTarget | undefined): string | null {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return null;
  for (const condition of ['node', 'import', 'default']) {
    const entry = esmEntry(target[condition]);
    if (entry) return entry;
  }
  return null;
}

/**
 * Imports the Vite installed in the application at `projectRoot`.
 *
 * smrt-core does not depend on Vite at runtime (happyvertical/smrt#3181): a
 * `vite` dependency makes pnpm resolve smrt-core once per peer set of Vite's
 * optional peers, which duplicates the object registries. The Vite-only code
 * paths (plugin worker registration, loading `vite.config.ts`) therefore
 * resolve Vite from the application, which must have it installed, instead of
 * from smrt-core's own location.
 */
export async function importProjectVite(
  projectRoot: string,
  purpose: string,
): Promise<ViteModule> {
  let manifestPath: string;
  try {
    manifestPath = createRequire(join(projectRoot, 'package.json')).resolve(
      'vite/package.json',
    );
  } catch (error) {
    throw new Error(
      `[smrt] ${purpose} needs Vite, but 'vite' is not installed in ${projectRoot}. Add vite to the application's devDependencies.`,
      { cause: error },
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports?: ExportTarget | { '.': ExportTarget };
    module?: string;
    main?: string;
  };
  const exportsField = manifest.exports;
  const rootExport =
    exportsField && typeof exportsField === 'object' && '.' in exportsField
      ? (exportsField as { '.': ExportTarget })['.']
      : (exportsField as ExportTarget | undefined);
  const entry = esmEntry(rootExport) ?? manifest.module ?? manifest.main;
  if (!entry) {
    throw new Error(
      `[smrt] ${purpose}: cannot find the entry point of vite at ${dirname(manifestPath)}.`,
    );
  }
  return (await import(
    /* @vite-ignore */ pathToFileURL(resolve(dirname(manifestPath), entry)).href
  )) as ViteModule;
}
