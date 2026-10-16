import type { Recipe } from '../../recipes/types.ts';
import type { Catalog, CatalogPackage } from '../types.ts';
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

function renderable(catalog: Catalog, log: (message: string) => void): Catalog {
  return {
    ...catalog,
    packages: dropUnrenderableRecipes(catalog.packages, log),
  };
}

/**
 * Drop the recipes a browser mock-up cannot show: one that lists a model no
 * catalog package declares, or whose menu opens a model with no screen (not
 * exposed), or that needs a recipe dropped for either reason. A package left
 * with no recipe and no exposed model has nothing to pick and goes too. Every
 * drop is logged; the reasons are the manifest's, so the fix is upstream.
 */
export function dropUnrenderableRecipes(
  packages: readonly CatalogPackage[],
  log: (message: string) => void = () => {},
): CatalogPackage[] {
  const models = new Map<string, boolean>();
  for (const pkg of packages) {
    for (const model of pkg.models) models.set(model.id, model.exposed);
  }
  const dropped = new Set<string>();
  const why = (recipe: Recipe): string | undefined => {
    for (const id of recipe.models) {
      if (!models.has(id)) return `lists ${id}, which no package declares`;
    }
    for (const entry of recipe.nav) {
      if (models.get(entry.model) === false) {
        return `opens ${entry.model} from the menu, which is not exposed`;
      }
    }
    for (const id of recipe.requires) {
      if (dropped.has(id)) return `needs ${id}`;
    }
    for (const group of recipe.requiresAny ?? []) {
      if (group.length > 0 && group.every((id) => dropped.has(id))) {
        return `needs one of ${group.join(', ')}`;
      }
    }
    return undefined;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const pkg of packages) {
      for (const recipe of pkg.recipes ?? []) {
        if (dropped.has(recipe.id)) continue;
        const reason = why(recipe);
        if (!reason) continue;
        dropped.add(recipe.id);
        changed = true;
        log(`drop recipe ${recipe.id}: ${reason}`);
      }
    }
  }
  if (dropped.size === 0) return [...packages];
  const out: CatalogPackage[] = [];
  for (const pkg of packages) {
    const all = pkg.recipes ?? [];
    const kept = all.filter((r) => !dropped.has(r.id));
    if (
      kept.length < all.length &&
      kept.length === 0 &&
      !pkg.models.some((m) => m.exposed)
    ) {
      log(`skip ${pkg.packageName}: nothing left to pick`);
      continue;
    }
    const { recipes: _recipes, ...rest } = pkg;
    out.push(kept.length > 0 ? { ...rest, recipes: kept } : rest);
  }
  return out;
}

/**
 * Build the catalog from the registry (discover every `smrt-*` package), or,
 * when `source` is set, from a local smrt checkout's built manifests.
 */
export async function buildCatalog(options: BuildOptions): Promise<Catalog> {
  const log = options.log ?? (() => {});
  if (options.source) {
    const raws = await readLocalPackages(options.source);
    return renderable(
      assembleCatalog(raws, `file://${options.source}`, log),
      log,
    );
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
  return renderable(assembleCatalog(raws, options.registry, log), log);
}
