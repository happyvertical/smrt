import type { Catalog } from '../types.ts';
import { EXCLUDED_PACKAGES } from './exclusions.ts';
import {
  extractPackage,
  packageId,
  type RawPackage,
  resolveDependencies,
} from './extract.ts';
import { readLocalPackages } from './local.ts';
import { withEffectiveDemo } from './recipe-demo.ts';
import { discoverPackageNames, fetchPackage } from './registry.ts';

export interface BuildOptions {
  registry: string;
  /**
   * Path to a smrt checkout: read its built `packages/*\/dist/manifest.json`
   * instead of the registry, to preview unreleased manifests. Opt-in.
   */
  source?: string;
  log?: (message: string) => void;
}

/**
 * Turn raw packages into the catalog: drop the documented exclusions and
 * packages with no models, extract the rest, and sort. A package on the
 * exclusion list that declares recipes stays: a recipe is a feature a visitor
 * can pick (the assistant is `smrt-chat`'s), whatever else the package is.
 * Output order is sorted, with no timestamps, so a run against the same inputs
 * is byte-identical. Pure: no network or disk access.
 */
export function assembleCatalog(
  raws: readonly RawPackage[],
  registry: string,
  log: (message: string) => void = () => {},
): Catalog {
  const extracted = [];
  for (const raw of raws) {
    const excluded = EXCLUDED_PACKAGES[packageId(raw.packageName)];
    const pkg = extractPackage(raw);
    if (excluded && !pkg.recipes) {
      log(`exclude ${raw.packageName}: ${excluded}`);
      continue;
    }
    if (pkg.models.length === 0) {
      log(`skip ${pkg.packageName}: no models`);
      continue;
    }
    log(
      `include ${pkg.packageName}@${pkg.version}${excluded ? ' (declares recipes)' : ''}`,
    );
    extracted.push(pkg);
  }
  extracted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: 1,
    registry,
    packages: withEffectiveDemo(resolveDependencies(extracted)),
  };
}

/**
 * Build the catalog from the registry (discover every `smrt-*` package), or,
 * when `source` is set, from a local smrt checkout's built manifests.
 */
export async function buildCatalog(options: BuildOptions): Promise<Catalog> {
  const log = options.log ?? (() => {});
  if (options.source) {
    const raws = await readLocalPackages(options.source);
    return assembleCatalog(raws, `file://${options.source}`, log);
  }
  const names = await discoverPackageNames(options.registry);
  // Excluded packages are fetched too: one that declares recipes stays, and
  // only its manifest says (see `assembleCatalog`).
  const raws: RawPackage[] = [];
  for (let i = 0; i < names.length; i += 6) {
    const batch = await Promise.all(
      names.slice(i, i + 6).map((name) => fetchPackage(options.registry, name)),
    );
    for (const raw of batch) if (raw) raws.push(raw);
  }
  return assembleCatalog(raws, options.registry, log);
}
