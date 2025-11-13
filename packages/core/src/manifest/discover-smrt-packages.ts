/**
 * SMRT Package Discovery
 *
 * Discovers all SMRT packages in node_modules by:
 * 1. Scanning node_modules directory for installed packages
 * 2. Following symlinks for workspace: dependencies
 * 3. Checking for dist/manifest.json with moduleType: "smrt"
 * 4. Optionally caching results based on lockfile hash
 *
 * Cache Strategy:
 * - DISABLED by default (ensures fresh manifests during development)
 * - Enable with SMRT_ENABLE_DISCOVERY_CACHE=true for production/CI builds
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
import { dirname, join } from 'node:path';

const CACHE_DIR = '.smrt';
const CACHE_FILE = 'discovery-cache.json';

/**
 * Get hash of lockfile for cache invalidation
 */
function getLockfileHash() {
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
 * Load cached discovery results if valid
 */
function getCachedDiscovery() {
  const cachePath = join(CACHE_DIR, CACHE_FILE);

  if (!existsSync(cachePath)) {
    return null;
  }

  try {
    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const currentHash = getLockfileHash();

    if (cache.lockfileHash === currentHash) {
      return cache.packages;
    }

    // Lockfile changed, cache invalid
    return null;
  } catch (error) {
    console.warn('[discovery] Failed to read cache:', (error as Error).message);
    return null;
  }
}

/**
 * Save discovery results to cache
 */
function saveCachedDiscovery(packages: string[]): void {
  const cache = {
    lockfileHash: getLockfileHash(),
    timestamp: Date.now(),
    packages: packages,
  };

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(join(CACHE_DIR, CACHE_FILE), JSON.stringify(cache, null, 2));
  } catch (error) {
    console.warn('[discovery] Failed to save cache:', (error as Error).message);
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
      } catch {
        // Skip entries we can't read
        continue;
      }
    }
  } catch (error) {
    // node_modules doesn't exist or can't be read
    return;
  }
}

/**
 * Perform fresh discovery of SMRT packages
 */
function performDiscovery(): string[] {
  console.log('[discovery] Scanning node_modules for SMRT packages...');

  try {
    const smrtPackages: string[] = [];

    // Scan node_modules for all packages
    for (const pkgName of scanNodeModules(process.cwd())) {
      if (hasManifestExport(pkgName)) {
        smrtPackages.push(pkgName);
        console.log(`[discovery] ✅ Found SMRT package: ${pkgName}`);
      }
    }

    console.log(
      `[discovery] Discovered ${smrtPackages.length} SMRT package(s)`,
    );

    return smrtPackages;
  } catch (error) {
    console.error(
      '[discovery] Failed to discover packages:',
      (error as Error).message,
    );
    return [];
  }
}

/**
 * Main discovery function
 *
 * Cache disabled by default - safe for development
 * Enable with SMRT_ENABLE_DISCOVERY_CACHE=true for production
 */
export function discoverSmrtPackages() {
  const cacheEnabled = process.env.SMRT_ENABLE_DISCOVERY_CACHE === 'true';

  if (!cacheEnabled) {
    // Default: cache disabled
    console.warn('\n⚠️  SMRT package discovery cache is DISABLED');
    console.warn('   This ensures fresh manifests during development.');
    console.warn('   To enable caching for faster builds (CI/production):');
    console.warn('   Set SMRT_ENABLE_DISCOVERY_CACHE=true\n');

    return performDiscovery();
  }

  // Cache enabled - try to use cached results
  console.log('[discovery] Cache enabled, checking for cached results...');

  const cached = getCachedDiscovery();
  if (cached) {
    console.log(
      `[discovery] ✅ Using cached SMRT packages (${cached.length} package(s))`,
    );
    return cached;
  }

  // No valid cache - perform fresh discovery
  console.log('[discovery] No valid cache found, performing discovery...');
  const packages = performDiscovery();

  // Save to cache
  saveCachedDiscovery(packages);

  return packages;
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const packages = discoverSmrtPackages();
  console.log('\nDiscovered SMRT packages:');
  console.log(JSON.stringify(packages, null, 2));
}
