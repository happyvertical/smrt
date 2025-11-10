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
 *
 * Module Resolution Strategy:
 * - Method 1: require.resolve() - works for published packages from npm registry
 * - Method 2: Direct node_modules lookup - works for file: protocol linked packages
 *
 * The dual-method approach enables both development (file: protocol) and production
 * (published packages) workflows without changing code or configuration.
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
 * 1. ObjectRegistry (packageName injected at build time from manifest) - SKIPPED during initial registration
 * 2. __package__ metadata (build tooling can inject this)
 * 3. require.resolve() (resolves package.json from constructor file location)
 * 4. Error stack trace parsing (fallback, fragile in pnpm workspaces)
 *
 * @param ctor - Class constructor
 * @param skipRegistry - If true, skip checking ObjectRegistry (used during initial registration to avoid circular dependency)
 * @returns Package name (e.g., '@happyvertical/smrt-places') or null
 */
export function getPackageName(
  ctor: new (...args: any[]) => any,
  skipRegistry: boolean = false,
): string | null {
  try {
    // 1. Try ObjectRegistry first (most reliable - from build-time manifest)
    // This solves issue #143 where pnpm workspace symlinks break stack trace parsing
    // CRITICAL: Skip during initial registration to avoid circular dependency (issue #159)
    if (!skipRegistry) {
      const className = ctor.name;
      if (className) {
        const registered = ObjectRegistry.getClass(className);
        if (registered?.packageName) {
          return registered.packageName;
        }
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

  let pkgPath: string | null = null;

  try {
    // Try Method 1: require.resolve() - works for published packages
    const require = createRequire(`${process.cwd()}/package.json`);
    const pkgMainPath = require.resolve(packageName);

    // Walk up from main entry to find package.json
    let dir = dirname(pkgMainPath);

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
  } catch (error) {
    // Try Method 2: Direct node_modules lookup - works for file: protocol
    // When packages are linked via file: protocol, require.resolve() fails
    // because Node.js expects the exports field to define a main entry point.
    // We fall back to directly checking node_modules for the package.

    // Convert @scope/package-name to node_modules/@scope/package-name
    const nodeModulesPath = join(process.cwd(), 'node_modules', packageName);
    const nodeModulesPkgPath = join(nodeModulesPath, 'package.json');

    try {
      if (existsSync(nodeModulesPkgPath)) {
        const content = readFileSync(nodeModulesPkgPath, 'utf-8');
        const json = JSON.parse(content);
        if (json.name === packageName) {
          pkgPath = nodeModulesPkgPath;
        }
      }
    } catch {
      // Fallback also failed
    }
  }

  if (!pkgPath) {
    return null;
  }

  try {
    const pkgDir = dirname(pkgPath);

    // Read package.json to get manifest export path
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const manifestExport = pkgJson.exports?.['./manifest'];

    if (!manifestExport) {
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
 * Track discovered manifest entries to detect collisions
 * Maps className -> Array<{packageName, filePath, manifestSource}>
 */
const manifestCollisions = new Map<
  string,
  Array<{ packageName: string; filePath?: string; manifestSource: string }>
>();

/**
 * Discover manifest entry asynchronously (includes external package loading)
 *
 * Search order:
 * 1. External package manifest (for constructor's package) - PRIORITIZED
 * 2. testManifest (for test classes)
 * 3. staticManifest (for core framework classes)
 * 4. Cached external manifests
 *
 * This function now detects and reports class name collisions across packages.
 *
 * @param ctor - Class constructor
 * @param className - Class name (for lookup)
 * @returns ManifestEntry or undefined if not found
 * @throws {Error} If class name collision detected across different packages
 */
export async function discoverManifestEntry(
  ctor: new (...args: any[]) => any,
  className: string,
): Promise<ManifestEntry | undefined> {
  const name = className.toLowerCase();
  const constructorPackage = getPackageName(ctor);

  console.log(
    `[discoverManifestEntry] Looking for ${className}, constructorPackage: ${constructorPackage}`,
  );

  // Track all manifest sources that define this class
  const foundEntries: Array<{
    entry: ManifestEntry;
    packageName: string;
    filePath?: string;
    manifestSource: string;
  }> = [];

  // 1. PRIORITY: Try loading from the constructor's package first
  if (constructorPackage) {
    const manifest = await loadExternalManifest(constructorPackage);
    if (manifest) {
      const entry = manifest.objects[name] || manifest.objects[className];
      if (entry) {
        const enrichedEntry =
          !entry.packageName && manifest.packageName
            ? { ...entry, packageName: manifest.packageName }
            : entry;

        console.log(
          `[discoverManifestEntry] Found in constructor's package ${constructorPackage}: ${Object.keys(entry.fields || {}).join(', ')}`,
        );

        foundEntries.push({
          entry: enrichedEntry,
          packageName: manifest.packageName || constructorPackage,
          filePath: entry.filePath,
          manifestSource: `${manifest.packageName || constructorPackage}/manifest.json`,
        });
      }
    }
  }

  // 2. Check localTestManifest (domain package test classes)
  if (localTestManifest === undefined) {
    loadLocalTestManifestSync();
  }
  const localEntry =
    localTestManifest?.objects[name] || localTestManifest?.objects[className];
  if (localEntry) {
    console.log(
      `[discoverManifestEntry] Found in local test manifest: ${Object.keys(localEntry.fields || {}).join(', ')}`,
    );
    foundEntries.push({
      entry: localEntry,
      packageName: localTestManifest?.packageName || 'local-test',
      filePath: localEntry.filePath,
      manifestSource: 'local test manifest',
    });
  }

  // 3. Check testManifest (core test classes)
  const testEntry =
    testManifest?.objects[name] || testManifest?.objects[className];
  if (testEntry) {
    console.log(
      `[discoverManifestEntry] Found in core test manifest: ${Object.keys(testEntry.fields || {}).join(', ')}`,
    );
    foundEntries.push({
      entry: testEntry,
      packageName: testManifest.packageName || '@happyvertical/smrt-core',
      filePath: testEntry.filePath,
      manifestSource: '@happyvertical/smrt-core test manifest',
    });
  }

  // 4. Check staticManifest (core framework classes)
  const staticObjects = staticManifest.objects as Record<string, ManifestEntry>;
  const staticEntry = staticObjects[name] || staticObjects[className];
  if (staticEntry) {
    console.log(
      `[discoverManifestEntry] Found in static manifest: ${Object.keys(staticEntry.fields || {}).join(', ')}`,
    );
    foundEntries.push({
      entry: staticEntry,
      packageName: staticManifest.packageName || '@happyvertical/smrt-core',
      filePath: staticEntry.filePath,
      manifestSource: '@happyvertical/smrt-core static manifest',
    });
  }

  // 5. Check other cached external manifests
  for (const [cachedPkgName, manifest] of manifestCache.entries()) {
    // Skip if this is the constructor's package (already checked above)
    if (cachedPkgName === constructorPackage) {
      continue;
    }

    const entry = manifest.objects[name] || manifest.objects[className];
    if (entry) {
      console.log(
        `[discoverManifestEntry] Found in cached package ${cachedPkgName}: ${Object.keys(entry.fields || {}).join(', ')}`,
      );
      foundEntries.push({
        entry:
          !entry.packageName && manifest.packageName
            ? { ...entry, packageName: manifest.packageName }
            : entry,
        packageName: manifest.packageName || cachedPkgName,
        filePath: entry.filePath,
        manifestSource: `${manifest.packageName || cachedPkgName}/manifest.json`,
      });
    }
  }

  console.log(
    `[discoverManifestEntry] Total entries found for ${className}: ${foundEntries.length}`,
  );

  // Detect collisions: multiple packages defining the same class name
  if (foundEntries.length > 1) {
    const collisionInfo = foundEntries.map(
      (f) =>
        `  - ${f.packageName} (${f.filePath || 'unknown file'}) from ${f.manifestSource}`,
    );

    // Store collision info for reporting
    manifestCollisions.set(
      className,
      foundEntries.map((f) => ({
        packageName: f.packageName,
        filePath: f.filePath,
        manifestSource: f.manifestSource,
      })),
    );

    // Throw error on collision
    throw new Error(
      `SMRT Class Name Collision Detected: "${className}"\n\n` +
        `This class is defined in multiple packages:\n${collisionInfo.join('\n')}\n\n` +
        `The collision will cause the wrong field definitions to be used,\n` +
        `leading to properties not being initialized correctly.\n\n` +
        `To fix:\n` +
        `  1. Use unique class names across packages (e.g., ${className}_${constructorPackage?.split('/').pop() || 'Unique'})\n` +
        `  2. Or use @smrt({ name: 'unique_name' }) to override the registration name\n` +
        `  3. Remove test classes with conflicting names from production manifests\n\n` +
        `If this is a test class collision, ensure test manifests are not included in production builds.`,
    );
  }

  // Return the found entry (priority given to constructor's package)
  if (foundEntries.length === 1) {
    console.log(
      `[discoverManifestEntry] Returning entry from ${foundEntries[0].manifestSource}`,
    );
    return foundEntries[0].entry;
  }

  console.log(
    `[discoverManifestEntry] No manifest entry found for ${className}`,
  );
  return undefined;
}

/**
 * Get all detected manifest collisions
 *
 * @returns Map of class names to array of collision info
 */
export function getManifestCollisions(): Map<
  string,
  Array<{ packageName: string; filePath?: string; manifestSource: string }>
> {
  return new Map(manifestCollisions);
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
