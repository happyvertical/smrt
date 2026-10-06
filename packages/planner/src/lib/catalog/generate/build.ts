import type { Catalog } from '../types.ts';
import { EXCLUDED_PACKAGES } from './exclusions.ts';
import { extractPackage, packageId, resolveDependencies } from './extract.ts';
import { discoverPackageNames, fetchPackage } from './registry.ts';

export interface BuildOptions {
  registry: string;
  log?: (message: string) => void;
}

/**
 * Build the catalog from the registry: discover every `smrt-*` package, drop
 * the documented exclusions and packages with no manifest or no models, and
 * extract the rest. Output order is sorted, with no timestamps, so a run
 * against the same published versions is byte-identical.
 */
export async function buildCatalog(options: BuildOptions): Promise<Catalog> {
  const log = options.log ?? (() => {});
  const names = await discoverPackageNames(options.registry);
  const candidates = names.filter((name) => {
    const excluded = EXCLUDED_PACKAGES[packageId(name)];
    if (excluded) log(`exclude ${name}: ${excluded}`);
    return !excluded;
  });

  const extracted = [];
  for (let i = 0; i < candidates.length; i += 6) {
    const batch = await Promise.all(
      candidates
        .slice(i, i + 6)
        .map((name) => fetchPackage(options.registry, name)),
    );
    for (const raw of batch) {
      if (!raw) continue;
      const pkg = extractPackage(raw);
      if (pkg.models.length === 0) {
        log(`skip ${pkg.packageName}: no models`);
        continue;
      }
      log(`include ${pkg.packageName}@${pkg.version}`);
      extracted.push(pkg);
    }
  }
  extracted.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    schema: 1,
    registry: options.registry,
    packages: resolveDependencies(extracted),
  };
}
