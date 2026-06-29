/**
 * SMRT Package Discovery
 *
 * Discovers all SMRT packages in node_modules by:
 * 1. Scanning node_modules directory for installed packages
 * 2. Following symlinks for workspace: dependencies
 * 3. Checking for a package manifest (`dist/manifest.json`,
 *    `.smrt/manifest.json`, or `src/manifest/manifest.json`) with moduleType: "smrt"
 * 4. Caching results based on lockfile hash and manifest timestamps
 *
 * Cache Strategy:
 * - ENABLED by default (5-50x faster startup)
 * - Automatically invalidates when lockfile or any manifest.json changes
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
import { parse } from '../utils/json.js';

const CACHE_DIR = '.smrt';
const CACHE_FILE = 'discovery-cache.json';
const CACHE_VERSION = 4;

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

/**
 * Get hash of lockfile for cache invalidation
 */
function getLockfileHash(baseDir: string): string | null {
  // Check for pnpm or npm lockfile
  const lockfile = existsSync(join(baseDir, 'pnpm-lock.yaml'))
    ? join(baseDir, 'pnpm-lock.yaml')
    : join(baseDir, 'package-lock.json');

  if (!existsSync(lockfile)) {
    return null;
  }

  const content = readFileSync(lockfile, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Get hash of package.json for cache invalidation when a package workspace
 * changes its declared dependencies without a colocated lockfile.
 */
function getPackageJsonHash(baseDir: string): string | null {
  const packageJsonPath = join(baseDir, 'package.json');

  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const content = readFileSync(packageJsonPath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Get a hash of all manifest timestamps for cache invalidation
 * This catches changes to SMRT packages even when lockfile hasn't changed
 */
function getManifestTimestampsHash(
  baseDir: string,
  packages: string[],
): string {
  const timestamps: string[] = [];

  for (const pkgName of packages) {
    try {
      const manifestPath = resolveManifestPath(pkgName, baseDir);

      if (manifestPath && existsSync(manifestPath)) {
        const stats = statSync(manifestPath);
        timestamps.push(`${pkgName}:${stats.mtimeMs}`);
      }
    } catch {
      // Ignore errors, package may have been removed
    }
  }

  return createHash('sha256').update(timestamps.join('|')).digest('hex');
}

interface DiscoveryCache {
  version: number;
  lockfileHash: string | null;
  packageJsonHash: string | null;
  manifestsHash: string;
  timestamp: number;
  packages: string[];
}

function findManifestPath(pkgPath: string): string | null {
  const candidates = [
    join(pkgPath, 'dist', 'manifest.json'),
    join(pkgPath, '.smrt', 'manifest.json'),
    join(pkgPath, 'src', 'manifest', 'manifest.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizePackagePath(pkgPath: string): string {
  try {
    return realpathSync(pkgPath);
  } catch {
    return pkgPath;
  }
}

function resolvePackageDir(
  packageName: string,
  baseDir: string = process.cwd(),
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

  const directPath = join(baseDir, 'node_modules', packageName);
  if (existsSync(directPath)) {
    return normalizePackagePath(directPath);
  }

  return null;
}

export function resolveManifestPath(
  packageName: string,
  baseDir: string = process.cwd(),
): string | null {
  const pkgPath = resolvePackageDir(packageName, baseDir);
  if (!pkgPath) {
    return null;
  }

  const manifestPath = findManifestPath(pkgPath);
  if (!manifestPath) {
    return null;
  }

  try {
    const manifest = parse<{ moduleType?: string }>(
      readFileSync(manifestPath, 'utf-8'),
    );

    return manifest.moduleType === 'smrt' ? manifestPath : null;
  } catch {
    return null;
  }
}

/**
 * Load cached discovery results if valid
 * Cache is invalidated if:
 * - Lockfile hash changed (dependencies changed)
 * - Manifest timestamps hash changed (SMRT packages rebuilt)
 */
function getCachedDiscovery(
  baseDir: string,
  verbose: boolean,
): { packages: string[]; reason?: string } | null {
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

    const currentLockfileHash = getLockfileHash(baseDir);
    const currentPackageJsonHash = getPackageJsonHash(baseDir);

    // Check lockfile hash
    if (cache.lockfileHash !== currentLockfileHash) {
      if (verbose) {
        console.log('[discovery] Cache invalid: lockfile changed');
      }
      return null;
    }

    if (cache.packageJsonHash !== currentPackageJsonHash) {
      if (verbose) {
        console.log('[discovery] Cache invalid: package.json changed');
      }
      return null;
    }

    // Check manifest timestamps (only if we have cached packages)
    if (cache.packages.length > 0) {
      const currentManifestsHash = getManifestTimestampsHash(
        baseDir,
        cache.packages,
      );
      if (cache.manifestsHash !== currentManifestsHash) {
        if (verbose) {
          console.log('[discovery] Cache invalid: manifest(s) changed');
        }
        return null;
      }
    }

    return { packages: cache.packages };
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

/**
 * Save discovery results to cache
 */
function saveCachedDiscovery(
  baseDir: string,
  packages: string[],
  verbose: boolean,
): void {
  const cache: DiscoveryCache = {
    version: CACHE_VERSION,
    lockfileHash: getLockfileHash(baseDir),
    packageJsonHash: getPackageJsonHash(baseDir),
    manifestsHash: getManifestTimestampsHash(baseDir, packages),
    timestamp: Date.now(),
    packages: packages,
  };

  try {
    mkdirSync(join(baseDir, CACHE_DIR), { recursive: true });
    writeFileSync(
      join(baseDir, CACHE_DIR, CACHE_FILE),
      JSON.stringify(cache, null, 2),
    );
    if (verbose) {
      console.log(`[discovery] Saved cache with ${packages.length} package(s)`);
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
function hasManifestExport(packageName: string, baseDir: string): boolean {
  return resolveManifestPath(packageName, baseDir) !== null;
}

function getDeclaredSmrtPackages(baseDir: string, verbose: boolean): string[] {
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

      const hasManifest = hasManifestExport(pkgName, baseDir);
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

/**
 * Perform fresh discovery of SMRT packages
 */
function performDiscovery(baseDir: string, verbose: boolean): string[] {
  if (verbose) {
    console.log('[discovery] Scanning node_modules for SMRT packages...');
  }

  try {
    const smrtPackages = new Set<string>();

    // Scan node_modules for all packages
    for (const pkgName of scanNodeModules(baseDir)) {
      if (hasManifestExport(pkgName, baseDir)) {
        smrtPackages.add(pkgName);
        if (verbose) {
          console.log(`[discovery] ✅ Found SMRT package: ${pkgName}`);
        }
      }
    }

    for (const pkgName of getDeclaredSmrtPackages(baseDir, verbose)) {
      smrtPackages.add(pkgName);
    }

    if (verbose) {
      console.log(
        `[discovery] Discovered ${smrtPackages.size} SMRT package(s)`,
      );
    }

    return Array.from(smrtPackages);
  } catch (error) {
    console.error(
      '[discovery] Failed to discover packages:',
      (error as Error).message,
    );
    return [];
  }
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
export function discoverSmrtPackages(options: DiscoveryOptions = {}): string[] {
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

    const packages = performDiscovery(baseDir, verbose);

    if (options.timing) {
      lastTimingData.discovery = performance.now() - startTime;
      lastTimingData.total = lastTimingData.discovery;
    }

    return packages;
  }

  // Try cache first
  const cacheCheckStart = options.timing ? performance.now() : 0;
  const cached = getCachedDiscovery(baseDir, verbose);

  if (options.timing) {
    lastTimingData.cacheCheck = performance.now() - cacheCheckStart;
  }

  if (cached) {
    if (verbose) {
      console.log(
        `[discovery] ✅ Using cached SMRT packages (${cached.packages.length} package(s))`,
      );
    }

    if (options.timing) {
      lastTimingData.total = performance.now() - startTime;
    }

    return cached.packages;
  }

  // No valid cache - perform fresh discovery
  if (verbose) {
    console.log('[discovery] Cache miss, performing discovery...');
  }

  const discoveryStart = options.timing ? performance.now() : 0;
  const packages = performDiscovery(baseDir, verbose);

  if (options.timing) {
    lastTimingData.discovery = performance.now() - discoveryStart;
  }

  // Save to cache
  saveCachedDiscovery(baseDir, packages, verbose);

  if (options.timing) {
    lastTimingData.total = performance.now() - startTime;
  }

  return packages;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
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
