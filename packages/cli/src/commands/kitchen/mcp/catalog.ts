/**
 * The engine catalog (#3752) built from real recipe manifests: the recipes
 * each package declares, the models its objects declare, and the library of
 * ready-made cookbooks. Nothing here is invented; a package that cannot be
 * found contributes nothing and is reported.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCookbook } from '@happyvertical/smrt-core/cookbook';
import type {
  EngineCatalog,
  EngineField,
  EngineLibraryCookbook,
  EngineModel,
  EngineRecipe,
} from '@happyvertical/smrt-core/cookbook/engine';
import {
  loadRegistryManifest,
  type RecipeIndex,
  resolveRecipeIndex,
  SMRT_SCOPE,
} from '../../cookbook/recipe-index.js';

const FILE_SUFFIX = '.cookbook.json';

/** Fields every object has, or that policies cannot target. */
const SYSTEM_FIELDS = [
  'id',
  'slug',
  'context',
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
];

interface RawObject {
  className?: string;
  fields?: Record<string, { _meta?: { __tenancy?: unknown } } | undefined>;
  decoratorConfig?: { api?: unknown };
}

interface RawManifest {
  packageName?: string;
  objects?: Record<string, RawObject>;
  recipes?: Array<Partial<EngineRecipe> & { id?: string }>;
}

/** `@happyvertical/smrt-commerce` -> `commerce`, as item ids spell it. */
export function packageIdOf(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '').replace(/^smrt-/, '');
}

const isExposed = (object: RawObject): boolean => {
  const api = object.decoratorConfig?.api;
  if (api === false) return false;
  const include = (api as { include?: unknown } | undefined)?.include;
  return !(Array.isArray(include) && include.length === 0);
};

function modelsOf(packageName: string, manifest: RawManifest): EngineModel[] {
  const packageId = packageIdOf(packageName);
  const models: EngineModel[] = [];
  for (const [id, object] of Object.entries(manifest.objects ?? {})) {
    const fields = object.fields ?? {};
    const name = object.className ?? id.slice(id.lastIndexOf(':') + 1);
    // Collections are listed beside their object with no fields of their own.
    if (name.endsWith('Collection') && Object.keys(fields).length === 0) {
      continue;
    }
    const listed: EngineField[] = Object.entries(fields).map(
      ([field, def]) => ({
        name: field,
        ...(def?._meta?.__tenancy ? { system: true } : {}),
      }),
    );
    for (const field of SYSTEM_FIELDS) {
      if (!listed.some((f) => f.name === field)) {
        listed.push({ name: field, system: true });
      }
    }
    models.push({
      id,
      name,
      packageId,
      exposed: isExposed(object),
      fields: listed,
    });
  }
  return models;
}

/** Recipes the engine can use: they need an id, a label and a nav list. */
function recipesOf(manifest: RawManifest): EngineRecipe[] {
  return (manifest.recipes ?? []).flatMap((recipe) =>
    recipe.id && recipe.label
      ? [
          {
            ...recipe,
            id: recipe.id,
            label: recipe.label,
            models: recipe.models ?? [],
            nav: recipe.nav ?? [],
            requires: recipe.requires ?? [],
          } as EngineRecipe,
        ]
      : [],
  );
}

/** Build the engine catalog from every manifest in the index. */
export function catalogFromIndex(
  index: RecipeIndex,
  cookbooks: readonly EngineLibraryCookbook[] = [],
): EngineCatalog {
  const recipes: EngineRecipe[] = [];
  const models: EngineModel[] = [];
  for (const entry of [...index.packages.values()].sort((a, b) =>
    a.packageName.localeCompare(b.packageName),
  )) {
    const manifest = entry.manifest as RawManifest;
    recipes.push(...recipesOf(manifest));
    models.push(...modelsOf(entry.packageName, manifest));
  }
  return { recipes, models, cookbooks };
}

/** The package that ships this CLI's own files (`cookbooks/`). */
function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (existsSync(join(current, 'cookbooks'))) {
      const pkg = join(current, 'package.json');
      if (existsSync(pkg)) return current;
    }
    const parent = dirname(current);
    if (parent === current) return dirname(fileURLToPath(import.meta.url));
    current = parent;
  }
}

/** `yoga-studio` -> `Yoga Studio`. */
const titleOf = (id: string): string =>
  id
    .split(/[-_.]/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');

/**
 * Ready-made cookbooks from `<dir>/<id>.cookbook.json` files. A file that is
 * not a valid cookbook is skipped and named in `warnings`.
 */
export function readLibraryDir(
  dir: string,
  warnings: string[],
): EngineLibraryCookbook[] {
  if (!existsSync(dir)) {
    warnings.push(`Cookbook library directory not found: ${dir}`);
    return [];
  }
  const library: EngineLibraryCookbook[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(FILE_SUFFIX)) continue;
    const id = file.slice(0, -FILE_SUFFIX.length);
    try {
      const checked = validateCookbook(
        JSON.parse(readFileSync(join(dir, file), 'utf-8')),
      );
      if (!checked.ok) {
        warnings.push(`${file}: ${checked.errors.join('; ')}`);
        continue;
      }
      library.push({
        id,
        name: checked.cookbook.name ?? titleOf(id),
        document: checked.cookbook,
      });
    } catch (error) {
      warnings.push(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return library;
}

/** The library this CLI ships plus any extra directories (later ids win). */
export function loadLibrary(
  extraDirs: readonly string[],
  warnings: string[],
): EngineLibraryCookbook[] {
  const byId = new Map<string, EngineLibraryCookbook>();
  for (const dir of [
    join(packageRoot(), 'cookbooks'),
    ...extraDirs.map((d) => resolve(d)),
  ]) {
    for (const entry of readLibraryDir(dir, warnings))
      byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export interface CatalogOptions {
  /** Directory manifests are looked up from (the server's working directory). */
  dir: string;
  manifests?: string[];
  registry?: boolean;
  /** Extra smrt packages to read recipes from, beyond what the library names. */
  packages?: string[];
  library?: string[];
}

export interface LoadedCatalog {
  catalog: EngineCatalog;
  index: RecipeIndex;
  warnings: string[];
}

/**
 * Resolve the manifests behind the library's recipes (local sources first,
 * then the scope registry, as `cookbook validate` does) and build the catalog.
 */
export async function loadCatalog(
  options: CatalogOptions,
): Promise<LoadedCatalog> {
  const warnings: string[] = [];
  const library = loadLibrary(options.library ?? [], warnings);
  const recipes = [...new Set(library.flatMap((c) => c.document.recipes))];
  const index = await resolveRecipeIndex(
    { recipes, features: [], policies: [] },
    {
      dir: options.dir,
      manifests: options.manifests ?? [],
      registry: options.registry !== false,
      warn: (message) => warnings.push(message),
    },
  );
  for (const name of options.packages ?? []) {
    const full = name.startsWith('@') ? name : `${SMRT_SCOPE}/smrt-${name}`;
    if (index.packages.has(full) || options.registry === false) continue;
    if (!(await loadRegistryManifest(index, full, { dir: options.dir }))) {
      warnings.push(`Could not find a manifest for ${full}.`);
    }
  }
  for (const name of index.missing) {
    warnings.push(
      `No manifest found for ${name}; its recipes are unavailable.`,
    );
  }
  const catalog = catalogFromIndex(index, library);
  if (catalog.recipes.length === 0) {
    warnings.push(
      index.packages.size > 0
        ? `Manifests were found for ${index.packages.size} package(s) but none declares recipes; use package versions that ship recipes, or pass --manifests.`
        : 'No recipe manifests were found, so no recipes are available. Run from a SMRT workspace or project, pass --manifests, or allow registry access.',
    );
  }
  return { catalog, index, warnings };
}
