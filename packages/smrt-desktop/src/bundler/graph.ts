import { asciiLower } from '../internal/grammar.js';
import {
  isSafeName,
  nodeTreeFs,
  readRegularText,
  resolveInside,
  type TreeFs,
} from './paths.js';
import { collectEntryPaths } from './prune.js';
import { BundleTreeError, toTreeError } from './tree-errors.js';

/**
 * Dependency graph of a hoisted production `node_modules` tree and the
 * exclusive-subtree computation behind per-feature segmentation (design 4.1).
 *
 * The graph is read from the installed `package.json` files only, with Node's
 * resolution order (the package's own `node_modules`, then each enclosing
 * `node_modules` upward) and no other tool. Segmentation only ever removes:
 * a package is removed when it matches a disabled pattern, or when every path
 * from the application's direct dependencies to it passes through such a
 * package. Packages that no direct dependency reaches at all ("orphans") are
 * kept and reported, because they might be loaded in a way the graph cannot
 * see.
 *
 * Ids are `node_modules`-style paths (`node_modules/a/node_modules/@s/b`);
 * `dir` is the same path relative to the `node_modules` root (`a/node_modules/@s/b`)
 * and is what the file filters use.
 */

export const APP_ROOT = '<app>';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_PACKAGES = 50_000;
const MAX_NESTING = 32;

export interface InstalledPackage {
  readonly id: string;
  readonly dir: string;
  /** Name implied by the directory (differs from `name` for npm aliases). */
  readonly installName: string;
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
  /** Install-time script names present (`preinstall`, `install`, `postinstall`). */
  readonly installScripts: readonly string[];
  readonly gypfile: boolean;
  /** Files and directories `main`/`module`/`bin`/`exports` point at. */
  readonly entryPaths: readonly string[];
}

// ---------------------------------------------------------------------------
// Reading the installed tree
// ---------------------------------------------------------------------------

function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BundleTreeError('invalid_package_json');
  }
  const out: Record<string, string> = Object.create(null);
  for (const [key, spec] of Object.entries(value)) {
    if (typeof spec !== 'string') {
      throw new BundleTreeError('invalid_package_json');
    }
    out[key] = spec;
  }
  return out;
}

function parseManifest(
  text: string,
  id: string,
  dir: string,
  installName: string,
): InstalledPackage {
  let json: unknown;
  try {
    json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new BundleTreeError('invalid_package_json', { subjects: [dir] });
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new BundleTreeError('invalid_package_json', { subjects: [dir] });
  }
  const record = json as Record<string, unknown>;
  try {
    if (typeof record.name !== 'string' || record.name.length === 0) {
      throw new BundleTreeError('invalid_package_json');
    }
    if (typeof record.version !== 'string' || record.version.length === 0) {
      throw new BundleTreeError('invalid_package_json');
    }
    const scripts =
      record.scripts !== null &&
      typeof record.scripts === 'object' &&
      !Array.isArray(record.scripts)
        ? (record.scripts as Record<string, unknown>)
        : {};
    return {
      id,
      dir,
      installName,
      name: record.name,
      version: record.version,
      dependencies: stringMap(record.dependencies),
      optionalDependencies: stringMap(record.optionalDependencies),
      peerDependencies: stringMap(record.peerDependencies),
      installScripts: ['preinstall', 'install', 'postinstall'].filter(
        (script) => typeof scripts[script] === 'string',
      ),
      gypfile: record.gypfile === true,
      entryPaths: collectEntryPaths(record),
    };
  } catch (error) {
    if (error instanceof BundleTreeError) {
      throw new BundleTreeError(error.code, { subjects: [dir] });
    }
    throw error;
  }
}

export interface ReadPackagesOptions {
  readonly fs?: TreeFs;
  readonly platform?: NodeJS.Platform;
}

/**
 * Read every package under the hoisted `node_modules` directory `root`
 * (absolute), including nested `node_modules`. Hidden entries (`.bin`,
 * `.pnpm`, `.package-lock.json`) are not packages and are skipped; any
 * symlink where a package is expected is refused.
 */
export async function readInstalledPackages(
  root: string,
  options: ReadPackagesOptions = {},
): Promise<InstalledPackage[]> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const found: InstalledPackage[] = [];

  async function lstat(segments: readonly string[]) {
    try {
      return await fs.lstat(resolveInside(root, segments, platform));
    } catch (error) {
      throw toTreeError(error);
    }
  }

  async function readPackage(
    segments: readonly string[],
    installName: string,
    depth: number,
  ): Promise<void> {
    const dir = segments.join('/');
    if (depth > MAX_NESTING) {
      throw new BundleTreeError('tree_too_deep', { subjects: [dir] });
    }
    const manifestPath = resolveInside(
      root,
      [...segments, 'package.json'],
      platform,
    );
    let text: string;
    try {
      const stats = await fs.lstat(manifestPath);
      if (!stats.isFile()) {
        throw new BundleTreeError('invalid_package_json', { subjects: [dir] });
      }
      text = await readRegularText(manifestPath, MAX_MANIFEST_BYTES, { fs });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') {
        throw new BundleTreeError('invalid_package_json', { subjects: [dir] });
      }
      if (error instanceof BundleTreeError) throw error;
      throw toTreeError(error);
    }
    if (found.length >= MAX_PACKAGES) {
      throw new BundleTreeError('too_many_files');
    }
    found.push(parseManifest(text, `node_modules/${dir}`, dir, installName));
    await readContainer([...segments, 'node_modules'], depth + 1, true);
  }

  async function readContainer(
    segments: readonly string[],
    depth: number,
    optional: boolean,
  ): Promise<void> {
    let names: string[];
    try {
      const stats = await lstat(segments);
      if (stats.isSymbolicLink()) {
        throw new BundleTreeError('symlink_refused', {
          subjects: [segments.join('/')],
        });
      }
      if (!stats.isDirectory()) return;
      names = await fs.readdir(resolveInside(root, segments, platform));
    } catch (error) {
      // `lstat` maps a missing nested `node_modules` to `entry_changed`.
      if (
        optional &&
        error instanceof BundleTreeError &&
        error.code === 'entry_changed'
      ) {
        return;
      }
      throw error instanceof BundleTreeError ? error : toTreeError(error);
    }
    names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    for (const name of names) {
      if (name.startsWith('.')) continue;
      const rel = [...segments, name].join('/');
      if (!isSafeName(name)) {
        throw new BundleTreeError('invalid_name', { subjects: [rel] });
      }
      const stats = await lstat([...segments, name]);
      if (stats.isSymbolicLink()) {
        throw new BundleTreeError('symlink_refused', { subjects: [rel] });
      }
      if (!stats.isDirectory()) continue;
      if (name.startsWith('@')) {
        const scopeNames = await fs
          .readdir(resolveInside(root, [...segments, name], platform))
          .catch((error) => {
            throw toTreeError(error);
          });
        scopeNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const child of scopeNames) {
          if (child.startsWith('.')) continue;
          const childRel = `${rel}/${child}`;
          if (!isSafeName(child)) {
            throw new BundleTreeError('invalid_name', {
              subjects: [childRel],
            });
          }
          const childStats = await lstat([...segments, name, child]);
          if (childStats.isSymbolicLink()) {
            throw new BundleTreeError('symlink_refused', {
              subjects: [childRel],
            });
          }
          if (!childStats.isDirectory()) continue;
          await readPackage(
            [...segments, name, child],
            `${name}/${child}`,
            depth,
          );
        }
        continue;
      }
      await readPackage([...segments, name], name, depth);
    }
  }

  const rootStats = await lstat([]);
  if (rootStats.isSymbolicLink()) throw new BundleTreeError('symlink_refused');
  await readContainer([], 0, false);
  return found;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export interface MissingDependency {
  /** Id of the package that declares the dependency. */
  readonly from: string;
  readonly name: string;
}

export interface DependencyGraph {
  readonly packages: ReadonlyMap<string, InstalledPackage>;
  /** Ids of the application's installed direct dependencies. */
  readonly roots: readonly string[];
  /** Required dependencies that are not installed, sorted. */
  readonly missing: readonly MissingDependency[];
  /** Resolve `name` as `from` would (`APP_ROOT` for the application). */
  resolve(from: string, name: string): string | undefined;
  /** Resolved dependency ids of a package, sorted, without itself. */
  edges(id: string): readonly string[];
}

function containerChain(id: string): string[] {
  if (id === APP_ROOT) return ['node_modules'];
  let segments = id.split('/');
  const chain: string[] = [`${id}/node_modules`];
  for (;;) {
    const marker = segments.lastIndexOf('node_modules');
    if (marker < 0) break;
    chain.push(segments.slice(0, marker + 1).join('/'));
    if (marker === 0) break;
    segments = segments.slice(0, marker);
  }
  return chain;
}

function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the graph. `rootDependencies` is the application's own
 * `dependencies` + `optionalDependencies` name map (the production install
 * has no dev dependencies). Edges follow `dependencies`,
 * `optionalDependencies` and `peerDependencies` that are actually installed.
 */
export function buildDependencyGraph(
  packages: readonly InstalledPackage[],
  rootDependencies: readonly string[],
): DependencyGraph {
  const map = new Map<string, InstalledPackage>();
  for (const pkg of [...packages].sort((a, b) => byId(a.id, b.id))) {
    map.set(pkg.id, pkg);
  }

  const resolve = (from: string, name: string): string | undefined => {
    for (const container of containerChain(from)) {
      const candidate = `${container}/${name}`;
      if (map.has(candidate)) return candidate;
    }
    return undefined;
  };

  const adjacency = new Map<string, string[]>();
  const missing: MissingDependency[] = [];
  for (const pkg of map.values()) {
    const targets = new Set<string>();
    for (const name of Object.keys(pkg.dependencies)) {
      const resolved = resolve(pkg.id, name);
      if (resolved === undefined) {
        if (!(name in pkg.optionalDependencies)) {
          missing.push({ from: pkg.id, name });
        }
      } else {
        targets.add(resolved);
      }
    }
    for (const name of [
      ...Object.keys(pkg.optionalDependencies),
      ...Object.keys(pkg.peerDependencies),
    ]) {
      const resolved = resolve(pkg.id, name);
      if (resolved !== undefined) targets.add(resolved);
    }
    targets.delete(pkg.id);
    adjacency.set(pkg.id, [...targets].sort(byId));
  }
  missing.sort((a, b) => byId(a.from, b.from) || byId(a.name, b.name));

  const roots = [
    ...new Set(
      rootDependencies
        .map((name) => resolve(APP_ROOT, name))
        .filter((id): id is string => id !== undefined),
    ),
  ].sort(byId);

  return {
    packages: map,
    roots,
    missing,
    resolve,
    edges: (id) => adjacency.get(id) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Registry-only specifiers
// ---------------------------------------------------------------------------

const NON_REGISTRY_PROTOCOL =
  /^(?:link|file|portal|workspace|git|git\+[a-z]+|github|gitlab|bitbucket|gist|https?|ssh|data):/i;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/;

/**
 * True for a specifier that resolves from the registry: a semver range, a
 * dist-tag, an `npm:` alias or a pnpm `catalog:`. False for `link:`, `file:`,
 * `portal:`, `workspace:`, git (`git+ssh:`, `github:`, `user/repo`) and
 * http(s) tarball specifiers.
 */
export function isRegistrySpecifier(spec: string): boolean {
  const trimmed = spec.trim();
  if (NON_REGISTRY_PROTOCOL.test(trimmed)) return false;
  if (GITHUB_SHORTHAND.test(trimmed)) return false;
  return !trimmed.startsWith('.') && !trimmed.startsWith('/');
}

export interface NonRegistryDependency {
  /** Id of the declaring package, or `APP_ROOT`. */
  readonly from: string;
  readonly name: string;
}

/**
 * Dependencies (`dependencies`/`optionalDependencies`) of the application
 * and of every installed package whose specifier is not a registry one.
 * Never includes the specifier itself, which may carry credentials.
 */
export function findNonRegistryDependencies(
  packages: readonly InstalledPackage[],
  appDependencies: Readonly<Record<string, string>>,
): NonRegistryDependency[] {
  const out: NonRegistryDependency[] = [];
  const check = (
    from: string,
    maps: readonly Readonly<Record<string, string>>[],
  ) => {
    for (const map of maps) {
      for (const [name, spec] of Object.entries(map)) {
        if (!isRegistrySpecifier(spec)) out.push({ from, name });
      }
    }
  };
  check(APP_ROOT, [appDependencies]);
  for (const pkg of packages) {
    check(pkg.id, [pkg.dependencies, pkg.optionalDependencies]);
  }
  return out.sort((a, b) => byId(a.from, b.from) || byId(a.name, b.name));
}

/** Throw `unsupported_resolution` when any non-registry dependency exists. */
export function assertRegistryDependencies(
  packages: readonly InstalledPackage[],
  appDependencies: Readonly<Record<string, string>>,
): void {
  const bad = findNonRegistryDependencies(packages, appDependencies);
  if (bad.length > 0) {
    throw new BundleTreeError('unsupported_resolution', {
      subjects: bad.map((item) => `${item.from} -> ${item.name}`),
    });
  }
}

/** Throw `unresolved_dependency` when a required dependency is not installed. */
export function assertNoMissingDependencies(graph: DependencyGraph): void {
  if (graph.missing.length > 0) {
    throw new BundleTreeError('unresolved_dependency', {
      subjects: graph.missing.map((item) => `${item.from} -> ${item.name}`),
    });
  }
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/**
 * One disabled feature (or the product's `exclude` list). `patterns` are
 * package names; `*` matches any run of characters except `/`
 * (`@rolldown/*`, `oxc-*`, `@oxc-*\/*`).
 */
export interface DisabledGroup {
  readonly label: string;
  readonly patterns: readonly string[];
}

const patternCache = new Map<string, RegExp>();

/** Match a package name against an exact name or a `*` pattern. */
export function matchPackageName(pattern: string, name: string): boolean {
  let regex = patternCache.get(pattern);
  if (regex === undefined) {
    const source = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&'))
      .join('[^/]*');
    regex = new RegExp(`^${source}$`);
    patternCache.set(pattern, regex);
  }
  return regex.test(asciiLower(name)) || regex.test(name);
}

const PACKAGE_PATTERN = /^(?:@[a-z0-9*._~-]+\/)?[a-z0-9*._~-]+$/;

/** Grammar for one `DisabledGroup` pattern. */
export function isPackagePattern(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 214 &&
    PACKAGE_PATTERN.test(value) &&
    !value.startsWith('.') &&
    !value.startsWith('_')
  );
}

export interface RemovedPackage {
  readonly id: string;
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  /** `<label>` for a matched root, `exclusive-dependency-of:<label>` otherwise. */
  readonly reason: string;
}

export interface Segmentation {
  /** Ids of packages that stay. */
  readonly keep: ReadonlySet<string>;
  readonly removed: readonly RemovedPackage[];
  /** `dir` of every removed package: feed to the file filter. */
  readonly removedDirs: ReadonlySet<string>;
  /** Kept packages that no direct dependency reaches (reported, not removed). */
  readonly orphans: readonly string[];
  /** Group labels whose patterns matched no installed package. */
  readonly unmatchedGroups: readonly string[];
}

function reachable(
  graph: DependencyGraph,
  starts: readonly string[],
  blocked: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue = starts.filter((id) => !blocked.has(id));
  for (const id of queue) seen.add(id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index] as string;
    for (const next of graph.edges(id)) {
      if (seen.has(next) || blocked.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function ancestorDirs(dir: string): string[] {
  const segments = dir.split('/');
  const out: string[] = [];
  for (let index = 0; index < segments.length; index++) {
    if (segments[index] === 'node_modules' && index > 0) {
      out.push(segments.slice(0, index).join('/'));
    }
  }
  return out;
}

/**
 * Compute which installed packages to remove for the disabled `groups`.
 * Cycles are handled by plain reachability: a package in a cycle stays if any
 * member is reachable from a kept package.
 */
export function computeSegmentation(
  graph: DependencyGraph,
  groups: readonly DisabledGroup[],
): Segmentation {
  const matched = new Map<string, string>();
  const matchedGroups = new Set<string>();
  for (const pkg of graph.packages.values()) {
    for (const group of groups) {
      if (
        group.patterns.some(
          (pattern) =>
            matchPackageName(pattern, pkg.name) ||
            matchPackageName(pattern, pkg.installName),
        )
      ) {
        matched.set(pkg.id, group.label);
        matchedGroups.add(group.label);
        break;
      }
    }
  }
  const blocked = new Set(matched.keys());

  const reachAll = reachable(graph, graph.roots, new Set());
  const reachKept = reachable(graph, graph.roots, blocked);

  const removedIds = new Set<string>(matched.keys());
  for (const id of reachAll) if (!reachKept.has(id)) removedIds.add(id);

  const orphans = [...graph.packages.keys()]
    .filter((id) => !reachAll.has(id) && !matched.has(id))
    .sort(byId);

  // A kept package physically inside a removed package directory disappears
  // with it; account for it instead of leaving a dangling "kept" package.
  const removedDirsSoFar = new Set(
    [...removedIds].map(
      (id) => (graph.packages.get(id) as InstalledPackage).dir,
    ),
  );
  const nestedReason = new Map<string, string>();
  for (const pkg of graph.packages.values()) {
    if (removedIds.has(pkg.id)) continue;
    if (ancestorDirs(pkg.dir).some((dir) => removedDirsSoFar.has(dir))) {
      removedIds.add(pkg.id);
      nestedReason.set(pkg.id, 'inside-removed-package');
    }
  }

  // Attribute exclusive dependencies to the first group that reaches them.
  const reason = new Map<string, string>();
  for (const [id, label] of matched) reason.set(id, label);
  for (const group of groups) {
    const starts = [...matched]
      .filter(([, label]) => label === group.label)
      .map(([id]) => id)
      .sort(byId);
    const queue = [...starts];
    for (let index = 0; index < queue.length; index++) {
      for (const next of graph.edges(queue[index] as string)) {
        if (!removedIds.has(next) || reason.has(next)) continue;
        reason.set(next, `exclusive-dependency-of:${group.label}`);
        queue.push(next);
      }
    }
  }
  for (const [id, text] of nestedReason) {
    if (!reason.has(id)) reason.set(id, text);
  }

  const removed: RemovedPackage[] = [...removedIds].sort(byId).map((id) => {
    const pkg = graph.packages.get(id) as InstalledPackage;
    return {
      id,
      dir: pkg.dir,
      name: pkg.name,
      version: pkg.version,
      reason: reason.get(id) ?? 'exclusive-dependency',
    };
  });

  const keep = new Set<string>();
  for (const id of graph.packages.keys()) {
    if (!removedIds.has(id)) keep.add(id);
  }
  return {
    keep,
    removed,
    removedDirs: new Set(removed.map((item) => item.dir)),
    orphans: orphans.filter((id) => keep.has(id)),
    unmatchedGroups: groups
      .map((group) => group.label)
      .filter((label) => !matchedGroups.has(label)),
  };
}

/**
 * Predicate for the import scan: does `name`, as imported from the file
 * owned by `owner` (`APP_ROOT` or a package id), resolve to a removed package?
 */
export function createRemovalChecker(
  graph: DependencyGraph,
  segmentation: Segmentation,
): (owner: string, name: string) => boolean {
  return (owner, name) => {
    const resolved = graph.resolve(owner, name);
    return resolved !== undefined && !segmentation.keep.has(resolved);
  };
}

/** Entry paths per package `dir`, for the pruning filter. */
export function entryPathsByDir(
  packages: Iterable<InstalledPackage>,
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const pkg of packages) out.set(pkg.dir, pkg.entryPaths);
  return out;
}

/**
 * Kept packages that need a build step (install script or `binding.gyp`)
 * and are not on `allowed`. Scripts never run in a bundle, so these cannot
 * be bundled unless they ship prebuilt binaries (checked elsewhere).
 */
export function packagesNeedingBuild(
  packages: Iterable<InstalledPackage>,
  allowed: ReadonlySet<string> = new Set(['protobufjs', 'esbuild', 'fsevents']),
): InstalledPackage[] {
  return [...packages]
    .filter(
      (pkg) =>
        (pkg.installScripts.length > 0 || pkg.gypfile) &&
        !allowed.has(pkg.name),
    )
    .sort((a, b) => byId(a.id, b.id));
}
