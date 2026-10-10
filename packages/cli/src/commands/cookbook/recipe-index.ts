/**
 * Recipe index for `smrt cookbook validate|apply` (#3748).
 *
 * Source of truth: each package's published manifest (its
 * `./manifest` export; `dist/manifest.json` or `dist/lib/manifest.json`), which carries `recipes[]` and the `objects` the
 * cookbook's policies and features point at. Manifests are read from, in
 * order: explicit `--manifests` paths, the SMRT workspace around the working
 * directory, the project's `node_modules`, and finally (opt-out with
 * `--no-registry`) the npm registry for packages that are not installed yet.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  extractTarball,
  fetchPackageTarball,
  type RegistryOptions,
} from './registry.js';

// Re-exported: these lived here before `smrt kitchen` shared them.
export {
  type FetchLike,
  type RegistryOptions,
  registryForPackage,
} from './registry.js';

export const SMRT_SCOPE = '@happyvertical';
const PACKAGE_PREFIX = 'smrt-';

/** One recipe, with the facts validation and apply need. */
export interface RecipeIndexEntry {
  id: string;
  packageName: string;
  packageVersion?: string;
  requires: string[];
  requiresAny: string[][];
  models: string[];
  /** The recipe declares model/field curation options. */
  hasOptions: boolean;
  /** The recipe carries demo seed data (never applied by cookbook apply). */
  hasDemoSeed: boolean;
}

/** One package's manifest facts. */
export interface PackageIndexEntry {
  packageName: string;
  packageVersion?: string;
  /** Where it was read from, for diagnostics. */
  source: string;
  /** Qualified object name to its field names. */
  objects: Map<string, Set<string>>;
}

export interface RecipeIndex {
  recipes: Map<string, RecipeIndexEntry>;
  packages: Map<string, PackageIndexEntry>;
  /** Packages a registry or manifest lookup was tried for and not found. */
  missing: Set<string>;
}

export function createRecipeIndex(): RecipeIndex {
  return { recipes: new Map(), packages: new Map(), missing: new Set() };
}

interface ManifestLike {
  packageName?: string;
  packageVersion?: string;
  objects?: Record<string, { fields?: Record<string, unknown> | unknown[] }>;
  recipes?: Array<{
    id?: string;
    requires?: string[];
    requiresAny?: string[][];
    models?: string[];
    options?: Record<string, unknown>;
    demoSeed?: unknown;
  }>;
}

/** Add one parsed manifest to the index. Returns false when it names no package. */
export function addManifest(
  index: RecipeIndex,
  manifest: ManifestLike,
  source: string,
): boolean {
  const packageName = manifest.packageName;
  if (!packageName || index.packages.has(packageName)) {
    return Boolean(packageName);
  }
  const objects = new Map<string, Set<string>>();
  for (const [name, object] of Object.entries(manifest.objects ?? {})) {
    const fields = object?.fields;
    objects.set(
      name,
      new Set(
        Array.isArray(fields)
          ? fields.map((f) =>
              typeof f === 'string' ? f : String((f as { name?: string }).name),
            )
          : Object.keys(fields ?? {}),
      ),
    );
  }
  index.packages.set(packageName, {
    packageName,
    packageVersion: manifest.packageVersion,
    source,
    objects,
  });
  for (const recipe of manifest.recipes ?? []) {
    if (!recipe.id || index.recipes.has(recipe.id)) continue;
    index.recipes.set(recipe.id, {
      id: recipe.id,
      packageName,
      packageVersion: manifest.packageVersion,
      requires: recipe.requires ?? [],
      requiresAny: recipe.requiresAny ?? [],
      models: recipe.models ?? [],
      hasOptions: Boolean(
        recipe.options && Object.keys(recipe.options).length > 0,
      ),
      hasDemoSeed: recipe.demoSeed !== undefined,
    });
  }
  return true;
}

const MANIFEST_FALLBACKS = [
  'dist/manifest.json',
  'dist/lib/manifest.json',
  'manifest.json',
];

function exportTarget(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return exportTarget(record.default ?? record.import ?? record.require);
  }
  return undefined;
}

/**
 * A package directory's manifest file: its `exports['./manifest']` (or
 * `./manifest.json`) target, else the known locations. SvelteKit-library
 * packages publish at `dist/lib/manifest.json`, not `dist/manifest.json`.
 */
export function manifestPathForPackageDir(dir: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    const exports = pkg.exports as Record<string, unknown> | undefined;
    const target =
      exportTarget(exports?.['./manifest']) ??
      exportTarget(exports?.['./manifest.json']);
    // `./manifest` can point at a JS module (core); only JSON is a manifest.
    if (target?.endsWith('.json')) {
      const file = resolve(dir, target);
      if (existsSync(file)) return file;
    }
  } catch {
    // no readable package.json: use the fallbacks
  }
  for (const relative of MANIFEST_FALLBACKS) {
    const file = join(dir, relative);
    if (existsSync(file)) return file;
  }
  return null;
}

function readManifestFile(
  index: RecipeIndex,
  file: string,
  warn: (message: string) => void,
): void {
  try {
    addManifest(index, JSON.parse(readFileSync(file, 'utf-8')), file);
  } catch (error) {
    warn(
      `Skipped unreadable manifest ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Read manifests from a path: a manifest file, a directory of `*.json`
 * manifests, or a directory of package directories (`<pkg>/dist/manifest.json`
 * or `<pkg>/manifest.json`).
 */
export function loadManifestPath(
  index: RecipeIndex,
  path: string,
  warn: (message: string) => void = () => {},
): void {
  const target = resolve(path);
  if (!existsSync(target)) {
    warn(`Manifest path not found: ${target}`);
    return;
  }
  if (statSync(target).isFile()) {
    readManifestFile(index, target, warn);
    return;
  }
  const own = manifestPathForPackageDir(target);
  if (own) {
    readManifestFile(index, own, warn);
    return;
  }
  for (const entry of readdirSync(target).sort()) {
    const child = join(target, entry);
    if (entry.endsWith('.json')) {
      readManifestFile(index, child, warn);
    } else if (statSync(child).isDirectory()) {
      const file = manifestPathForPackageDir(child);
      if (file) readManifestFile(index, file, warn);
    }
  }
}

/** Walk up from `start` for the SMRT monorepo root (`packages/*` + workspace file). */
export function findSmrtWorkspace(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) &&
      existsSync(join(current, 'packages', 'core', 'package.json'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** Load workspace and installed manifests visible from `dir`. */
export function loadLocalManifests(
  index: RecipeIndex,
  dir: string,
  warn: (message: string) => void = () => {},
): void {
  const workspace = findSmrtWorkspace(dir);
  if (workspace) {
    const packagesDir = join(workspace, 'packages');
    for (const entry of readdirSync(packagesDir).sort()) {
      const manifest = manifestPathForPackageDir(join(packagesDir, entry));
      if (manifest) readManifestFile(index, manifest, warn);
    }
  }
  let current = resolve(dir);
  while (true) {
    const scope = join(current, 'node_modules', SMRT_SCOPE);
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope).sort()) {
        if (!entry.startsWith(PACKAGE_PREFIX)) continue;
        const manifest = manifestPathForPackageDir(join(scope, entry));
        if (manifest) readManifestFile(index, manifest, warn);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Recipe id prefixes whose package name differs from `smrt-<prefix>`. */
const PREFIX_PACKAGE_ALIASES: Record<string, string> = {
  integrations: 'webhooks',
};

/** The package that conventionally owns a recipe id (`commerce.sales` -> smrt-commerce). */
export function candidatePackageForRecipe(id: string): string {
  const prefix = id.split('.')[0] ?? id;
  return `${SMRT_SCOPE}/${PACKAGE_PREFIX}${PREFIX_PACKAGE_ALIASES[prefix] ?? prefix}`;
}

/** The package a qualified object (`@scope/pkg:Class`) belongs to, if qualified. */
export function packageOfQualifiedName(ref: string): string | null {
  const at = ref.lastIndexOf(':');
  if (!ref.startsWith('@') || at <= 0) return null;
  return ref.slice(0, at);
}

/**
 * Fetch a package's manifest from the registry that owns its scope, without
 * installing it. Returns false when the package or its manifest is missing.
 */
export async function loadRegistryManifest(
  index: RecipeIndex,
  packageName: string,
  options: RegistryOptions = {},
): Promise<boolean> {
  const tarball = await fetchPackageTarball(packageName, options);
  if (!tarball) return false;
  const work = mkdtempSync(join(tmpdir(), 'smrt-cookbook-'));
  try {
    await extractTarball(
      tarball.data,
      work,
      (path) =>
        path === 'package/package.json' || path.endsWith('manifest.json'),
    );
    const file = manifestPathForPackageDir(join(work, 'package'));
    if (!file) return false;
    return addManifest(
      index,
      JSON.parse(readFileSync(file, 'utf-8')),
      `${tarball.registry}/${packageName.replace('/', '%2F')}@${tarball.version ?? 'latest'}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** What a cookbook needs resolved, for the registry-fill loop. */
export function neededPackages(
  index: RecipeIndex,
  cookbook: {
    recipes?: string[];
    features?: string[];
    policies?: Array<{ objectRef?: string }>;
  },
): string[] {
  const packages = new Set<string>();
  const queue = [...(cookbook.recipes ?? [])];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = index.recipes.get(id);
    if (!entry) {
      packages.add(candidatePackageForRecipe(id));
      continue;
    }
    queue.push(...entry.requires, ...entry.requiresAny.flat());
  }
  for (const ref of [
    ...(cookbook.features ?? []),
    ...(cookbook.policies ?? []).map((p) => p.objectRef ?? ''),
  ]) {
    const pkg = packageOfQualifiedName(ref);
    if (pkg) packages.add(pkg);
  }
  return [...packages].filter(
    (name) => !index.packages.has(name) && !index.missing.has(name),
  );
}

export interface ResolveOptions {
  /** Project (or working) directory to look for installed manifests from. */
  dir: string;
  manifests?: string[];
  registry?: boolean;
  registryOptions?: RegistryOptions;
  warn?: (message: string) => void;
}

/**
 * Build the index a cookbook needs: local sources first, then the registry
 * for packages still unresolved, repeating until no new package appears.
 */
export async function resolveRecipeIndex(
  cookbook: Parameters<typeof neededPackages>[1],
  options: ResolveOptions,
): Promise<RecipeIndex> {
  const warn = options.warn ?? (() => {});
  const index = createRecipeIndex();
  for (const path of options.manifests ?? []) {
    loadManifestPath(index, path, warn);
  }
  loadLocalManifests(index, options.dir, warn);
  if (options.registry === false) return index;
  for (let round = 0; round < 8; round += 1) {
    const needed = neededPackages(index, cookbook);
    if (needed.length === 0) break;
    for (const name of needed) {
      const loaded = await loadRegistryManifest(index, name, {
        dir: options.dir,
        ...options.registryOptions,
      });
      if (!loaded) index.missing.add(name);
    }
  }
  return index;
}
