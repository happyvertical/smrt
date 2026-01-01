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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ObjectRegistry } from '../registry.js';
import type {
  FieldDefinition,
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { ManifestManager } from './manager.js';

/**
 * Extend globalThis to include manifest loader state.
 * Using globalThis ensures all module instances share the same manifest caches,
 * which is critical in monorepos where the same package can be loaded
 * from different paths (e.g., pnpm store vs workspace symlink).
 *
 * @see https://github.com/happyvertical/smrt/issues/543
 */
declare global {
  // eslint-disable-next-line no-var
  var __smrtManifestStatic: SmartObjectManifest | null | undefined;
  // eslint-disable-next-line no-var
  var __smrtManifestStaticLoadAttempted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __smrtManifestTest: SmartObjectManifest | null | undefined;
  // eslint-disable-next-line no-var
  var __smrtManifestTestLoadAttempted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __smrtManifestCache: Map<string, SmartObjectManifest> | undefined;
  // eslint-disable-next-line no-var
  var __smrtManifestLocalTest: SmartObjectManifest | null | undefined;
  // eslint-disable-next-line no-var
  var __smrtManifestCollisions:
    | Map<
        string,
        Array<{
          packageName: string;
          filePath?: string;
          manifestSource: string;
        }>
      >
    | undefined;
}

// Use globalThis for cross-module state sharing
// This ensures loadConfig() in one module instance affects all packages

/**
 * Get/set staticManifest from globalThis
 */
function getStaticManifestCache(): SmartObjectManifest | null {
  return globalThis.__smrtManifestStatic ?? null;
}

function setStaticManifestCache(manifest: SmartObjectManifest | null): void {
  globalThis.__smrtManifestStatic = manifest;
}

function getStaticManifestLoadAttempted(): boolean {
  return globalThis.__smrtManifestStaticLoadAttempted ?? false;
}

function setStaticManifestLoadAttempted(value: boolean): void {
  globalThis.__smrtManifestStaticLoadAttempted = value;
}

/**
 * Get/set testManifest from globalThis
 */
function getTestManifestCache(): SmartObjectManifest | null {
  return globalThis.__smrtManifestTest ?? null;
}

function setTestManifestCache(manifest: SmartObjectManifest | null): void {
  globalThis.__smrtManifestTest = manifest;
}

function getTestManifestLoadAttempted(): boolean {
  return globalThis.__smrtManifestTestLoadAttempted ?? false;
}

function setTestManifestLoadAttempted(value: boolean): void {
  globalThis.__smrtManifestTestLoadAttempted = value;
}

/**
 * Get the manifest cache Map from globalThis
 */
function getManifestCacheMap(): Map<string, SmartObjectManifest> {
  if (!globalThis.__smrtManifestCache) {
    globalThis.__smrtManifestCache = new Map<string, SmartObjectManifest>();
  }
  return globalThis.__smrtManifestCache;
}

/**
 * Get/set localTestManifest from globalThis
 */
function getLocalTestManifestCache(): SmartObjectManifest | null | undefined {
  return globalThis.__smrtManifestLocalTest;
}

function setLocalTestManifestCache(
  manifest: SmartObjectManifest | null | undefined,
): void {
  globalThis.__smrtManifestLocalTest = manifest;
}

/**
 * Get the manifest collisions Map from globalThis
 */
function getManifestCollisionsMap(): Map<
  string,
  Array<{ packageName: string; filePath?: string; manifestSource: string }>
> {
  if (!globalThis.__smrtManifestCollisions) {
    globalThis.__smrtManifestCollisions = new Map();
  }
  return globalThis.__smrtManifestCollisions;
}

// Create require function once for reuse
const require = createRequire(import.meta.url);

/**
 * Detect if we're running in a test environment
 * Test manifests should ONLY be loaded during tests to avoid collisions with production classes
 */
function isTestEnvironment(): boolean {
  const isTest =
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    process.env.JEST_WORKER_ID !== undefined;

  if (process.env.DEBUG_TEST_ENV) {
    console.log('[manifest-loader] isTestEnvironment check:', {
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
      JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      result: isTest,
    });
  }

  return isTest;
}

function getStaticManifest(): SmartObjectManifest {
  if (!getStaticManifestLoadAttempted()) {
    setStaticManifestLoadAttempted(true);
    try {
      // Try to import the generated static manifest
      const imported = require('./static-manifest.js');
      setStaticManifestCache(imported.staticManifest || imported.default);
    } catch {
      // Fallback to empty manifest if file doesn't exist yet (during build)
      setStaticManifestCache({
        version: '1.0.0',
        timestamp: Date.now(),
        objects: {},
        packageName: '@happyvertical/smrt-core',
      });
    }
  }
  return getStaticManifestCache()!;
}

/**
 * Lazy-load test manifest ONLY when in test environment
 * This prevents test classes from being loaded in production and causing collisions
 */
function getTestManifest(): SmartObjectManifest | null {
  if (!getTestManifestLoadAttempted()) {
    setTestManifestLoadAttempted(true);

    // CRITICAL: Only load test manifest in test environment
    if (!isTestEnvironment()) {
      if (process.env.DEBUG_TEST_ENV) {
        console.log(
          '[manifest-loader] ⚠️  Skipping test manifest load (not in test environment)',
        );
      }
      setTestManifestCache(null);
      return null;
    }

    try {
      // Dynamically import test manifest to avoid loading in production
      const imported = require('./test-manifest-stub.js');
      const manifest = imported.testManifest || imported.default;
      setTestManifestCache(manifest);
      if (process.env.DEBUG_TEST_ENV) {
        console.log(
          `[manifest-loader] ✅ Loaded test manifest (${Object.keys(manifest?.objects || {}).length} objects)`,
        );
      }
    } catch (error) {
      if (process.env.DEBUG_TEST_ENV) {
        console.log(
          '[manifest-loader] ⚠️  Test manifest not found (this is normal in production)',
        );
      }
      setTestManifestCache(null);
    }
  }
  return getTestManifestCache();
}

// Re-export types for convenience
export type Manifest = SmartObjectManifest;
export type ManifestEntry = SmartObjectDefinition;
export type { FieldDefinition, MethodDefinition };

// Note: manifestCache and localTestManifest are now accessed via globalThis helper functions
// getManifestCacheMap() and getLocalTestManifestCache()/setLocalTestManifestCache()

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
  // Only return cached manifest if it was successfully loaded
  // Don't cache null (failed loads) - allow retries
  const cached = getLocalTestManifestCache();
  if (cached !== undefined && cached !== null) {
    return cached;
  }

  // Use ManifestManager for unified local loading
  // This checks: .smrt/manifest.json -> dist/manifest.json
  const manager = new ManifestManager(process.cwd());
  const manifest = manager.loadLocal();

  if (manifest) {
    setLocalTestManifestCache(manifest);
    const objectCount = Object.keys(manifest.objects).length;
    console.log(
      `[manifest-loader] ✅ Loaded local manifest via ManifestManager (${objectCount} objects)`,
    );
    return manifest;
  }

  // Fallback: Check src/manifest/test-manifest.json for backward compatibility
  // This is still used by smrt-core and other packages that generate test manifests here
  const testManifestPath = join(
    process.cwd(),
    'src/manifest/test-manifest.json',
  );
  if (existsSync(testManifestPath)) {
    try {
      const testManifest: Manifest = JSON.parse(
        readFileSync(testManifestPath, 'utf-8'),
      );
      setLocalTestManifestCache(testManifest);
      const objectCount = Object.keys(testManifest.objects).length;
      console.log(
        `[manifest-loader] ✅ Loaded test manifest from ${testManifestPath} (${objectCount} objects)`,
      );
      return testManifest;
    } catch (error) {
      console.log(
        `[manifest-loader] ✗ Failed to load test manifest from ${testManifestPath}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  // No manifest found - DON'T cache null, allow retries
  // This is important because the manifest may be generated later
  console.log(
    '[manifest-loader] ⚠️  No local manifest found (will retry on next call)',
  );
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
/**
 * Load external package manifest synchronously
 * This is the synchronous version of loadExternalManifest for use during class registration
 */
export function loadExternalManifestSync(packageName: string): Manifest | null {
  // Check cache first
  if (getManifestCacheMap().has(packageName)) {
    console.log(`[manifest-loader] Using cached manifest for ${packageName}`);
    return getManifestCacheMap().get(packageName)!;
  }

  console.log(
    `[manifest-loader] Attempting to load external manifest for ${packageName}`,
  );

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

  // Try Method 3: Workspace/monorepo packages - works for pnpm workspaces
  if (!pkgPath) {
    // Extract package short name (e.g., @happyvertical/smrt-profiles -> profiles)
    const packageShortName = packageName.split('/').pop() || '';
    const packageWithoutScope = packageShortName.replace(/^smrt-/, '');

    // Check if we're in a pnpm workspace by looking for pnpm-workspace.yaml
    // or if we're in a monorepo structure where packages are siblings
    const workspacePaths = [
      // Same monorepo - sibling packages (e.g., packages/core -> packages/profiles)
      join(process.cwd(), '..', packageWithoutScope),
      join(process.cwd(), '..', packageShortName),
      // From monorepo root
      join(process.cwd(), '../..', 'packages', packageWithoutScope),
      join(process.cwd(), '../..', 'packages', packageShortName),
      // Sibling monorepo (e.g., smrt -> ../praeco)
      join(process.cwd(), '../..', packageWithoutScope),
      join(process.cwd(), '../..', packageShortName),
      join(process.cwd(), '../../..', packageWithoutScope),
      join(process.cwd(), '../../..', packageShortName),
    ];

    for (const workspacePath of workspacePaths) {
      const workspacePkgPath = join(workspacePath, 'package.json');
      try {
        if (existsSync(workspacePkgPath)) {
          const content = readFileSync(workspacePkgPath, 'utf-8');
          const json = JSON.parse(content);
          if (json.name === packageName) {
            pkgPath = workspacePkgPath;
            console.log(
              `[manifest-loader] ✅ Found ${packageName} in workspace at ${workspacePath}`,
            );
            break;
          }
        }
      } catch {
        // Keep trying other paths
      }
    }
  }

  if (!pkgPath) {
    console.log(
      `[manifest-loader] Could not find package.json for ${packageName}`,
    );
    return null;
  }

  try {
    const pkgDir = dirname(pkgPath);

    // Use ManifestManager for unified manifest loading
    // This properly handles the priority order: .smrt/manifest.json -> dist/manifest.json
    // which ensures test manifests are loaded during tests in monorepo environments
    const manager = new ManifestManager(pkgDir);
    const manifest = manager.loadLocal();

    if (manifest) {
      // Validate manifest structure
      if (!manifest.objects || typeof manifest.objects !== 'object') {
        console.warn(`Invalid manifest structure for package ${packageName}`);
        return null;
      }

      // Cache the loaded manifest
      getManifestCacheMap().set(packageName, manifest);
      console.log(
        `[manifest-loader] ✅ Loaded external manifest for ${packageName} (${Object.keys(manifest.objects).length} objects)`,
      );

      return manifest;
    }

    // Fallback: Try package.json exports (for published packages without .smrt/)
    const pkgJson = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    let manifestExport = pkgJson.exports?.['./manifest.json'];

    if (!manifestExport) {
      manifestExport = pkgJson.exports?.['./manifest'];
    }

    if (!manifestExport) {
      console.log(
        `[manifest-loader] Package ${packageName} does not export manifest (checked ./manifest.json and ./manifest)`,
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

    // Check if the path points to a JSON file
    if (!manifestRelPath.endsWith('.json')) {
      console.log(
        `[manifest-loader] Package ${packageName} manifest export points to non-JSON file: ${manifestRelPath}`,
      );
      return null;
    }

    const manifestPath = join(pkgDir, manifestRelPath);

    // Read and parse manifest JSON
    const manifestJson = readFileSync(manifestPath, 'utf-8');
    const fallbackManifest: Manifest = JSON.parse(manifestJson);

    // Validate manifest structure
    if (
      !fallbackManifest.objects ||
      typeof fallbackManifest.objects !== 'object'
    ) {
      console.warn(`Invalid manifest structure for package ${packageName}`);
      return null;
    }

    // Cache the loaded manifest
    getManifestCacheMap().set(packageName, fallbackManifest);
    console.log(
      `[manifest-loader] ✅ Loaded external manifest for ${packageName} (${Object.keys(fallbackManifest.objects).length} objects) via exports`,
    );

    return fallbackManifest;
  } catch (error) {
    console.warn(
      `Failed to load manifest for package ${packageName}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}

export async function loadExternalManifest(
  packageName: string,
): Promise<Manifest | null> {
  // Delegate to synchronous version since all operations are sync anyway
  return loadExternalManifestSync(packageName);
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

  console.log(
    `[manifest-loader] discoverManifestSync called for: ${className}`,
  );

  // 1. Check localTestManifest (domain package classes) - ONLY in test environment
  // This prevents test classes from polluting production code
  if (isTestEnvironment()) {
    if (!getLocalTestManifestCache()) {
      loadLocalTestManifestSync();
    }

    if (getLocalTestManifestCache()?.objects[name]) {
      console.log(
        `[manifest-loader] ✅ Found ${className} in localTestManifest (lowercase key)`,
      );
      return getLocalTestManifestCache()?.objects[name];
    }
    if (getLocalTestManifestCache()?.objects[className]) {
      console.log(
        `[manifest-loader] ✅ Found ${className} in localTestManifest (exact key)`,
      );
      return getLocalTestManifestCache()?.objects[className];
    }
  }

  // 2. Check testManifest (core test classes) - ONLY in test environment
  if (isTestEnvironment()) {
    const manifest = getTestManifest();
    if (manifest?.objects[name]) {
      console.log(
        `[manifest-loader] ✅ Found ${className} in testManifest (lowercase key)`,
      );
      return manifest.objects[name];
    }
    if (manifest?.objects[className]) {
      console.log(
        `[manifest-loader] ✅ Found ${className} in testManifest (exact key)`,
      );
      return manifest.objects[className];
    }
  }

  // 3. Check staticManifest (core framework classes)
  const staticObjects = getStaticManifest().objects as Record<
    string,
    ManifestEntry
  >;
  if (staticObjects[name]) {
    console.log(
      `[manifest-loader] ✅ Found ${className} in staticManifest (lowercase key)`,
    );
    return staticObjects[name];
  }
  if (staticObjects[className]) {
    console.log(
      `[manifest-loader] ✅ Found ${className} in staticManifest (exact key)`,
    );
    return staticObjects[className];
  }

  // 4. Check cached external manifests
  for (const manifest of getManifestCacheMap().values()) {
    const entry = manifest.objects[name] || manifest.objects[className];
    if (entry) {
      console.log(
        `[manifest-loader] ✅ Found ${className} in external manifest cache`,
      );
      // Enrich entry with packageName from manifest if not already present
      if (!entry.packageName && manifest.packageName) {
        return { ...entry, packageName: manifest.packageName };
      }
      return entry;
    }
  }

  // 5. Try loading from external SMRT packages
  // This handles STI inheritance where child class is in one package
  // but parent class is in another (e.g., Meeting in praeco extends Event from smrt-events)
  console.log(
    `[manifest-loader] ${className} not found in cached manifests, trying external packages...`,
  );

  // Read discovered packages from manifest (populated at build time)
  const smrtPackages = getLocalTestManifestCache()?.smrtDependencies || [];

  if (smrtPackages.length === 0) {
    console.log(
      '[manifest-loader] No SMRT dependencies discovered. Run manifest generation if external packages are expected.',
    );
  }

  for (const pkg of smrtPackages) {
    const manifest = loadExternalManifestSync(pkg);
    if (manifest) {
      const entry = manifest.objects[name] || manifest.objects[className];
      if (entry) {
        console.log(
          `[manifest-loader] ✅ Found ${className} in external package ${pkg}`,
        );
        // Enrich entry with packageName from manifest if not already present
        if (!entry.packageName && manifest.packageName) {
          return { ...entry, packageName: manifest.packageName };
        }
        return entry;
      }
    }
  }

  // 6. Scan ALL @happyvertical packages in node_modules for manifests
  // This is critical for production environments where localTestManifest is not available
  // and smrtDependencies is empty. Without this, external package classes (like EventType
  // from smrt-events) won't be found, causing schema generation to miss indexes.
  try {
    const nodeModulesPath = join(
      process.cwd(),
      'node_modules',
      '@happyvertical',
    );
    if (existsSync(nodeModulesPath)) {
      const packages = readdirSync(nodeModulesPath);
      console.log(
        `[manifest-loader] Scanning ${packages.length} @happyvertical packages in node_modules for ${className}`,
      );
      for (const pkg of packages) {
        const fullPackageName = `@happyvertical/${pkg}`;
        // Skip if already in cache (already checked above)
        if (getManifestCacheMap().has(fullPackageName)) {
          continue;
        }
        // Check for manifest in dist/ or root
        const manifestPaths = [
          join(nodeModulesPath, pkg, 'dist', 'manifest.json'),
          join(nodeModulesPath, pkg, 'manifest.json'),
        ];
        for (const manifestPath of manifestPaths) {
          if (existsSync(manifestPath)) {
            try {
              const manifestContent = readFileSync(manifestPath, 'utf-8');
              const manifest: Manifest = JSON.parse(manifestContent);
              // Cache it for future lookups
              getManifestCacheMap().set(fullPackageName, manifest);
              // Check if this manifest has the class we're looking for
              const entry =
                manifest.objects[name] || manifest.objects[className];
              if (entry) {
                console.log(
                  `[manifest-loader] ✅ Found ${className} in node_modules package ${fullPackageName}`,
                );
                // Enrich entry with packageName from manifest if not already present
                if (!entry.packageName && manifest.packageName) {
                  return { ...entry, packageName: manifest.packageName };
                }
                return entry;
              }
              break; // Found manifest for this package, move to next package
            } catch (parseError) {
              console.log(
                `[manifest-loader] Failed to parse manifest at ${manifestPath}: ${parseError}`,
              );
            }
          }
        }
      }
    }
  } catch (scanError) {
    console.log(
      `[manifest-loader] Failed to scan node_modules for ${className}: ${scanError}`,
    );
  }

  console.log(`[manifest-loader] ❌ ${className} not found in any manifest`);
  return undefined;
}

// Note: manifestCollisions is now accessed via globalThis helper function
// getManifestCollisionsMap()

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

  // Track all manifest sources that define this class
  const foundEntries: Array<{
    entry: ManifestEntry;
    packageName: string;
    filePath?: string;
    manifestSource: string;
  }> = [];

  // 2. Check localTestManifest first (domain package test classes) - ONLY in test environment
  // Do this BEFORE loading external manifest to avoid duplicate loading
  let localEntry: SmartObjectDefinition | undefined;
  if (isTestEnvironment()) {
    if (getLocalTestManifestCache() === undefined) {
      loadLocalTestManifestSync();
    }
    localEntry =
      getLocalTestManifestCache()?.objects[name] ||
      getLocalTestManifestCache()?.objects[className];
    if (localEntry) {
      foundEntries.push({
        entry: localEntry,
        packageName: getLocalTestManifestCache()?.packageName || 'local-test',
        filePath: localEntry.filePath,
        manifestSource: 'local test manifest',
      });
    }
  }

  // 1. PRIORITY: Try loading from the constructor's package first
  // BUT skip if it's the same package as the local test manifest to avoid collisions
  if (constructorPackage) {
    const skipExternal =
      getLocalTestManifestCache()?.packageName &&
      constructorPackage === getLocalTestManifestCache()?.packageName;

    if (!skipExternal) {
      const manifest = await loadExternalManifest(constructorPackage);
      if (manifest) {
        const entry = manifest.objects[name] || manifest.objects[className];
        if (entry) {
          const enrichedEntry =
            !entry.packageName && manifest.packageName
              ? { ...entry, packageName: manifest.packageName }
              : entry;

          foundEntries.push({
            entry: enrichedEntry,
            packageName: manifest.packageName || constructorPackage,
            filePath: entry.filePath,
            manifestSource: `${manifest.packageName || constructorPackage}/manifest.json`,
          });
        }
      }
    }
  }

  // 3. Check testManifest (core test classes) - ONLY in test environment
  // Skip if we already loaded a local test manifest (avoids duplicate entries from same package)
  if (isTestEnvironment() && (!getLocalTestManifestCache() || !localEntry)) {
    const manifest = getTestManifest();
    const testEntry = manifest?.objects[name] || manifest?.objects[className];
    if (testEntry) {
      foundEntries.push({
        entry: testEntry,
        packageName: manifest?.packageName || '@happyvertical/smrt-core',
        filePath: testEntry.filePath,
        manifestSource: '@happyvertical/smrt-core test manifest',
      });
    }
  }

  // 4. Check staticManifest (core framework classes)
  const staticManifestData = getStaticManifest();
  const staticObjects = staticManifestData.objects as Record<
    string,
    ManifestEntry
  >;
  const staticEntry = staticObjects[name] || staticObjects[className];
  if (staticEntry) {
    foundEntries.push({
      entry: staticEntry,
      packageName: staticManifestData.packageName || '@happyvertical/smrt-core',
      filePath: staticEntry.filePath,
      manifestSource: '@happyvertical/smrt-core static manifest',
    });
  }

  // 5. Check other cached external manifests
  for (const [cachedPkgName, manifest] of getManifestCacheMap().entries()) {
    // Skip if this is the constructor's package (already checked above)
    if (cachedPkgName === constructorPackage) {
      continue;
    }

    const entry = manifest.objects[name] || manifest.objects[className];
    if (entry) {
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

  // Detect collisions: multiple packages defining the same class name
  if (foundEntries.length > 1) {
    const collisionInfo = foundEntries.map(
      (f) =>
        `  - ${f.packageName} (${f.filePath || 'unknown file'}) from ${f.manifestSource}`,
    );

    // Store collision info for reporting
    getManifestCollisionsMap().set(
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
    return foundEntries[0].entry;
  }

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
  return new Map(getManifestCollisionsMap());
}

/**
 * Clear manifest cache
 *
 * Useful for testing or when packages are updated at runtime.
 */
export function clearManifestCache(): void {
  getManifestCacheMap().clear();
}

/**
 * Get all loaded manifests
 *
 * Returns a copy of the manifest cache for inspection.
 *
 * @returns Array of [packageName, manifest] entries
 */
export function getLoadedManifests(): Array<[string, Manifest]> {
  return Array.from(getManifestCacheMap().entries());
}

/**
 * Discover all STI sibling classes that share the same collection (table)
 *
 * This is critical for STI schema merging: when one subtype is accessed,
 * we need to discover ALL subtypes sharing the same table so that the
 * database adapter receives a complete schema with all columns.
 *
 * Scans all available manifests:
 * 1. Local test manifest (for test classes)
 * 2. Test manifest (for core test classes)
 * 3. Static manifest (for core framework classes)
 * 4. Cached external manifests
 * 5. SMRT dependencies from local test manifest
 *
 * @param collection - The collection/table name to find siblings for
 * @returns Array of manifest entries that share the same collection
 */
export function discoverSTISiblingsSync(
  collection: string,
): Array<{ className: string; entry: ManifestEntry; packageName?: string }> {
  const siblings: Array<{
    className: string;
    entry: ManifestEntry;
    packageName?: string;
  }> = [];

  // Track already-found class names to avoid duplicates
  const foundClasses = new Set<string>();

  console.log(
    `[manifest-loader] discoverSTISiblingsSync called for collection: ${collection}`,
  );

  // Helper to add entries from a manifest
  const addFromManifest = (
    manifest: Manifest | null | undefined,
    source: string,
  ) => {
    if (!manifest?.objects) return;

    for (const [key, entry] of Object.entries(manifest.objects) as [
      string,
      ManifestEntry,
    ][]) {
      // Check if this entry uses the same collection (table)
      if (entry.collection === collection) {
        const className = entry.className || key;
        if (!foundClasses.has(className)) {
          foundClasses.add(className);
          siblings.push({
            className,
            entry,
            packageName: entry.packageName || manifest.packageName,
          });
          console.log(
            `[manifest-loader] Found STI sibling: ${className} (collection: ${collection}) from ${source}`,
          );
        }
      }
    }
  };

  // 1. Check local test manifest (domain package test classes)
  if (isTestEnvironment()) {
    if (!getLocalTestManifestCache()) {
      loadLocalTestManifestSync();
    }
    addFromManifest(getLocalTestManifestCache(), 'localTestManifest');
  }

  // 2. Check test manifest (core test classes)
  if (isTestEnvironment()) {
    const testManifestData = getTestManifest();
    addFromManifest(testManifestData, 'testManifest');
  }

  // 3. Check static manifest (core framework classes)
  const staticManifestData = getStaticManifest();
  addFromManifest(staticManifestData, 'staticManifest');

  // 4. Check cached external manifests
  for (const [pkgName, manifest] of getManifestCacheMap().entries()) {
    addFromManifest(manifest, `manifestCache:${pkgName}`);
  }

  // 5. Try loading from SMRT dependencies from ALL manifests (not just localTestManifest)
  // This ensures production environments also discover STI siblings
  const allSmrtDeps = new Set<string>();

  // Collect from localTestManifest (test environment)
  if (getLocalTestManifestCache()?.smrtDependencies) {
    for (const pkg of getLocalTestManifestCache()?.smrtDependencies!) {
      allSmrtDeps.add(pkg);
    }
  }

  // Collect from ALL cached manifests (production)
  for (const [, manifest] of getManifestCacheMap().entries()) {
    if (manifest.smrtDependencies) {
      for (const pkg of manifest.smrtDependencies) {
        allSmrtDeps.add(pkg);
      }
    }
  }

  // Also check static manifest for smrtDependencies
  if (staticManifestData?.smrtDependencies) {
    for (const pkg of staticManifestData.smrtDependencies) {
      allSmrtDeps.add(pkg);
    }
  }

  console.log(
    `[manifest-loader] Scanning ${allSmrtDeps.size} SMRT dependencies for STI siblings: ${[...allSmrtDeps].join(', ')}`,
  );

  // Load and scan each dependency
  for (const pkg of allSmrtDeps) {
    if (!getManifestCacheMap().has(pkg)) {
      const manifest = loadExternalManifestSync(pkg);
      if (manifest) {
        addFromManifest(manifest, `smrtDependency:${pkg}`);
      }
    }
  }

  // 6. Scan ALL @happyvertical packages in node_modules for manifests
  // This catches peer packages like praeco/caelus that aren't in smrtDependencies
  try {
    const nodeModulesPath = join(
      process.cwd(),
      'node_modules',
      '@happyvertical',
    );
    if (existsSync(nodeModulesPath)) {
      const packages = readdirSync(nodeModulesPath);
      console.log(
        `[manifest-loader] Scanning ${packages.length} @happyvertical packages in node_modules`,
      );
      for (const pkg of packages) {
        const fullPackageName = `@happyvertical/${pkg}`;
        // Skip if already in cache
        if (getManifestCacheMap().has(fullPackageName)) {
          continue;
        }
        // Check for manifest in dist/ or root
        const manifestPaths = [
          join(nodeModulesPath, pkg, 'dist', 'manifest.json'),
          join(nodeModulesPath, pkg, 'manifest.json'),
        ];
        for (const manifestPath of manifestPaths) {
          if (existsSync(manifestPath)) {
            try {
              const manifestContent = readFileSync(manifestPath, 'utf-8');
              const manifest = JSON.parse(manifestContent);
              // Cache it
              getManifestCacheMap().set(fullPackageName, manifest);
              addFromManifest(manifest, `nodeModules:${fullPackageName}`);
              break; // Found manifest, skip other paths
            } catch (parseError) {
              console.log(
                `[manifest-loader] Failed to parse manifest at ${manifestPath}: ${parseError}`,
              );
            }
          }
        }
      }
    }
  } catch (scanError) {
    console.log(`[manifest-loader] Failed to scan node_modules: ${scanError}`);
  }

  console.log(
    `[manifest-loader] discoverSTISiblingsSync found ${siblings.length} siblings for collection: ${collection}`,
  );

  return siblings;
}
