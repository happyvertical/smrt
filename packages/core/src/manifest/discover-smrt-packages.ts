/**
 * SMRT Package Discovery
 *
 * Discovers all SMRT packages in the dependency tree by:
 * 1. Detecting package manager (pnpm/npm)
 * 2. Running package list command
 * 3. Validating packages have moduleType: "smrt" in manifest
 * 4. Optionally caching results based on lockfile hash
 *
 * Cache Strategy:
 * - DISABLED by default (ensures fresh manifests during development)
 * - Enable with SMRT_ENABLE_DISCOVERY_CACHE=true for production/CI builds
 *
 * Configuration:
 * - SMRT_DISCOVERY_MAX_BUFFER: Buffer size for npm/pnpm list output (default: 100MB)
 *   Increase if you get ENOBUFS errors with very large dependency trees
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const CACHE_DIR = '.smrt';
const CACHE_FILE = 'discovery-cache.json';

// Configurable buffer size for package manager commands (default: 100MB)
const MAX_BUFFER = process.env.SMRT_DISCOVERY_MAX_BUFFER
  ? parseInt(process.env.SMRT_DISCOVERY_MAX_BUFFER, 10)
  : 100 * 1024 * 1024;

/**
 * Detect which package manager is in use
 */
function getPackageManager() {
  if (existsSync('pnpm-lock.yaml')) return 'pnpm';
  if (existsSync('package-lock.json')) return 'npm';
  return 'npm'; // fallback
}

/**
 * Get hash of lockfile for cache invalidation
 */
function getLockfileHash() {
  const pm = getPackageManager();
  const lockfile = pm === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json';

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
    packages: packages
  };

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      join(CACHE_DIR, CACHE_FILE),
      JSON.stringify(cache, null, 2)
    );
  } catch (error) {
    console.warn('[discovery] Failed to save cache:', (error as Error).message);
  }
}

/**
 * Check if a package exports a SMRT manifest
 */
function hasManifestExport(packageName: string): boolean {
  try {
    const require = createRequire(`${process.cwd()}/package.json`);

    // Try to resolve package.json
    let pkgJsonPath;
    try {
      const pkgMainPath = require.resolve(packageName);
      let dir = dirname(pkgMainPath);

      // Walk up to find package.json
      for (let i = 0; i < 10; i++) {
        const testPath = join(dir, 'package.json');
        if (existsSync(testPath)) {
          const content = JSON.parse(readFileSync(testPath, 'utf-8'));
          if (content.name === packageName) {
            pkgJsonPath = testPath;
            break;
          }
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // Try direct node_modules lookup
      const nodeModulesPath = join(process.cwd(), 'node_modules', packageName, 'package.json');
      if (existsSync(nodeModulesPath)) {
        pkgJsonPath = nodeModulesPath;
      }
    }

    if (!pkgJsonPath) {
      return false;
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

    // Check if package exports ./manifest
    if (!pkgJson.exports || !pkgJson.exports['./manifest']) {
      return false;
    }

    // Load manifest and validate moduleType
    const manifestExport = pkgJson.exports['./manifest'];
    const manifestRelPath = typeof manifestExport === 'string'
      ? manifestExport
      : manifestExport.default || manifestExport.import;

    const manifestPath = join(dirname(pkgJsonPath), manifestRelPath);

    if (!existsSync(manifestPath)) {
      return false;
    }

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
 * Perform fresh discovery of SMRT packages
 */
function performDiscovery(): string[] {
  const pm = getPackageManager();
  console.log(`[discovery] Using package manager: ${pm}`);

  try {
    // Get full dependency tree
    const cmd = pm === 'pnpm'
      ? 'pnpm list --json --depth=Infinity'
      : 'npm list --json --all';

    let output: string;
    try {
      output = execSync(cmd, {
        encoding: 'utf-8',
        maxBuffer: MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'] // Only capture stdout, ignore stdin/stderr
      });
    } catch (error: any) {
      // npm list exits with non-zero code when there are dependency issues
      // but still provides valid JSON output
      if (error.stdout) {
        output = error.stdout.toString();
      } else {
        throw error;
      }
    }

    const data = JSON.parse(output);

    // Extract all unique package names from dependency tree
    const packages = new Set<string>();

    function extractPackages(deps: Record<string, any>): void {
      if (!deps) return;

      for (const [name, info] of Object.entries(deps)) {
        packages.add(name);

        // Recursively check nested dependencies
        if ((info as any).dependencies) {
          extractPackages((info as any).dependencies);
        }
      }
    }

    // Handle pnpm vs npm structure differences
    if (Array.isArray(data)) {
      // pnpm returns array
      for (const pkg of data) {
        if (pkg.dependencies) {
          extractPackages(pkg.dependencies);
        }
      }
    } else {
      // npm returns single object
      if (data.dependencies) {
        extractPackages(data.dependencies);
      }
    }

    // Filter to only SMRT packages (have moduleType: "smrt" in manifest)
    const smrtPackages: string[] = [];

    for (const pkgName of packages) {
      if (hasManifestExport(pkgName)) {
        smrtPackages.push(pkgName);
        console.log(`[discovery] ✅ Found SMRT package: ${pkgName}`);
      }
    }

    console.log(`[discovery] Discovered ${smrtPackages.length} SMRT package(s)`);

    return smrtPackages;
  } catch (error) {
    console.error('[discovery] Failed to discover packages:', (error as Error).message);
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
    console.log(`[discovery] ✅ Using cached SMRT packages (${cached.length} package(s))`);
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
