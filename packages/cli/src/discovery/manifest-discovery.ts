/**
 * Manifest Discovery System
 *
 * Automatically discovers and loads SMRT object manifests from:
 * - Project root (static-manifest.js, manifest.json)
 * - Installed packages in node_modules
 */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import glob from 'fast-glob';
import { ObjectRegistry } from '@happyvertical/smrt-core';

export interface DiscoveredManifest {
  path: string;
  source: 'project' | 'package';
  packageName?: string;
  objectCount: number;
}

/**
 * Discover manifest files in the project and installed packages
 */
export async function discoverManifests(projectRoot: string = process.cwd()): Promise<DiscoveredManifest[]> {
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
async function findProjectManifests(projectRoot: string): Promise<DiscoveredManifest[]> {
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
      if (manifest && manifest.objects) {
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
 */
async function findPackageManifests(projectRoot: string): Promise<DiscoveredManifest[]> {
  const discovered: DiscoveredManifest[] = [];
  const nodeModulesPath = resolve(projectRoot, 'node_modules');

  try {
    // Find all package.json files that might contain SMRT packages
    const packageJsonFiles = await glob('**/package.json', {
      cwd: nodeModulesPath,
      ignore: ['**/node_modules/**'],
      absolute: true,
    });

    for (const pkgPath of packageJsonFiles) {
      try {
        const pkgContent = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgContent);

        // Check if package has @happyvertical/smrt in dependencies
        const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        const hasSmrt = Object.keys(deps).some(dep =>
          dep.includes('@happyvertical/smrt') || dep.includes('smrt')
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
              if (manifest && manifest.objects) {
                discovered.push({
                  path: manifestPath,
                  source: 'package',
                  packageName: pkg.name,
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
 * Load a manifest file (handles both .js and .json)
 */
async function loadManifestFile(manifestPath: string): Promise<any> {
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
 * Auto-discover and load all manifests in the project
 */
export async function autoDiscoverAndLoad(projectRoot: string = process.cwd()): Promise<{
  discovered: DiscoveredManifest[];
  totalObjects: number;
}> {
  const manifests = await discoverManifests(projectRoot);
  let totalObjects = 0;

  // Load each discovered manifest
  for (const manifest of manifests) {
    try {
      await loadManifest(manifest.path);
      totalObjects += manifest.objectCount;
    } catch (error) {
      console.warn(`Failed to load manifest ${manifest.path}:`, error instanceof Error ? error.message : 'Unknown error');
    }
  }

  return {
    discovered: manifests,
    totalObjects,
  };
}
