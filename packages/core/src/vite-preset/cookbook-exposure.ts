/**
 * Which consumed package models an app hosts over REST, derived from its
 * cookbook (#3749).
 *
 * `smrtConsumer({ svelteKit: { objects } })` already generates routes for an
 * explicit, provider-qualified allowlist and honours each model's `api` config
 * (an `api: false` or empty-include model gets no route). The cookbook is that
 * allowlist: the models of its recipes plus its `features`. The cookbook's own
 * `exposure` (surfaces switched off per model) and a recipe's
 * `options[model].exposure.api === false` withdraw a model; nothing here widens
 * what a model declares.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@happyvertical/logger';
import { validateCookbook } from '../cookbook/validate.js';
import { readInstalledPackageManifest } from '../manifest/installed-package-manifest.js';

/** The cookbook file `smrt cookbook apply` writes at the project root. */
export const COOKBOOK_FILE = 'smrt.cookbook.json';

interface RecipeEntry {
  id?: unknown;
  models?: unknown;
  options?: unknown;
}

interface PackageManifestJson {
  packageName?: string;
  objects?: Record<
    string,
    { qualifiedName?: string; className?: string; packageName?: string }
  >;
  recipes?: RecipeEntry[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The package's JSON manifest, found the way the consumer plugin finds it:
 * the nearest `node_modules/<package>` at or above the project, so hoisted and
 * workspace installs resolve too.
 */
function readPackageManifest(
  projectRoot: string,
  packageName: string,
): PackageManifestJson | null {
  return (
    readInstalledPackageManifest<PackageManifestJson>(packageName, projectRoot)
      ?.manifest ?? null
  );
}

function objectRef(
  key: string,
  def: { qualifiedName?: string; className?: string; packageName?: string },
  fallbackPackage: string,
): string | undefined {
  if (key.includes(':')) return key;
  if (def.qualifiedName?.includes(':')) return def.qualifiedName;
  const pkg = def.packageName ?? fallbackPackage;
  return def.className ? `${pkg}:${def.className}` : undefined;
}

/**
 * Qualified refs of the consumed models the project's cookbook hosts. Returns
 * `[]` when the project has no cookbook. Refs that no consumed package
 * declares are dropped (the shell reports an unknown recipe or feature).
 *
 * @throws When `smrt.cookbook.json` is present but unreadable or invalid.
 */
export function resolveCookbookHostedObjects(
  projectRoot: string,
  packages: readonly string[],
): string[] {
  const file = path.join(projectRoot, COOKBOOK_FILE);
  if (!fs.existsSync(file)) return [];

  let document: unknown;
  try {
    document = readJson(file);
  } catch (error) {
    throw new Error(
      `[smrt] Cannot read ${COOKBOOK_FILE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = validateCookbook(document);
  if (!result.ok) {
    throw new Error(
      `[smrt] ${COOKBOOK_FILE} is not a valid cookbook:\n- ${result.errors.join('\n- ')}`,
    );
  }
  const { cookbook } = result;

  const declared = new Set<string>();
  const recipes = new Map<string, RecipeEntry>();
  const unreadable: string[] = [];
  for (const packageName of packages) {
    const manifest = readPackageManifest(projectRoot, packageName);
    if (!manifest) {
      unreadable.push(packageName);
      continue;
    }
    for (const [key, def] of Object.entries(manifest.objects ?? {})) {
      const ref = objectRef(
        key,
        def ?? {},
        manifest.packageName ?? packageName,
      );
      if (ref) declared.add(ref);
    }
    for (const recipe of manifest.recipes ?? []) {
      if (typeof recipe.id === 'string' && !recipes.has(recipe.id)) {
        recipes.set(recipe.id, recipe);
      }
    }
  }

  if (unreadable.length > 0) {
    // Its recipes and models cannot be hosted; say so instead of silently
    // hosting fewer routes than the cookbook selects.
    createLogger({ level: 'info' }).warn(
      `[smrt] ${COOKBOOK_FILE}: no readable JSON manifest for ${unreadable.join(', ')}; ` +
        'its recipes and models are not hosted. Install and build the package, ' +
        'or pass smrt({ expose }) explicitly.',
    );
  }

  const hosted = new Set<string>();
  const withdrawn = new Set<string>();
  for (const id of cookbook.recipes) {
    const recipe = recipes.get(id);
    if (!recipe || !Array.isArray(recipe.models)) continue;
    const options = (recipe.options ?? {}) as Record<
      string,
      { exposure?: { api?: unknown } } | undefined
    >;
    for (const model of recipe.models) {
      if (typeof model !== 'string') continue;
      hosted.add(model);
      if (options[model]?.exposure?.api === false) withdrawn.add(model);
    }
  }
  for (const feature of cookbook.features ?? []) hosted.add(feature);
  for (const [model, surfaces] of Object.entries(cookbook.exposure ?? {})) {
    if (surfaces.includes('api')) withdrawn.add(model);
  }

  return [...hosted]
    .filter((ref) => declared.has(ref) && !withdrawn.has(ref))
    .sort();
}
