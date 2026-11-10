import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type PackageJson = {
  exports?: string | Record<string, unknown>;
  main?: string;
  module?: string;
};

function importTarget(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const conditions = value as Record<string, unknown>;
  return (
    importTarget(conditions.import) ??
    importTarget(conditions.node) ??
    importTarget(conditions.default)
  );
}

/** Resolve a package entry from the invoking consumer project, not the CLI's install. */
export async function resolveConsumerPackageEntry(
  packageName: string,
  projectRoot: string = process.cwd(),
): Promise<string> {
  const searchRoots: string[] = [];
  let directory = resolve(projectRoot);
  for (;;) {
    searchRoots.push(join(directory, 'node_modules'));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const root of searchRoots) {
    const packageRoot = join(root, ...packageName.split('/'));
    try {
      const manifest = JSON.parse(
        await readFile(join(packageRoot, 'package.json'), 'utf8'),
      ) as PackageJson;
      const exportsMap =
        manifest.exports && typeof manifest.exports === 'object'
          ? (manifest.exports as Record<string, unknown>)
          : null;
      const rootExport =
        exportsMap && '.' in exportsMap ? exportsMap['.'] : manifest.exports;
      const entry =
        importTarget(rootExport) ?? manifest.module ?? manifest.main ?? null;
      if (!entry)
        throw new Error(`Package ${packageName} has no importable root entry`);
      const resolved = resolve(packageRoot, entry);
      const withinPackage = relative(packageRoot, resolved);
      if (
        isAbsolute(withinPackage) ||
        withinPackage === '..' ||
        withinPackage.startsWith(`..${sep}`)
      )
        throw new Error(
          `Package ${packageName} root export escapes its package`,
        );
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error(
    `Package '${packageName}' is not installed in ${projectRoot}. Install it in the project that invokes this command.`,
  );
}

/** Import an optional command provider through the consumer's package graph. */
export async function importConsumerPackage<T>(
  packageName: string,
  projectRoot: string = process.cwd(),
): Promise<T> {
  const entry = await resolveConsumerPackageEntry(packageName, projectRoot);
  return import(/* @vite-ignore */ pathToFileURL(entry).href) as Promise<T>;
}
