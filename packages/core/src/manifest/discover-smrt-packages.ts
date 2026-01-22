/**
 * SMRT Package Discovery
 *
 * Discovers all SMRT packages in node_modules by:
 * 1. Scanning node_modules directory for installed packages
 * 2. Following symlinks for workspace: dependencies
 * 3. Checking for dist/manifest.json with moduleType: "smrt"
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
import { join } from 'node:path';

const CACHE_DIR = '.smrt';
const CACHE_FILE = 'discovery-cache.json';

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
function getLockfileHash(): string | null {
  // Check for pnpm or npm lockfile
  const lockfile = existsSync('pnpm-lock.yaml')
    ? 'pnpm-lock.yaml'
    : 'package-lock.json';

  if (!existsSync(lockfile)) {
    return null;
  }

  const content = readFileSync(lockfile, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Get a hash of all manifest timestamps for cache invalidation
 * This catches changes to SMRT packages even when lockfile hasn't changed
 */
function getManifestTimestampsHash(packages: string[]): string {
  const timestamps: string[] = [];

  for (const pkgName of packages) {
    try {
      const pkgPath = join(process.cwd(), 'node_modules', pkgName);
      const manifestPath = join(pkgPath, 'dist', 'manifest.json');

      if (existsSync(manifestPath)) {
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
  lockfileHash: string | null;
  manifestsHash: string;
  timestamp: number;
  packages: string[];
}

/**
 * Load cached discovery results if valid
 * Cache is invalidated if:
 * - Lockfile hash changed (dependencies changed)
 * - Manifest timestamps hash changed (SMRT packages rebuilt)
 */
function getCachedDiscovery(
  verbose: boolean,
): { packages: string[]; reason?: string } | null {
  const cachePath = join(CACHE_DIR, CACHE_FILE);

  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const cache: DiscoveryCache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const currentLockfileHash = getLockfileHash();

    // Check lockfile hash
    if (cache.lockfileHash !== currentLockfileHash) {
      if (verbose) {
        console.log('[discovery] Cache invalid: lockfile changed');
      }
      return null;
    }

    // Check manifest timestamps (only if we have cached packages)
    if (cache.packages.length > 0) {
      const currentManifestsHash = getManifestTimestampsHash(cache.packages);
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
function saveCachedDiscovery(packages: string[], verbose: boolean): void {
  const cache: DiscoveryCache = {
    lockfileHash: getLockfileHash(),
    manifestsHash: getManifestTimestampsHash(packages),
    timestamp: Date.now(),
    packages: packages,
  };

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, CACHE_FILE), JSON.stringify(cache, null, 2));
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
 * Check if a package exports a SMRT manifest
 *
 * Supports both regular npm dependencies and workspace: symlinks
 */
function hasManifestExport(packageName: string): boolean {
  try {
    // Try direct node_modules lookup first (handles workspace: symlinks)
    let pkgPath = join(process.cwd(), 'node_modules', packageName);

    // If it doesn't exist, return false
    if (!existsSync(pkgPath)) {
      return false;
    }

    // Follow symlinks to get real path (for workspace: dependencies)
    try {
      pkgPath = realpathSync(pkgPath);
    } catch {
      // If realpath fails, continue with original path
    }

    // Check for dist/manifest.json directly (standard SMRT build output)
    const manifestPath = join(pkgPath, 'dist', 'manifest.json');

    if (!existsSync(manifestPath)) {
      return false;
    }

    // Load and validate manifest
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // Validate moduleType
    if (manifest.moduleType !== 'smrt') {
      return false;
    }

    return true;
  } catch (error) {
    return false;
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
function performDiscovery(verbose: boolean): string[] {
  if (verbose) {
    console.log('[discovery] Scanning node_modules for SMRT packages...');
  }

  try {
    const smrtPackages: string[] = [];

    // Scan node_modules for all packages
    for (const pkgName of scanNodeModules(process.cwd())) {
      if (hasManifestExport(pkgName)) {
        smrtPackages.push(pkgName);
        if (verbose) {
          console.log(`[discovery] ✅ Found SMRT package: ${pkgName}`);
        }
      }
    }

    if (verbose) {
      console.log(
        `[discovery] Discovered ${smrtPackages.length} SMRT package(s)`,
      );
    }

    return smrtPackages;
  } catch (error) {
    console.error(
      '[discovery] Failed to discover packages:',
      (error as Error).message,
    );
    return [];
  }
}

export interface DiscoveryOptions {
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
 */
export function discoverSmrtPackages(options: DiscoveryOptions = {}): string[] {
  const startTime = options.timing ? performance.now() : 0;
  lastTimingData = {};

  const cacheDisabled =
    options.noCache || process.env.SMRT_DISABLE_DISCOVERY_CACHE === 'true';

  const verbose =
    options.verbose ||
    process.env.SMRT_VERBOSE === 'true' ||
    process.env.DEBUG?.includes('smrt');

  if (cacheDisabled) {
    if (verbose) {
      console.log('[discovery] Cache disabled, performing fresh discovery...');
    }

    const packages = performDiscovery(verbose);

    if (options.timing) {
      lastTimingData.discovery = performance.now() - startTime;
      lastTimingData.total = lastTimingData.discovery;
    }

    return packages;
  }

  // Try cache first
  const cacheCheckStart = options.timing ? performance.now() : 0;
  const cached = getCachedDiscovery(verbose);

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
  const packages = performDiscovery(verbose);

  if (options.timing) {
    lastTimingData.discovery = performance.now() - discoveryStart;
  }

  // Save to cache
  saveCachedDiscovery(packages, verbose);

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
