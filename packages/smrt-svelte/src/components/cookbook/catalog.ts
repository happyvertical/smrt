/**
 * A recipe catalog from package manifests (#3749): the recipes the packages
 * declare and the models they point at. Pure, so a server load, a test and the
 * browser all read manifests the same way.
 */
import type { RecipeDefinition } from '@happyvertical/smrt-types';
import type {
  CookbookCatalog,
  CookbookModelInfo,
  CookbookRecipe,
} from './types.js';

/** The subset of a package `manifest.json` the shell reads. */
export interface CookbookManifest {
  packageName: string;
  objects?: Record<string, RawManifestObject>;
  recipes?: unknown;
}

interface RawManifestObject {
  className?: string;
  qualifiedName?: string;
  description?: string;
  fields?: Record<string, { type?: string }>;
  decoratorConfig?: Record<string, unknown>;
}

const PACKAGE_PREFIXES = ['@happyvertical/smrt-'];
const NON_VALUE_TYPES = new Set(['oneToMany', 'meta']);

/**
 * `@happyvertical/smrt-commerce` -> `commerce`. Other scopes keep their
 * unscoped name with a leading `smrt-` dropped, so ids stay short and stable.
 */
export function packageIdOf(packageName: string): string {
  for (const prefix of PACKAGE_PREFIXES) {
    if (packageName.startsWith(prefix)) return packageName.slice(prefix.length);
  }
  const bare = packageName.includes('/')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName;
  return bare.replace(/^smrt-/, '');
}

/** A model, not a collection class: it holds at least one value field. */
function isModel(raw: RawManifestObject): boolean {
  return Object.values(raw.fields ?? {}).some(
    (f) => !NON_VALUE_TYPES.has(f.type ?? ''),
  );
}

/** An omitted `api`/`mcp`/`cli` key means full CRUD; all three `false` means none. */
function isExposed(config: Record<string, unknown> | undefined): boolean {
  const c = config ?? {};
  return !(c.api === false && c.mcp === false && c.cli === false);
}

function isRecipe(value: unknown): value is CookbookRecipe {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.label === 'string' &&
    Array.isArray(r.nav) &&
    Array.isArray(r.models)
  );
}

/** Drop what the shell never reads (help markdown, synonyms, providers, ...). */
function trimRecipe(recipe: RecipeDefinition | CookbookRecipe): CookbookRecipe {
  const {
    id,
    label,
    nav,
    models,
    group,
    section,
    surfaces,
    requires,
    requiresAny,
  } = recipe;
  return {
    id,
    label,
    nav,
    models,
    ...(group ? { group } : {}),
    ...(section ? { section } : {}),
    ...(surfaces && surfaces.length > 0 ? { surfaces } : {}),
    ...(requires ? { requires } : {}),
    ...(requiresAny ? { requiresAny } : {}),
  };
}

/**
 * The catalog of the given manifests. Recipes keep their declaration order
 * across manifests (the order given); a repeated recipe id keeps the first.
 */
export function catalogFromManifests(
  manifests: readonly CookbookManifest[],
): CookbookCatalog {
  const recipes: CookbookRecipe[] = [];
  const seen = new Set<string>();
  const models: CookbookModelInfo[] = [];
  for (const manifest of manifests) {
    const packageId = packageIdOf(manifest.packageName);
    for (const raw of Object.values(manifest.objects ?? {})) {
      if (!raw.qualifiedName || !raw.className || !isModel(raw)) continue;
      const description = raw.description?.trim();
      models.push({
        id: raw.qualifiedName,
        name: raw.className,
        packageId,
        exposed: isExposed(raw.decoratorConfig),
        ...(description ? { description } : {}),
      });
    }
    if (Array.isArray(manifest.recipes)) {
      for (const recipe of manifest.recipes) {
        if (!isRecipe(recipe) || seen.has(recipe.id)) continue;
        seen.add(recipe.id);
        recipes.push(trimRecipe(recipe));
      }
    }
  }
  return { recipes, models };
}

/**
 * Narrow a catalog to what a cookbook uses, so a server load serializes only
 * that: the selected recipes, and the models they list or the cookbook names
 * as features.
 */
export function narrowCatalog(
  catalog: CookbookCatalog,
  selection: { recipes: readonly string[]; features: readonly string[] },
): CookbookCatalog {
  const wanted = new Set(selection.recipes);
  const recipes = catalog.recipes.filter((r) => wanted.has(r.id));
  const modelIds = new Set<string>(selection.features);
  for (const recipe of recipes) {
    for (const id of recipe.models) modelIds.add(id);
    for (const entry of recipe.nav) modelIds.add(entry.model);
  }
  return { recipes, models: catalog.models.filter((m) => modelIds.has(m.id)) };
}
