/**
 * Manifest Loader - Automatic discovery of external package manifests
 *
 * This module provides automatic loading of SMRT manifests from external packages,
 * solving issue #131 where external package schemas weren't being detected.
 *
 * Architecture:
 * - Build-time: AST scanner generates manifests in dist/manifest.json
 * - Run-time: This module discovers and loads those manifests automatically
 * - Caching: Loaded manifests are cached to avoid repeated imports
 *
 * Flow:
 * 1. Check testManifest (for test classes)
 * 2. Check staticManifest (for core framework classes)
 * 3. Try dynamic import from external package manifest
 * 4. Return manifest entry or undefined
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { ObjectRegistry } from '../registry.js';
import type {
  FieldDefinition,
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { staticManifest } from './static-manifest.js';
import { testManifest } from './test-manifest-stub.js';

// Re-export types for convenience
export type Manifest = SmartObjectManifest;
export type ManifestEntry = SmartObjectDefinition;
export type { FieldDefinition, MethodDefinition };

/**
 * Manifest cache - stores loaded manifests to avoid repeated imports
 */
const manifestCache = new Map<string, Manifest>();

/**
 * Local test manifest - loaded from current package during test runs
 * undefined = not attempted yet, null = attempted but not found, Manifest = successfully loaded
 */
let localTestManifest: Manifest | null | undefined;

/**
 * Load local test manifest from current package (synchronous)
 *
 * During test runs, packages can have manifests in two locations:
 * 1. src/manifest/test-manifest.json - Domain packages during development
 * 2. dist/manifest.json - Built packages (consuming apps like praeco)
 *
 * This function attempts to load the manifest from either location.
 *
 * @returns Loaded manifest or null if not found or undefined if not yet attempted
 */
export function loadLocalTestManifestSync(): Manifest | null | undefined {
  if (localTestManifest !== undefined) {
    return localTestManifest;
  }

  // Try multiple possible manifest locations
  const possiblePaths = [
    resolve(process.cwd(), 'src/manifest/test-manifest.json'),
    resolve(process.cwd(), 'dist/manifest.json'),
  ];

  for (const manifestPath of possiblePaths) {
    try {
      const manifestJson = readFileSync(manifestPath, 'utf-8');
      localTestManifest = JSON.parse(manifestJson);

      console.log(
        `[manifest-loader] Loaded local test manifest from ${manifestPath}`,
      );
      return localTestManifest;
    } catch {}
  }

  // No manifest found - this is OK for production
  // Mark as attempted so we don't try again
  localTestManifest = null;
  return null;
}

/**
 * Extract package name from class constructor
 *
 * Uses the ObjectRegistry (preferred) or fallback methods to determine
 * which package the class belongs to.
 *
 * Search order:
 * 1. ObjectRegistry (packageName injected at build time from manifest)
 * 2. __package__ metadata (build tooling can inject this)
 * 3. require.resolve() (resolves package.json from constructor file location)
 * 4. Error stack trace parsing (fallback, fragile in pnpm workspaces)
 *
 * @param ctor - Class constructor
 * @returns Package name (e.g., '@happyvertical/smrt-places') or null
 */
export function getPackageName(
  ctor: new (...args: any[]) => any,
): string | null {
  try {
    // 1. Try ObjectRegistry first (most reliable - from build-time manifest)
    // This solves issue #143 where pnpm workspace symlinks break stack trace parsing
    const className = ctor.name;
    if (className) {
      const registered = ObjectRegistry.getClass(className);
      if (registered?.packageName) {
        return registered.packageName;
      }
    }

    // 2. Check if class has __package__ metadata (could be added by build tooling)
    if ((ctor as any).__package__) {
      return (ctor as any).__package__;
    }

    // 3. Try require.resolve() to find package.json from constructor location
    // This is more reliable than stack trace parsing for published packages
    try {
      const error = new Error();
      const stack = error.stack || '';
      const stackLines = stack.split('\n');

      // Find the first line with a file path that's NOT from smrt-core
      // Skip manifest-loader, registry, and other smrt-core files
      for (const line of stackLines) {
        const fileMatch = line.match(/\(([^)]+\.(?:js|ts))/);
        if (fileMatch) {
          const filePath = fileMatch[1];
          // Skip smrt-core internal files
          if (
            filePath.includes('manifest-loader') ||
            filePath.includes('registry') ||
            filePath.includes('/smrt-core/dist/')
          ) {
            continue; // Skip smrt-core files, look for external package
          }

          // Try to resolve package.json from this file
          try {
            // Handle file:// URLs
            const cleanPath = filePath.replace(/^file:\/\//, '');
            let dir = dirname(cleanPath);
            // Walk up until we find a package.json
            for (let i = 0; i < 10; i++) {
              const pkgPath = join(dir, 'package.json');
              try {
                if (existsSync(pkgPath)) {
                  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
                  if (pkg.name?.startsWith('@')) {
                    return pkg.name;
                  }
                }
              } catch {
                // Keep walking up
              }
              const parent = dirname(dir);
              if (parent === dir) break; // Reached root
              dir = parent;
            }
          } catch {
            // Fall through to next method
          }
          break;
        }
      }
    } catch {
      // Fall through to next method
    }

    // 4. Final fallback: Try to extract from Error stack trace with node_modules pattern
    // This method is fragile and fails in pnpm workspaces, but kept for backward compatibility
    const error = new Error();
    const stack = error.stack || '';
    const stackLines = stack.split('\n');

    // Look for line with 'node_modules/@scope/package' pattern
    for (const line of stackLines) {
      const match = line.match(/node_modules\/(@[^/]+\/[^/]+)/);
      if (match) {
        return match[1];
      }
    }

    // Package name is now injected at build time into the manifest and stored in ObjectRegistry
    // If we reach here, the class is likely not from an external package
    return null;
  } catch {
    return null;
  }
}

/**
 * Load manifest from external package
 *
 * Uses createRequire from process.cwd() to resolve packages from the calling
 * application's context, not from smrt-core's context. This allows finding
 * packages that are dependencies of the app but not of smrt-core.
 *
 * External packages export manifests via package.json:
 *   "exports": { "./manifest": "./dist/manifest.json" }
 *
 * @param packageName - Package name (e.g., '@happyvertical/smrt-places')
 * @returns Manifest object or null if not found
 */
export async function loadExternalManifest(
  packageName: string,
): Promise<Manifest | null> {
  // Check cache first
  if (manifestCache.has(packageName)) {
    return manifestCache.get(packageName)!;
  }

  try {
    // Create require from calling app's context (process.cwd())
    // This allows resolving packages that are installed in the app,
    // not just packages that are dependencies of smrt-core
    const require = createRequire(`${process.cwd()}/package.json`);

    // Resolve package main entry point
    const pkgMainPath = require.resolve(packageName);

    // Walk up from main entry to find package.json
    let dir = dirname(pkgMainPath);
    let pkgPath: string | null = null;

    for (let i = 0; i < 10; i++) {
      const testPath = join(dir, 'package.json');
      try {
        const content = readFileSync(testPath, 'utf-8');
        const json = JSON.parse(content);
        if (json.name === packageName) {
          pkgPath = testPath;
          break;
        }
      } catch {
        // File doesn't exist or can't be read, keep walking
      }

      const parent = dirname(dir);
      if (parent === dir) break; // Reached filesystem root
      dir = parent;
    }

    if (!pkgPath) {
      console.warn(`Could not find package.json for ${packageName}`);
      return null;
    }

    const pkgDir = dirname(pkgPath);

    // Read package.json to get manifest export path
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const manifestExport = pkgJson.exports?.['./manifest'];

    if (!manifestExport) {
      console.warn(
        `Package ${packageName} does not export "./manifest" in package.json`,
      );
      return null;
    }

    // Resolve manifest path (handle both string and conditional exports)
    const manifestRelPath =
      typeof manifestExport === 'string'
        ? manifestExport
        : manifestExport.default || manifestExport.import;

    if (!manifestRelPath) {
      console.warn(
        `Package ${packageName} has invalid manifest export configuration`,
      );
      return null;
    }

    const manifestPath = join(pkgDir, manifestRelPath);

    // Read and parse manifest JSON
    const manifestJson = readFileSync(manifestPath, 'utf-8');
    const manifest: Manifest = JSON.parse(manifestJson);

    // Validate manifest structure
    if (!manifest.objects || typeof manifest.objects !== 'object') {
      console.warn(`Invalid manifest structure for package ${packageName}`);
      return null;
    }

    // Cache the loaded manifest
    manifestCache.set(packageName, manifest);

    return manifest;
  } catch (error) {
    // Package doesn't export manifest or doesn't exist
    // This is expected for core framework classes
    return null;
  }
}

/**
 * Discover manifest entry synchronously (checks only loaded manifests)
 *
 * Search order:
 * 1. localTestManifest (for domain package test classes)
 * 2. testManifest (for core test classes)
 * 3. staticManifest (for core framework classes)
 * 4. Cached external manifests
 *
 * @param className - Class name (for lookup)
 * @returns ManifestEntry or undefined if not found
 */
export function discoverManifestSync(
  className: string,
): ManifestEntry | undefined {
  const name = className.toLowerCase();

  // 1. Check localTestManifest (domain package test classes) - try to load if not attempted yet
  if (localTestManifest === undefined) {
    loadLocalTestManifestSync();
  }
  if (localTestManifest?.objects[name]) {
    return localTestManifest.objects[name];
  }
  if (localTestManifest?.objects[className]) {
    return localTestManifest.objects[className];
  }

  // 2. Check testManifest (core test classes)
  if (testManifest?.objects[name]) {
    return testManifest.objects[name];
  }
  if (testManifest?.objects[className]) {
    return testManifest.objects[className];
  }

  // 3. Check staticManifest (core framework classes)
  const staticObjects = staticManifest.objects as Record<string, ManifestEntry>;
  if (staticObjects[name]) {
    return staticObjects[name];
  }
  if (staticObjects[className]) {
    return staticObjects[className];
  }

  // 4. Check cached external manifests
  for (const manifest of manifestCache.values()) {
    const entry = manifest.objects[name] || manifest.objects[className];
    if (entry) {
      // Enrich entry with packageName from manifest if not already present
      if (!entry.packageName && manifest.packageName) {
        return { ...entry, packageName: manifest.packageName };
      }
      return entry;
    }
  }

  return undefined;
}

/**
 * Discover manifest entry asynchronously (includes external package loading)
 *
 * Search order:
 * 1. testManifest (for test classes)
 * 2. staticManifest (for core framework classes)
 * 3. Cached external manifests
 * 4. External package manifest (dynamic import)
 *
 * @param ctor - Class constructor
 * @param className - Class name (for lookup)
 * @returns ManifestEntry or undefined if not found
 */
export async function discoverManifestEntry(
  ctor: new (...args: any[]) => any,
  className: string,
): Promise<ManifestEntry | undefined> {
  // First try synchronous lookup
  const syncEntry = discoverManifestSync(className);
  if (syncEntry) {
    return syncEntry;
  }

  // Try loading from external package
  const packageName = getPackageName(ctor);

  if (packageName) {
    const manifest = await loadExternalManifest(packageName);
    if (manifest) {
      const name = className.toLowerCase();
      // Try lowercase first, then exact case
      const entry = manifest.objects[name] || manifest.objects[className];
      if (entry) {
        // Enrich entry with packageName from manifest if not already present
        if (!entry.packageName && manifest.packageName) {
          return { ...entry, packageName: manifest.packageName };
        }
        return entry;
      }
    }
  }

  return undefined;
}

/**
 * Clear manifest cache
 *
 * Useful for testing or when packages are updated at runtime.
 */
export function clearManifestCache(): void {
  manifestCache.clear();
}

/**
 * Get all loaded manifests
 *
 * Returns a copy of the manifest cache for inspection.
 *
 * @returns Array of [packageName, manifest] entries
 */
export function getLoadedManifests(): Array<[string, Manifest]> {
  return Array.from(manifestCache.entries());
}
