/**
 * SMRT Package Discovery
 *
 * Discovers all SMRT packages in node_modules by:
 * 1. Scanning node_modules directory for installed packages
 * 2. Following symlinks for workspace: dependencies
 * 3. Checking for a package manifest — the location declared by the package's
 *    own `package.json#exports` map, else `dist/manifest.json`,
 *    `.smrt/manifest.json`, or `src/manifest/manifest.json` — with moduleType: "smrt"
 * 4. Caching results based on lockfile hash and manifest timestamps
 *
 * Cache Strategy:
 * - ENABLED by default (5-50x faster startup)
 * - Automatically invalidates when the lockfile (found by walking up to the
 *   workspace root), the project's package.json, any selected manifest, or the
 *   manifest candidates of a declared dependency that had none change
 * - A failed discovery is never cached
 * - Repeat calls in one process reuse the answer while a stat-only
 *   fingerprint of those inputs is unchanged
 * - Disable with SMRT_DISABLE_DISCOVERY_CACHE=true for debugging
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '../utils/json.js';
import { manifestExportCandidates } from './package-manifest-exports.js';

const CACHE_DIR = '.smrt';
const CACHE_FILE = 'discovery-cache.json';
/**
 * Bump whenever what counts as a discoverable package changes, not only when
 * the cache file's shape changes. Version 5 adds export-map manifest
 * resolution (#2923): a version-4 cache can hold an EMPTY package list, and
 * `getCachedDiscovery()` skips manifest rehashing in that case, so without
 * this bump a project would keep replaying the pre-fix "no packages" answer
 * and never re-probe a package whose manifest is only at, say,
 * `dist/lib/manifest.json`.
 */
const CACHE_VERSION = 8;

/** Timing data for --timing flag */
interface TimingData {
  discovery?: number;
  cacheCheck?: number;
  total?: number;
}

/** Module-level timing storage */
let lastTimingData: TimingData = {};

/**
 * Get timing data from last discovery operation
 */
export function getDiscoveryTiming(): TimingData {
  return { ...lastTimingData };
}

const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

/**
 * The lockfile that governs `baseDir`'s installs: the nearest one at or above
 * it. A workspace app has none of its own (the workspace root holds it), so
 * looking only at `baseDir` would leave the lockfile out of every cache check.
 */
function findLockfile(baseDir: string): string | null {
  let dir = baseDir;
  for (;;) {
    for (const name of LOCKFILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Content hashes keyed by path, reused while the file's size and mtime hold. */
const fileHashMemo = new Map<string, { marker: string; hash: string }>();

function hashFile(path: string): string | null {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  const marker = `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.dev}:${stats.ino}`;
  const memo = fileHashMemo.get(path);
  if (memo?.marker === marker) {
    return memo.hash;
  }
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  fileHashMemo.set(path, { marker, hash });
  return hash;
}

/** Hash of the governing lockfile (see {@link findLockfile}). */
function getLockfileHash(baseDir: string): string | null {
  const lockfile = findLockfile(baseDir);
  return lockfile ? hashFile(lockfile) : null;
}

/**
 * Get hash of package.json for cache invalidation when a package workspace
 * changes its declared dependencies without a colocated lockfile.
 */
function getPackageJsonHash(baseDir: string): string | null {
  return hashFile(join(baseDir, 'package.json'));
}

/** `path:mtime:size`, or `path:missing`: a stat-only change marker. */
function statMarker(path: string): string {
  try {
    const stats = statSync(path);
    // ctime and file identity change on every write or replacement, even
    // when a rebuild keeps the byte length and restores the mtime.
    return `${path}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}:${stats.dev}:${stats.ino}`;
  } catch {
    return `${path}:missing`;
  }
}

/**
 * A discovered SMRT package: where it lives and which manifest describes it.
 *
 * Consumers read the manifest from `manifestPath` instead of re-resolving the
 * name from the app root: a package an app reaches only through another smrt
 * package (smrt-content -> smrt-images) is invisible from the app root under
 * pnpm (#5027).
 */
export interface DiscoveredSmrtPackage {
  /** Real path of the package directory. */
  packageDir: string;
  /** Manifest file `resolveManifestPath` accepted for the package. */
  manifestPath: string;
  /**
   * The package that pulled this one in, when the app does not reach it
   * itself (not in its own `node_modules` or declared dependencies).
   */
  via?: string;
}

export type DiscoveredSmrtPackages = Record<string, DiscoveredSmrtPackage>;

/**
 * Hash the inputs a discovery answer derives from: every stored manifest's
 * mtime (so a rebuilt manifest, including one only reachable transitively,
 * invalidates) and every stored package's `package.json` (the transitive set
 * derives from their dependency lists).
 */
function getLocationsHash(packages: DiscoveredSmrtPackages): string {
  const parts: string[] = [];
  for (const name of Object.keys(packages).sort()) {
    const { manifestPath, packageDir } = packages[name];
    for (const file of [manifestPath, join(packageDir, 'package.json')]) {
      try {
        parts.push(`${name}:${file}:${statSync(file).mtimeMs}`);
      } catch {
        parts.push(`${name}:${file}:missing`);
      }
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * A dependency the project declares, whose directory was found but which had
 * no SMRT manifest when discovery ran. A workspace package is commonly linked
 * before it is first built; building it must invalidate the cached answer.
 */
interface DiscoveryProbe {
  /** The dependency name it was reached under. */
  name: string;
  packageDir: string;
  /** {@link probeSignature} of `packageDir` when discovery ran. */
  signature: string;
}

/** Probes keyed by resolved package directory. */
type DiscoveryProbes = Record<string, DiscoveryProbe>;

interface DiscoveryCache {
  version: number;
  lockfileHash: string | null;
  packageJsonHash: string | null;
  manifestsHash: string;
  timestamp: number;
  packages: DiscoveredSmrtPackages;
  probes: DiscoveryProbes;
}

interface DiscoveryResult {
  packages: DiscoveredSmrtPackages;
  probes: DiscoveryProbes;
  /** False when discovery threw part way: such a result is never cached. */
  complete: boolean;
}

/**
 * Every manifest file that exists for a package, in preference order.
 *
 * This returns ALL of them rather than just the first, because existing is not
 * the same as being a manifest. An export target can exist and still be
 * unusable here: `./manifest` is commonly a JS module (`@happyvertical/smrt-core`
 * itself maps it to `dist/manifest.js`) and `./static-manifest` always is, and
 * an exported JSON file can be stale or malformed. Stopping at the first
 * existing path would let any of those hide a perfectly good
 * `dist/manifest.json` and drop the package silently — the very #2923 failure
 * mode this file is fixing.
 */
function manifestPathCandidates(pkgPath: string): string[] {
  return allManifestPathCandidates(pkgPath).filter((candidate) =>
    existsSync(candidate),
  );
}

/** Export-map candidates, reused while the package's package.json holds. */
const exportCandidateMemo = new Map<
  string,
  { marker: string; candidates: string[] }
>();

/** Every manifest location probed for a package, existing or not. */
function allManifestPathCandidates(pkgPath: string): string[] {
  const marker = statMarker(join(pkgPath, 'package.json'));
  let exported = exportCandidateMemo.get(pkgPath);
  if (exported?.marker !== marker) {
    exported = { marker, candidates: manifestExportCandidates(pkgPath) };
    exportCandidateMemo.set(pkgPath, exported);
  }
  return [
    ...exported.candidates,
    join(pkgPath, 'dist', 'manifest.json'),
    join(pkgPath, '.smrt', 'manifest.json'),
    join(pkgPath, 'src', 'manifest', 'manifest.json'),
  ];
}

/**
 * Stat-only signature of everything manifest selection reads for a package:
 * its package.json and each candidate location. A candidate appearing,
 * disappearing or being rewritten changes it.
 */
function probeSignature(pkgPath: string): string {
  return [
    statMarker(join(pkgPath, 'package.json')),
    ...allManifestPathCandidates(pkgPath).map(statMarker),
  ].join('|');
}

function normalizePackagePath(pkgPath: string): string {
  try {
    return realpathSync(pkgPath);
  } catch {
    return pkgPath;
  }
}

/** Per-discovery memo of `resolvePackageDir` results, keyed by directory. */
type ResolutionMemo = Map<string, string | null>;

function resolvePackageDir(
  packageName: string,
  baseDir: string = process.cwd(),
  memo?: ResolutionMemo,
): string | null {
  const key = `${baseDir}\0${packageName}`;
  if (memo?.has(key)) {
    return memo.get(key) ?? null;
  }
  const resolved = resolvePackageDirUncached(packageName, baseDir);
  memo?.set(key, resolved);
  return resolved;
}

function resolvePackageDirUncached(
  packageName: string,
  baseDir: string,
): string | null {
  try {
    const requireFromBase = createRequire(join(baseDir, 'package.json'));
    const packageEntry = requireFromBase.resolve(packageName);
    let currentDir = dirname(packageEntry);
    let resolvedPackageDir: string | null = null;

    for (let i = 0; i < 10; i++) {
      const packageJsonPath = join(currentDir, 'package.json');

      if (existsSync(packageJsonPath)) {
        const packageJson = parse<{ name?: string }>(
          readFileSync(packageJsonPath, 'utf-8'),
        );

        if (packageJson.name === packageName) {
          resolvedPackageDir = currentDir;
        }
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }

    if (resolvedPackageDir) {
      return normalizePackagePath(resolvedPackageDir);
    }
  } catch {
    // Fall through to direct node_modules lookup below.
  }

  // Node's lookup order: the nearest `node_modules` up the tree. Needed for an
  // ESM-only package (no `require` condition makes `resolve()` throw) reached
  // from a dependent in pnpm's virtual store, where the sibling lives in an
  // ancestor `node_modules`, not under the dependent itself (#5027).
  let dir = baseDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', packageName);
    if (existsSync(candidate)) {
      return normalizePackagePath(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function resolveManifestPath(
  packageName: string,
  baseDir: string = process.cwd(),
  memo?: ResolutionMemo,
): string | null {
  const pkgPath = resolvePackageDir(packageName, baseDir, memo);
  if (!pkgPath) {
    return null;
  }

  return selectManifestPath(pkgPath);
}

/**
 * The manifest `resolveManifestPath` would pick for a package directory.
 * Also used to revalidate a cached choice: a build can create a preferred
 * manifest (`dist/`) while the cached one (`.smrt/`) stays untouched.
 */
function selectManifestPath(pkgPath: string): string | null {
  // Take the first candidate that actually parses as a SMRT manifest. A
  // candidate that exists but is a JS module, stale, or malformed must not end
  // the search, or it would mask a valid conventional manifest behind it.
  for (const manifestPath of manifestPathCandidates(pkgPath)) {
    try {
      const manifest = parse<{ moduleType?: string; artifactPurpose?: string }>(
        readFileSync(manifestPath, 'utf-8'),
      );

      if (
        manifest.moduleType === 'smrt' &&
        manifest.artifactPurpose !== 'test'
      ) {
        return manifestPath;
      }
    } catch {
      // Not a readable JSON manifest; try the next candidate.
    }
  }

  return null;
}

/**
 * Load cached discovery results if valid
 * Cache is invalidated if:
 * - Lockfile or package.json hash changed (dependencies changed)
 * - Any stored manifest or package.json changed (SMRT packages rebuilt),
 *   including packages reached only through another package (#5027)
 */
function getCachedDiscovery(
  baseDir: string,
  verbose: boolean,
): DiscoveryResult | null {
  const cachePath = join(baseDir, CACHE_DIR, CACHE_FILE);

  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const cache: DiscoveryCache = parse(readFileSync(cachePath, 'utf-8'));
    if (cache.version !== CACHE_VERSION) {
      if (verbose) {
        console.log('[discovery] Cache invalid: discovery version changed');
      }
      return null;
    }

    if (cache.lockfileHash !== getLockfileHash(baseDir)) {
      if (verbose) {
        console.log('[discovery] Cache invalid: lockfile changed');
      }
      return null;
    }

    if (cache.packageJsonHash !== getPackageJsonHash(baseDir)) {
      if (verbose) {
        console.log('[discovery] Cache invalid: package.json changed');
      }
      return null;
    }

    // The stored manifest must still be the one selection would pick now.
    for (const location of Object.values(cache.packages)) {
      if (selectManifestPath(location.packageDir) !== location.manifestPath) {
        if (verbose) {
          console.log('[discovery] Cache invalid: manifest selection changed');
        }
        return null;
      }
    }

    // Hash the stored locations even when empty, so the check never skips.
    if (cache.manifestsHash !== getLocationsHash(cache.packages)) {
      if (verbose) {
        console.log('[discovery] Cache invalid: manifest(s) changed');
      }
      return null;
    }

    // A declared dependency that had no manifest may have been built since.
    if (!probesUnchanged(cache.probes)) {
      if (verbose) {
        console.log(
          '[discovery] Cache invalid: a dependency without a manifest changed',
        );
      }
      return null;
    }

    return { packages: cache.packages, probes: cache.probes, complete: true };
  } catch (error) {
    if (verbose) {
      console.warn(
        '[discovery] Failed to read cache:',
        (error as Error).message,
      );
    }
    return null;
  }
}

function probesUnchanged(probes: unknown): boolean {
  if (!probes || typeof probes !== 'object' || Array.isArray(probes)) {
    return false;
  }
  return Object.values(probes as DiscoveryProbes).every(
    (probe) =>
      typeof probe?.packageDir === 'string' &&
      probeSignature(probe.packageDir) === probe.signature,
  );
}

/**
 * Save discovery results to cache
 */
function saveCachedDiscovery(
  baseDir: string,
  result: DiscoveryResult,
  verbose: boolean,
): void {
  const { packages, probes } = result;
  const cache: DiscoveryCache = {
    version: CACHE_VERSION,
    lockfileHash: getLockfileHash(baseDir),
    packageJsonHash: getPackageJsonHash(baseDir),
    manifestsHash: getLocationsHash(packages),
    timestamp: Date.now(),
    packages,
    probes,
  };

  try {
    mkdirSync(join(baseDir, CACHE_DIR), { recursive: true });
    writeFileSync(
      join(baseDir, CACHE_DIR, CACHE_FILE),
      JSON.stringify(cache, null, 2),
    );
    if (verbose) {
      console.log(
        `[discovery] Saved cache with ${Object.keys(packages).length} package(s)`,
      );
    }
  } catch (error) {
    if (verbose) {
      console.warn(
        '[discovery] Failed to save cache:',
        (error as Error).message,
      );
    }
  }
}

/**
 * Check if a package provides a SMRT manifest
 *
 * Supports both regular npm dependencies and workspace: symlinks
 */
function hasManifestExport(
  packageName: string,
  baseDir: string,
  memo?: ResolutionMemo,
): boolean {
  return resolveManifestPath(packageName, baseDir, memo) !== null;
}

/** Every dependency name `baseDir`'s package.json declares. */
function getDeclaredDependencyNames(baseDir: string): string[] {
  try {
    const packageJson = parse<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }>(readFileSync(join(baseDir, 'package.json'), 'utf-8'));
    return Object.keys({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
      ...packageJson.optionalDependencies,
    });
  } catch {
    return [];
  }
}

function getDeclaredSmrtPackages(
  baseDir: string,
  verbose: boolean,
  memo?: ResolutionMemo,
): string[] {
  const packageJsonPath = join(baseDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const packageJson = parse<{
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }>(readFileSync(packageJsonPath, 'utf-8'));

    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
      ...packageJson.peerDependencies,
    };

    return Object.keys(allDeps).filter((pkgName) => {
      if (!pkgName.startsWith('@happyvertical/smrt-')) {
        return false;
      }

      const hasManifest = hasManifestExport(pkgName, baseDir, memo);
      if (verbose && hasManifest) {
        console.log(`[discovery] ✅ Found declared SMRT package: ${pkgName}`);
      }

      return hasManifest;
    });
  } catch (error) {
    if (verbose) {
      console.warn(
        '[discovery] Failed to read declared dependencies:',
        (error as Error).message,
      );
    }
    return [];
  }
}

/**
 * Scan node_modules recursively for packages
 */
function* scanNodeModules(baseDir: string): Generator<string> {
  const nodeModulesPath = join(baseDir, 'node_modules');

  if (!existsSync(nodeModulesPath)) {
    return;
  }

  try {
    const entries = readdirSync(nodeModulesPath);

    for (const entry of entries) {
      if (entry === '.bin' || entry === '.pnpm' || entry === '.cache') {
        continue;
      }

      const entryPath = join(nodeModulesPath, entry);

      try {
        const stats = statSync(entryPath);

        if (stats.isDirectory() || stats.isSymbolicLink()) {
          // Scoped packages (e.g., @happyvertical/smrt-core)
          if (entry.startsWith('@')) {
            const scopeEntries = readdirSync(entryPath);
            for (const scopedPkg of scopeEntries) {
              yield `${entry}/${scopedPkg}`;
            }
          } else {
            // Regular packages
            yield entry;
          }
        }
      } catch {}
    }
  } catch (error) {
    // node_modules doesn't exist or can't be read
    return;
  }
}

function locate(
  name: string,
  from: string,
  memo: ResolutionMemo,
  via?: string,
): DiscoveredSmrtPackage | null {
  const packageDir = resolvePackageDir(name, from, memo);
  const manifestPath = resolveManifestPath(name, from, memo);
  if (!packageDir || !manifestPath) return null;
  return { packageDir, manifestPath, ...(via ? { via } : {}) };
}

/**
 * Follow smrt packages through the smrt packages they depend on (#5027).
 *
 * A package an app reaches only through another smrt package (smrt-content ->
 * smrt-images) is loaded at runtime and can add columns to a shared STI table,
 * but pnpm keeps it out of the app's `node_modules`. Resolve each dependency
 * from the directory of the package that declares it and record where it
 * lives. Only `dependencies` and `optionalDependencies` are followed: a peer
 * is the host's to provide, so the host's own declaration already covers it.
 */
function addTransitiveSmrtPackages(
  found: DiscoveredSmrtPackages,
  memo: ResolutionMemo,
  verbose: boolean,
  probes: DiscoveryProbes,
): void {
  const queue = Object.keys(found);
  const visited = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift() as string;
    const current = found[name];
    if (!current || visited.has(current.packageDir)) continue;
    visited.add(current.packageDir);

    let dependencies: string[];
    try {
      const packageJson = parse<{
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }>(readFileSync(join(current.packageDir, 'package.json'), 'utf-8'));
      dependencies = Object.keys({
        ...packageJson.dependencies,
        ...packageJson.optionalDependencies,
      }).filter((dependency) => dependency.startsWith('@happyvertical/smrt-'));
    } catch {
      continue;
    }

    for (const dependency of dependencies) {
      if (found[dependency]) continue;
      const location = locate(dependency, current.packageDir, memo, name);
      if (!location) {
        recordProbe(probes, dependency, current.packageDir, memo);
        continue;
      }
      found[dependency] = location;
      queue.push(dependency);
      if (verbose) {
        console.log(
          `[discovery] ✅ Found transitive SMRT package: ${dependency} (via ${name})`,
        );
      }
    }
  }
}

/**
 * Remember a dependency whose directory resolved but which has no manifest
 * yet, so a later build of it invalidates the cached answer. Keyed by the
 * resolved directory: two installs of one dependency name are two probes,
 * and building either one invalidates the answer.
 */
function recordProbe(
  probes: DiscoveryProbes,
  name: string,
  from: string,
  memo: ResolutionMemo,
): void {
  const packageDir = resolvePackageDir(name, from, memo);
  if (!packageDir || probes[packageDir]) return;
  probes[packageDir] = {
    name,
    packageDir,
    signature: probeSignature(packageDir),
  };
}

/**
 * Perform fresh discovery of SMRT packages
 */

function performDiscovery(baseDir: string, verbose: boolean): DiscoveryResult {
  if (verbose) {
    console.log('[discovery] Scanning node_modules for SMRT packages...');
  }

  const probes: DiscoveryProbes = {};
  try {
    const memo: ResolutionMemo = new Map();
    const found: DiscoveredSmrtPackages = {};

    // Scan node_modules for all packages
    for (const pkgName of scanNodeModules(baseDir)) {
      const location = locate(pkgName, baseDir, memo);
      if (location) {
        found[pkgName] = location;
        if (verbose) {
          console.log(`[discovery] ✅ Found SMRT package: ${pkgName}`);
        }
      }
    }

    for (const pkgName of getDeclaredSmrtPackages(baseDir, verbose, memo)) {
      const location = found[pkgName] ?? locate(pkgName, baseDir, memo);
      if (location) found[pkgName] = location;
    }

    for (const pkgName of getDeclaredDependencyNames(baseDir)) {
      if (!found[pkgName]) recordProbe(probes, pkgName, baseDir, memo);
    }

    addTransitiveSmrtPackages(found, memo, verbose, probes);

    if (verbose) {
      console.log(
        `[discovery] Discovered ${Object.keys(found).length} SMRT package(s)`,
      );
    }

    return { packages: found, probes, complete: true };
  } catch (error) {
    console.error(
      '[discovery] Failed to discover packages:',
      (error as Error).message,
    );
    return { packages: {}, probes, complete: false };
  }
}

/**
 * In-process reuse of a discovery answer (X3-4: a registry miss used to
 * re-read and re-hash the lockfile on every call). Keyed by `baseDir`; valid
 * while {@link discoveryFingerprint} is unchanged.
 */
const discoveryMemo = new Map<
  string,
  {
    fingerprint: string;
    packages: DiscoveredSmrtPackages;
    probes: DiscoveryProbes;
  }
>();

/**
 * Stat-only fingerprint of every input a discovery answer depends on: the
 * cache file, the lockfile, the project's package.json, and each found or
 * probed package's manifest candidates. No file is read or hashed unless a
 * package.json changed since its export candidates were last parsed.
 */
function discoveryFingerprint(
  baseDir: string,
  result: Pick<DiscoveryResult, 'packages' | 'probes'>,
): string {
  const lockfile = findLockfile(baseDir);
  return [
    statMarker(join(baseDir, CACHE_DIR, CACHE_FILE)),
    lockfile ? statMarker(lockfile) : 'no-lockfile',
    statMarker(join(baseDir, 'package.json')),
    ...Object.keys(result.packages)
      .sort()
      .map(
        (name) => `${name}=${probeSignature(result.packages[name].packageDir)}`,
      ),
    ...Object.keys(result.probes)
      .sort()
      .map(
        (name) => `${name}?${probeSignature(result.probes[name].packageDir)}`,
      ),
  ].join('\n');
}

function rememberDiscovery(baseDir: string, result: DiscoveryResult): void {
  if (!result.complete) {
    discoveryMemo.delete(baseDir);
    return;
  }
  discoveryMemo.set(baseDir, {
    fingerprint: discoveryFingerprint(baseDir, result),
    packages: result.packages,
    probes: result.probes,
  });
}

export interface DiscoveryOptions {
  /** Override project root for discovery/cache */
  baseDir?: string;
  /** Force fresh discovery, ignoring cache */
  noCache?: boolean;
  /** Show verbose output */
  verbose?: boolean;
  /** Record timing data */
  timing?: boolean;
}

/**
 * Main discovery function
 *
 * Cache ENABLED by default (5-50x faster startup)
 * - Automatically invalidates when lockfile changes (dependencies updated)
 * - Automatically invalidates when any manifest.json changes (packages rebuilt)
 *
 * Disable with SMRT_DISABLE_DISCOVERY_CACHE=true for debugging
 *
 * Intentional split (#1579): this is the **build-time** discovery path —
 * synchronous, scans `node_modules` for `manifest.json` files with
 * `moduleType: "smrt"`, and caches by lockfile/manifest hash for fast manifest
 * generation. It is deliberately distinct from the consumer-plugin's
 * `discoverSmrtPackages(projectRoot)` (`src/consumer-plugin/index.ts`), which is
 * **async**, reads a downstream app's `package.json` dependency names with a
 * lightweight `@have/`/`smrt` heuristic, and runs inside the Vite consumer
 * plugin. Different inputs, contexts, and lifecycles — not duplicated logic to
 * consolidate.
 */
export function discoverSmrtPackageLocations(
  options: DiscoveryOptions = {},
): DiscoveredSmrtPackages {
  const startTime = options.timing ? performance.now() : 0;
  lastTimingData = {};
  const baseDir = options.baseDir || process.cwd();

  const cacheDisabled =
    options.noCache || process.env.SMRT_DISABLE_DISCOVERY_CACHE === 'true';

  const verbose: boolean =
    options.verbose === true ||
    process.env.SMRT_VERBOSE === 'true' ||
    !!process.env.DEBUG?.includes('smrt');

  if (cacheDisabled) {
    if (verbose) {
      console.log('[discovery] Cache disabled, performing fresh discovery...');
    }

    const { packages } = performDiscovery(baseDir, verbose);

    if (options.timing) {
      lastTimingData.discovery = performance.now() - startTime;
      lastTimingData.total = lastTimingData.discovery;
    }

    return packages;
  }

  // Try the in-process answer, then the on-disk cache.
  const cacheCheckStart = options.timing ? performance.now() : 0;
  const remembered = discoveryMemo.get(baseDir);
  const memoHit =
    remembered !== undefined &&
    remembered.fingerprint === discoveryFingerprint(baseDir, remembered);
  const cached = memoHit ? remembered : getCachedDiscovery(baseDir, verbose);

  if (options.timing) {
    lastTimingData.cacheCheck = performance.now() - cacheCheckStart;
  }

  if (cached) {
    if (!memoHit) {
      rememberDiscovery(baseDir, { ...cached, complete: true });
    }
    if (verbose) {
      console.log(
        `[discovery] ✅ Using cached SMRT packages (${Object.keys(cached.packages).length} package(s))`,
      );
    }

    if (options.timing) {
      lastTimingData.total = performance.now() - startTime;
    }

    return { ...cached.packages };
  }

  // No valid cache - perform fresh discovery
  if (verbose) {
    console.log('[discovery] Cache miss, performing discovery...');
  }

  const discoveryStart = options.timing ? performance.now() : 0;
  const result = performDiscovery(baseDir, verbose);

  if (options.timing) {
    lastTimingData.discovery = performance.now() - discoveryStart;
  }

  // A failed discovery is not an answer: caching its empty result would keep
  // every package out until an input happened to change.
  if (result.complete) {
    saveCachedDiscovery(baseDir, result, verbose);
  }
  rememberDiscovery(baseDir, result);

  if (options.timing) {
    lastTimingData.total = performance.now() - startTime;
  }

  return { ...result.packages };
}

/**
 * Names of the SMRT packages the app itself reaches (its own `node_modules`
 * or declared dependencies). Packages found only through another smrt package
 * are excluded: this list feeds generated surfaces (routes, `register.js`,
 * `smrtDependencies`), and an app must not silently gain those for a package
 * it never consumed (#5027). Schema-level consumers (stamp, base classes,
 * aggregation) want {@link discoverSmrtPackageLocations} instead.
 */
export function discoverSmrtPackages(options: DiscoveryOptions = {}): string[] {
  const locations = discoverSmrtPackageLocations(options);
  return Object.keys(locations).filter((name) => !locations[name].via);
}

// Run if called directly
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const noCache = process.argv.includes('--no-cache');
  const verbose =
    process.argv.includes('--verbose') || process.argv.includes('-v');
  const timing = process.argv.includes('--timing');

  const packages = discoverSmrtPackages({ noCache, verbose, timing });

  console.log('\nDiscovered SMRT packages:');
  console.log(JSON.stringify(packages, null, 2));

  if (timing) {
    const timingData = getDiscoveryTiming();
    console.log('\nTiming:');
    if (timingData.cacheCheck !== undefined) {
      console.log(`  Cache check: ${timingData.cacheCheck.toFixed(2)}ms`);
    }
    if (timingData.discovery !== undefined) {
      console.log(`  Discovery:   ${timingData.discovery.toFixed(2)}ms`);
    }
    if (timingData.total !== undefined) {
      console.log(`  Total:       ${timingData.total.toFixed(2)}ms`);
    }
  }
}
