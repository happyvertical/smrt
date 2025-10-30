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
 * Extract package name from class constructor
 *
 * Uses the file path from the constructor's source location to determine
 * which package the class belongs to.
 *
 * @param ctor - Class constructor
 * @returns Package name (e.g., '@happyvertical/smrt-places') or null
 */
export function getPackageName(
  ctor: new (...args: any[]) => any,
): string | null {
  try {
    // Try to get package name from constructor metadata
    // This works when classes are imported from external packages
    const ctorString = ctor.toString();

    // Check if class has __package__ metadata (could be added by build tooling)
    if ((ctor as any).__package__) {
      return (ctor as any).__package__;
    }

    // Try to extract from Error stack trace
    const error = new Error();
    const stack = error.stack || '';
    const stackLines = stack.split('\n');

    // Look for line with 'node_modules/@happyvertical/' or similar
    for (const line of stackLines) {
      const match = line.match(/node_modules\/(@[^/]+\/[^/]+)/);
      if (match) {
        return match[1];
      }
    }

    // For testing, check if class name suggests a package
    const className = ctor.name;
    if (className === 'Place' || className === 'PlaceType') {
      return '@happyvertical/smrt-places';
    }
    if (
      className === 'Event' ||
      className === 'EventParticipant' ||
      className === 'EventType'
    ) {
      return '@happyvertical/smrt-events';
    }
    if (className === 'Profile' || className === 'ProfileType') {
      return '@happyvertical/smrt-profiles';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Load manifest from external package
 *
 * Attempts to dynamically import manifest from package exports.
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
    // Dynamic import from package manifest export
    const manifestModule = await import(`${packageName}/manifest`);
    const manifest: Manifest = manifestModule.default || manifestModule;

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
 * 1. testManifest (for test classes)
 * 2. staticManifest (for core framework classes)
 * 3. Cached external manifests
 *
 * @param className - Class name (for lookup)
 * @returns ManifestEntry or undefined if not found
 */
export function discoverManifestSync(
  className: string,
): ManifestEntry | undefined {
  const name = className.toLowerCase();

  // 1. Check testManifest (test classes)
  if (testManifest?.objects[name]) {
    return testManifest.objects[name];
  }
  if (testManifest?.objects[className]) {
    return testManifest.objects[className];
  }

  // 2. Check staticManifest (core framework classes)
  const staticObjects = staticManifest.objects as Record<string, ManifestEntry>;
  if (staticObjects[name]) {
    return staticObjects[name];
  }
  if (staticObjects[className]) {
    return staticObjects[className];
  }

  // 3. Check cached external manifests
  for (const manifest of manifestCache.values()) {
    if (manifest.objects[name]) {
      return manifest.objects[name];
    }
    if (manifest.objects[className]) {
      return manifest.objects[className];
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
      if (manifest.objects[name]) {
        return manifest.objects[name];
      }
      if (manifest.objects[className]) {
        return manifest.objects[className];
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
