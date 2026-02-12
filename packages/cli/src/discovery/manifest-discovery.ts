/**
 * Manifest Discovery System
 *
 * Automatically discovers and loads SMRT object manifests from:
 * - Project root (static-manifest.js, manifest.json)
 * - Installed packages in node_modules
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import glob from 'fast-glob';

export interface DiscoveredManifest {
  path: string;
  source: 'project' | 'package';
  packageName?: string;
  packageVersion?: string;
  objectCount: number;
}

/**
 * Tracks all versions found for each @happyvertical/smrt-* package.
 * Used to detect version conflicts that could cause runtime issues.
 */
const smrtPackageVersions = new Map<string, Set<string>>();

/**
 * Error thrown when multiple versions of SMRT packages are detected
 */
export class SmrtVersionConflictError extends Error {
  constructor(conflicts: Map<string, Set<string>>) {
    const lines = [
      '',
      '❌ SMRT Version Conflict Detected',
      '',
      'Multiple versions of SMRT packages found in your project:',
      '',
    ];

    for (const [pkg, versions] of conflicts) {
      lines.push(`  ${pkg}: ${[...versions].join(', ')}`);
    }

    lines.push(
      '',
      'All SMRT packages must use the same version to ensure consistent behavior.',
      '',
      '🔧 To fix this:',
      '',
      '  1. Run: pnpm why <package-name>',
      '     to find which dependencies are pulling in different versions',
      '',
      '  2. Update your dependencies to use consistent versions:',
      '     pnpm update @happyvertical/smrt-core@latest',
      '',
      '  3. If transitive deps are the issue, add overrides to package.json:',
      '     {',
      '       "pnpm": {',
      '         "overrides": {',
      '           "@happyvertical/smrt-*": "^0.19.34"',
      '         }',
      '       }',
      '     }',
      '',
      '  4. Clean stale packages:',
      '     pnpm store prune && rm -rf node_modules && pnpm install',
      '',
    );

    super(lines.join('\n'));
    this.name = 'SmrtVersionConflictError';
  }
}

/**
 * Discover manifest files in the project and installed packages
 */
export async function discoverManifests(
  projectRoot: string = process.cwd(),
): Promise<DiscoveredManifest[]> {
  const discovered: DiscoveredManifest[] = [];

  // 1. Check project root for manifests
  const projectManifests = await findProjectManifests(projectRoot);
  discovered.push(...projectManifests);

  // 2. Check node_modules for package manifests
  const packageManifests = await findPackageManifests(projectRoot);
  discovered.push(...packageManifests);

  return discovered;
}

/**
 * Find manifests in project root
 */
async function findProjectManifests(
  projectRoot: string,
): Promise<DiscoveredManifest[]> {
  const discovered: DiscoveredManifest[] = [];
  const candidates = [
    'dist/manifest.json',
    'dist/static-manifest.js',
    'static-manifest.js',
    'manifest.json',
    'src/manifest/static-manifest.js',
    'src/manifest/manifest.json',
    '.smrt/manifest.json',
  ];

  for (const candidate of candidates) {
    const manifestPath = resolve(projectRoot, candidate);
    try {
      const manifest = await loadManifestFile(manifestPath);
      if (manifest?.objects) {
        discovered.push({
          path: manifestPath,
          source: 'project',
          objectCount: Object.keys(manifest.objects).length,
        });
        break; // Use first found manifest
      }
    } catch {
      // File doesn't exist or can't be loaded, continue
    }
  }

  return discovered;
}

/**
 * Find manifests in installed packages
 *
 * Note: pnpm creates multiple copies of packages with different dependency hashes
 * (e.g., @happyvertical/smrt-profiles@0.19.34_...hash1..., ...hash2..., etc.)
 * We deduplicate by package name to avoid loading the same manifest hundreds of times,
 * which would cause memory exhaustion. See issue #771.
 */
async function findPackageManifests(
  projectRoot: string,
): Promise<DiscoveredManifest[]> {
  const discovered: DiscoveredManifest[] = [];
  const nodeModulesPath = resolve(projectRoot, 'node_modules');

  // Track packages we've already processed to avoid duplicates from pnpm's
  // content-addressable storage (same package version with different dependency hashes).
  // We use name@version as the key because:
  // - Same version with different hashes = identical manifest (safe to dedupe)
  // - Different versions = potentially different manifest (must not dedupe)
  const seenPackages = new Set<string>();

  // Clear version tracking for this discovery run
  smrtPackageVersions.clear();

  try {
    // Find all package.json files that might contain SMRT packages
    const packageJsonFiles = await glob('**/package.json', {
      cwd: nodeModulesPath,
      ignore: ['**/node_modules/**'],
      absolute: true,
      followSymbolicLinks: false,
    });

    for (const pkgPath of packageJsonFiles) {
      try {
        const pkgContent = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgContent);

        // Track all versions of @happyvertical/smrt-* packages for conflict detection
        if (pkg.name?.startsWith('@happyvertical/smrt-')) {
          if (!smrtPackageVersions.has(pkg.name)) {
            smrtPackageVersions.set(pkg.name, new Set());
          }
          smrtPackageVersions.get(pkg.name)?.add(pkg.version);
        }

        // Skip if we've already processed this package name@version
        const packageKey = `${pkg.name}@${pkg.version}`;
        if (seenPackages.has(packageKey)) {
          continue;
        }

        // Check if package has @happyvertical/smrt in dependencies
        const deps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
        };
        const hasSmrt = Object.keys(deps).some(
          (dep) => dep.includes('@happyvertical/smrt') || dep.includes('smrt'),
        );

        if (hasSmrt) {
          // Look for manifest files in this package
          const packageDir = pkgPath.replace('/package.json', '');
          const manifestCandidates = [
            join(packageDir, 'dist/manifest.json'),
            join(packageDir, 'dist/static-manifest.js'),
            join(packageDir, 'static-manifest.js'),
            join(packageDir, 'manifest.json'),
          ];

          for (const manifestPath of manifestCandidates) {
            try {
              const manifest = await loadManifestFile(manifestPath);
              if (manifest?.objects) {
                // Mark this package as seen AFTER we successfully load a manifest
                seenPackages.add(packageKey);
                discovered.push({
                  path: manifestPath,
                  source: 'package',
                  packageName: pkg.name,
                  packageVersion: pkg.version,
                  objectCount: Object.keys(manifest.objects).length,
                });
                break; // Use first found manifest for this package
              }
            } catch {
              // Manifest doesn't exist, continue
            }
          }
        }
      } catch {
        // Failed to read/parse package.json, continue
      }
    }
  } catch {
    // node_modules doesn't exist or can't be read
  }

  return discovered;
}

/**
 * Check for SMRT package version conflicts and throw if any found.
 * This ensures all @happyvertical/smrt-* packages use the same version.
 */
function checkSmrtVersionConflicts(): void {
  const conflicts = new Map<string, Set<string>>();

  for (const [pkg, versions] of smrtPackageVersions) {
    if (versions.size > 1) {
      conflicts.set(pkg, versions);
    }
  }

  if (conflicts.size > 0) {
    throw new SmrtVersionConflictError(conflicts);
  }
}

/**
 * Load a manifest file (handles both .js and .json)
 */
export async function loadManifestFile(manifestPath: string): Promise<any> {
  if (manifestPath.endsWith('.js')) {
    // Dynamic import for .js files
    const manifestUrl = pathToFileURL(manifestPath).href;
    const module = await import(manifestUrl);
    return module.default || module;
  } else if (manifestPath.endsWith('.json')) {
    // Read and parse JSON files
    const content = await readFile(manifestPath, 'utf-8');
    return JSON.parse(content);
  }
  throw new Error(`Unsupported manifest file type: ${manifestPath}`);
}

/**
 * Load and register objects from a manifest
 */
export async function loadManifest(manifestPath: string): Promise<void> {
  const manifest = await loadManifestFile(manifestPath);

  if (!manifest || !manifest.objects) {
    return;
  }

  // Register each object from the manifest
  for (const [className, objectDef] of Object.entries(manifest.objects)) {
    const def = objectDef as any;

    // For now, just track that we found objects
    // Full registration requires the actual class constructors
    // which we don't have from manifest files alone
    // This is enough for discovery/introspection purposes
  }
}

/**
 * Auto-discover and load all manifests in the project.
 *
 * @throws {SmrtVersionConflictError} If multiple versions of SMRT packages are detected
 */
export async function autoDiscoverAndLoad(
  projectRoot: string = process.cwd(),
): Promise<{
  discovered: DiscoveredManifest[];
  totalObjects: number;
}> {
  const manifests = await discoverManifests(projectRoot);

  // Check for version conflicts BEFORE loading manifests
  // This fails fast with a helpful error message
  checkSmrtVersionConflicts();

  let totalObjects = 0;

  // Load each discovered manifest
  for (const manifest of manifests) {
    try {
      await loadManifest(manifest.path);
      totalObjects += manifest.objectCount;
    } catch (error) {
      console.warn(
        `Failed to load manifest ${manifest.path}:`,
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  }

  return {
    discovered: manifests,
    totalObjects,
  };
}
