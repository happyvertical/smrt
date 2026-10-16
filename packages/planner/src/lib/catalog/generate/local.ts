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
  private?: boolean;
  exports?: Record<string, unknown>;
}

/**
 * The manifest a package publishes, as the registry path reads it: the
 * `./manifest.json` export (a path, or a condition map's `default`), else a
 * string `./manifest` export. A package with neither ships no manifest and is
 * not a catalog source (tooling, runtime and UI libraries).
 */
function manifestPath(pkg: PackageJson): string | undefined {
  for (const key of ['./manifest.json', './manifest']) {
    const target = pkg.exports?.[key];
    if (typeof target === 'string' && target.endsWith('.json')) return target;
    const fallback = (target as { default?: unknown } | undefined)?.default;
    if (typeof fallback === 'string' && fallback.endsWith('.json')) {
      return fallback;
    }
  }
  return undefined;
}

/**
 * Read every public `@happyvertical/smrt-*` package of a smrt workspace that
 * publishes a manifest: the file its `./manifest.json` export names, plus the
 * `smrt-knowledge.json` beside it. This is how the planner's build generates
 * its catalog from the packages released beside it.
 *
 * A package that declares a manifest but has not been built is an error, not
 * a silent gap: a catalog missing a package would validate library cookbooks
 * against less than the release ships. Build the workspace first
 * (`pnpm build`, or Turbo's `^build` through the planner's devDependencies).
 */
export async function readLocalPackages(
  checkout: string,
): Promise<RawPackage[]> {
  const packagesDir = join(resolve(checkout), 'packages');
  const dirs = (await readdir(packagesDir)).sort();
  const raws: RawPackage[] = [];
  const unbuilt: string[] = [];
  for (const dir of dirs) {
    const pkgDir = join(packagesDir, dir);
    const pkg = await readJson<PackageJson>(join(pkgDir, 'package.json'));
    if (!pkg?.name?.startsWith(PACKAGE_PREFIX) || pkg.private) continue;
    const declared = manifestPath(pkg);
    if (!declared) continue;
    const manifestFile = join(pkgDir, declared);
    const manifest = await readJson<RawManifest>(manifestFile);
    if (!manifest) {
      unbuilt.push(`${pkg.name} (${declared})`);
      continue;
    }
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
  if (unbuilt.length > 0) {
    throw new Error(
      `${unbuilt.length} workspace package(s) declare a manifest that is not built:\n  ${unbuilt.join('\n  ')}\nBuild the workspace first (pnpm build).`,
    );
  }
  return raws;
}
