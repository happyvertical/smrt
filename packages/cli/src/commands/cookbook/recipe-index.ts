/**
 * Recipe index for `smrt cookbook validate|apply` (#3748).
 *
 * Source of truth: each package's published `dist/manifest.json` (the
 * `./manifest` export), which carries `recipes[]` and the `objects` the
 * cookbook's policies and features point at. Manifests are read from, in
 * order: explicit `--manifests` paths, the SMRT workspace around the working
 * directory, the project's `node_modules`, and finally (opt-out with
 * `--no-registry`) the npm registry for packages that are not installed yet.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { extract } from 'tar';

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
  for (const candidate of [
    join(target, 'dist', 'manifest.json'),
    join(target, 'manifest.json'),
  ]) {
    if (existsSync(candidate)) {
      readManifestFile(index, candidate, warn);
      return;
    }
  }
  for (const entry of readdirSync(target).sort()) {
    const child = join(target, entry);
    if (entry.endsWith('.json')) {
      readManifestFile(index, child, warn);
    } else if (existsSync(join(child, 'dist', 'manifest.json'))) {
      readManifestFile(index, join(child, 'dist', 'manifest.json'), warn);
    } else if (existsSync(join(child, 'manifest.json'))) {
      readManifestFile(index, join(child, 'manifest.json'), warn);
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
      const manifest = join(packagesDir, entry, 'dist', 'manifest.json');
      if (existsSync(manifest)) readManifestFile(index, manifest, warn);
    }
  }
  let current = resolve(dir);
  while (true) {
    const scope = join(current, 'node_modules', SMRT_SCOPE);
    if (existsSync(scope)) {
      for (const entry of readdirSync(scope).sort()) {
        if (!entry.startsWith(PACKAGE_PREFIX)) continue;
        const manifest = join(scope, entry, 'dist', 'manifest.json');
        if (existsSync(manifest)) readManifestFile(index, manifest, warn);
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

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface RegistryOptions {
  registryUrl?: string;
  /** Exact version to try first (the framework line); falls back to latest. */
  versionHint?: string;
  fetchImpl?: FetchLike;
}

export function defaultRegistryUrl(): string {
  return (
    process.env.SMRT_REGISTRY_URL ||
    process.env.npm_config_registry ||
    'https://registry.npmjs.org'
  ).replace(/\/+$/, '');
}

/**
 * Fetch a package's `dist/manifest.json` from the registry without
 * installing it. Returns false when the package or its manifest is missing.
 */
export async function loadRegistryManifest(
  index: RecipeIndex,
  packageName: string,
  options: RegistryOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? (fetch as unknown as FetchLike);
  const base = options.registryUrl ?? defaultRegistryUrl();
  const encoded = packageName.replace('/', '%2F');
  interface RegistryMeta {
    version?: string;
    dist?: { tarball?: string };
  }
  let meta: RegistryMeta | undefined;
  for (const version of [options.versionHint, 'latest']) {
    if (!version) continue;
    try {
      const response = await fetchImpl(`${base}/${encoded}/${version}`);
      if (response.ok) {
        meta = (await response.json()) as RegistryMeta;
        break;
      }
    } catch {
      return false;
    }
  }
  const tarball = meta?.dist?.tarball;
  if (!tarball) return false;
  const response = await fetchImpl(tarball);
  if (!response.ok) return false;
  const work = mkdtempSync(join(tmpdir(), 'smrt-cookbook-'));
  mkdirSync(work, { recursive: true });
  await new Promise<void>((done, fail) => {
    const sink = extract({
      cwd: work,
      filter: (path) => path === 'package/dist/manifest.json',
    });
    sink.on('close', () => done());
    sink.on('error', fail);
    response.arrayBuffer().then((buffer) => {
      Readable.from(Buffer.from(buffer)).pipe(sink);
    }, fail);
  });
  const file = join(work, 'package', 'dist', 'manifest.json');
  if (!existsSync(file)) return false;
  return addManifest(
    index,
    JSON.parse(readFileSync(file, 'utf-8')),
    `${base}/${encoded}@${meta?.version ?? 'latest'}`,
  );
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
      const loaded = await loadRegistryManifest(
        index,
        name,
        options.registryOptions,
      );
      if (!loaded) index.missing.add(name);
    }
  }
  return index;
}
