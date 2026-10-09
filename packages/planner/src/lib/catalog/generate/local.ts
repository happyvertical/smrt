import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PACKAGE_PREFIX } from './exclusions.ts';
import type { RawKnowledge, RawManifest, RawPackage } from './extract.ts';

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  exports?: Record<string, unknown>;
}

/** The manifest path a package publishes as `./manifest`, else `dist/manifest.json`. */
function manifestPath(pkg: PackageJson): string {
  const target = pkg.exports?.['./manifest'];
  return typeof target === 'string' ? target : './dist/manifest.json';
}

/**
 * Read every `@happyvertical/smrt-*` package of a local smrt checkout that has
 * been built (the file its `./manifest` export names, usually
 * `dist/manifest.json`, plus the `smrt-knowledge.json` beside it). Packages that are not built are skipped.
 * This is the opt-in `CATALOG_SOURCE` path for previewing unreleased manifests.
 */
export async function readLocalPackages(
  checkout: string,
): Promise<RawPackage[]> {
  const packagesDir = join(resolve(checkout), 'packages');
  const dirs = (await readdir(packagesDir)).sort();
  const raws: RawPackage[] = [];
  for (const dir of dirs) {
    const pkgDir = join(packagesDir, dir);
    const pkg = await readJson<PackageJson>(join(pkgDir, 'package.json'));
    if (!pkg?.name?.startsWith(PACKAGE_PREFIX)) continue;
    const manifestFile = join(pkgDir, manifestPath(pkg));
    const manifest = await readJson<RawManifest>(manifestFile);
    if (!manifest) continue;
    raws.push({
      packageName: pkg.name,
      version: pkg.version ?? '0.0.0',
      description: pkg.description ?? '',
      manifest,
      knowledge: await readJson<RawKnowledge>(
        join(dirname(manifestFile), 'smrt-knowledge.json'),
      ),
    });
  }
  return raws;
}
