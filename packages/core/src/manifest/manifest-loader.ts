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
 * 3. Resolve external package manifests from explicit JSON exports
 * 4. Return manifest entry or undefined
 *
 * External manifest loading intentionally follows a pure-ESM JSON contract.
 * Packages are expected to publish a JSON manifest via "./manifest" and/or
 * "./manifest.json" exports. Runtime discovery does not guess sibling workspace
 * paths or load JavaScript manifest modules.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createLogger } from '@happyvertical/logger';
import type { SmrtObjectConstructor } from '../registry/types.js';
import { ObjectRegistry } from '../registry.js';
import type {
  FieldDefinition,
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { parse } from '../utils/json.js';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from '../utils/qualified-names.js';
import { ManifestManager } from './manager.js';
import { getDefaultCompositeSource } from './sources/composite.js';
import {
  getLocalTestManifestCache as getLocalTestManifestCacheFromStore,
  getManifestCache as getManifestCacheFromStore,
  getStaticManifestCache as getStaticManifestCacheFromStore,
  getTestManifestCache as getTestManifestCacheFromStore,
  isTestEnvironment as isTestEnvFromStore,
  shouldLoadCoreTestManifest,
} from './store.js';

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
  // eslint-disable-next-line no-var
  var __smrtSTISiblingCache:
    | Map<
        string,
        Array<{ className: string; entry: ManifestEntry; packageName?: string }>
      >
    | undefined;
}

// Use globalThis for cross-module state sharing
// This ensures loadConfig() in one module instance affects all packages

// ── Cache access (delegates to manifest/store.ts — the single source of
// truth added in Release B #1133 for globalThis manifest state).
// manifest-loader.ts keeps its own setters + load-attempted flags below
// because those are internal to this module's async loader state machine;
// the read-only getters just forward to store.ts to eliminate drift.

const getStaticManifestCache = getStaticManifestCacheFromStore;
const getTestManifestCache = getTestManifestCacheFromStore;
const getLocalTestManifestCache = getLocalTestManifestCacheFromStore;
const getManifestCacheMap = getManifestCacheFromStore;

function setStaticManifestCache(
  manifest: SmartObjectManifest | null | undefined,
): void {
  globalThis.__smrtManifestStatic = manifest;
}

function getStaticManifestLoadAttempted(): boolean {
  return globalThis.__smrtManifestStaticLoadAttempted ?? false;
}

function setStaticManifestLoadAttempted(value: boolean): void {
  globalThis.__smrtManifestStaticLoadAttempted = value;
}

function setTestManifestCache(
  manifest: SmartObjectManifest | null | undefined,
): void {
  globalThis.__smrtManifestTest = manifest;
}

function getTestManifestLoadAttempted(): boolean {
  return globalThis.__smrtManifestTestLoadAttempted ?? false;
}

function setTestManifestLoadAttempted(value: boolean): void {
  globalThis.__smrtManifestTestLoadAttempted = value;
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

/**
 * Get the STI sibling cache Map from globalThis
 * Caches discoverSTISiblingsSync results per collection to avoid repeated scans
 */
function getSTISiblingCache(): Map<
  string,
  Array<{ className: string; entry: ManifestEntry; packageName?: string }>
> {
  if (!globalThis.__smrtSTISiblingCache) {
    globalThis.__smrtSTISiblingCache = new Map();
  }
  return globalThis.__smrtSTISiblingCache;
}

// Create require function once for reuse
const require = createRequire(import.meta.url);

/**
 * Cached debug flag evaluated once at module load time.
 * Environment variables don't change at runtime, so this is safe.
 * @see https://github.com/happyvertical/smrt/issues/729
 */
const DEBUG_ENABLED =
  process.env.DEBUG_MANIFEST === 'true' ||
  process.env.DEBUG_MANIFEST === '1' ||
  process.env.DEBUG?.includes('manifest') ||
  false;

// The debug traces below are gated by DEBUG_MANIFEST / DEBUG_TEST_ENV, so the
// logger level must allow debug when either is set (a fixed 'info' would filter
// them out and silently break those debug switches).
const logger = createLogger({
  level: DEBUG_ENABLED || process.env.DEBUG_TEST_ENV ? 'debug' : 'info',
});

/**
 * Log a debug message only if DEBUG_MANIFEST is enabled.
 * Uses cached boolean check instead of repeated env var access.
 */
function debugLog(message: string): void {
  if (DEBUG_ENABLED) {
    logger.debug(message);
  }
}

/**
 * Cache for className-to-entry index per manifest.
 * This enables O(1) lookup by className instead of O(n) iteration.
 * @see https://github.com/happyvertical/smrt/issues/729
 */
const classNameIndexCache = new WeakMap<
  SmartObjectManifest,
  Map<string, SmartObjectDefinition>
>();

/**
 * Get or build the className index for a manifest.
 * Index maps lowercase className to entry for O(1) lookup.
 */
function getClassNameIndex(
  manifest: SmartObjectManifest,
): Map<string, SmartObjectDefinition> {
  let index = classNameIndexCache.get(manifest);
  if (!index) {
    index = new Map<string, SmartObjectDefinition>();
    for (const [key, entry] of Object.entries(manifest.objects)) {
      const name = (entry.className || key).toLowerCase();
      if (!index.has(name)) {
        index.set(name, entry);
      } else {
        const existing = index.get(name)!;
        const existingName = (existing.className || '').toLowerCase();
        const newExtends = (entry.extends || '').toLowerCase();
        const existingExtends = (existing.extends || '').toLowerCase();

        // Issue #950: STI child-wins — if new entry extends existing, replace
        if (
          newExtends &&
          (newExtends === existingName || newExtends === name)
        ) {
          index.set(name, entry);
          debugLog(
            `Manifest className '${name}': child '${key}' replaces parent`,
          );
        } else if (
          existingExtends &&
          (existingExtends === (entry.className || key).toLowerCase() ||
            existingExtends === name)
        ) {
          // Existing is already the child, keep it
          debugLog(
            `Manifest className '${name}': keeping child, ignoring parent '${key}'`,
          );
        } else {
          debugLog(
            `Manifest className collision for '${name}': keeping first, ignoring key '${key}'`,
          );
        }
      }
    }
    classNameIndexCache.set(manifest, index);
  }
  return index;
}

/**
 * Test-environment detection with optional DEBUG_TEST_ENV logging.
 *
 * Delegates to the single source of truth in `store.ts` so the
 * ManifestSource implementations (which also gate on test-env) cannot
 * drift from the legacy sync loader. The logging wrapper stays here
 * because the trace is specific to this module's loader state machine.
 */
function isTestEnvironment(): boolean {
  const result = isTestEnvFromStore();

  if (process.env.DEBUG_TEST_ENV) {
    logger.debug('[manifest-loader] isTestEnvironment check', {
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
      JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      result,
    });
  }

  return result;
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
 * Lazy-load smrt-core's internal test manifest only for smrt-core's own tests.
 * Consumer packages should never see these fixtures, or they can collide with
 * real external classes during downstream test runs.
 */
function getTestManifest(): SmartObjectManifest | null {
  if (!getTestManifestLoadAttempted()) {
    setTestManifestLoadAttempted(true);

    // CRITICAL: Scope the core test manifest to smrt-core's own test suite.
    if (!shouldLoadCoreTestManifest()) {
      if (process.env.DEBUG_TEST_ENV) {
        logger.debug(
          '[manifest-loader] ⚠️  Skipping core test manifest load (not smrt-core test environment)',
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
        logger.debug(
          `[manifest-loader] ✅ Loaded test manifest (${Object.keys(manifest?.objects || {}).length} objects)`,
        );
      }
    } catch (error) {
      if (process.env.DEBUG_TEST_ENV) {
        logger.debug(
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

  // Fallback location: src/manifest/test-manifest.json
  // This is still used by smrt-core and other packages that generate test manifests here
  const testManifestPath = join(
    process.cwd(),
    'src/manifest/test-manifest.json',
  );

  // If ManifestManager found a manifest, check if it has objects
  // If it has 0 objects but the fallback exists with objects, use the fallback instead
  // This handles the case where dist/manifest.json is the static-manifest.json (0 objects)
  // but src/manifest/test-manifest.json has the real test classes
  if (manifest) {
    const objectCount = Object.keys(manifest.objects).length;

    // If manifest has objects, use it
    if (objectCount > 0) {
      setLocalTestManifestCache(manifest);
      debugLog(
        `[manifest-loader] ✅ Loaded local manifest via ManifestManager (${objectCount} objects)`,
      );
      return manifest;
    }

    // Manifest has 0 objects - check if fallback has more
    if (existsSync(testManifestPath)) {
      try {
        const testManifest: Manifest = parse(
          readFileSync(testManifestPath, 'utf-8'),
        );
        const testObjectCount = Object.keys(testManifest.objects).length;

        if (testObjectCount > 0) {
          setLocalTestManifestCache(testManifest);
          debugLog(
            `[manifest-loader] ✅ Loaded test manifest from ${testManifestPath} (${testObjectCount} objects) - preferred over empty ManifestManager result`,
          );
          return testManifest;
        }
      } catch {
        // Fallback also failed, use the empty manifest
      }
    }

    // No better option, cache and use the empty manifest
    setLocalTestManifestCache(manifest);
    debugLog(
      `[manifest-loader] ✅ Loaded local manifest via ManifestManager (${objectCount} objects)`,
    );
    return manifest;
  }

  // ManifestManager returned null - check fallback
  if (existsSync(testManifestPath)) {
    try {
      const testManifest: Manifest = parse(
        readFileSync(testManifestPath, 'utf-8'),
      );
      setLocalTestManifestCache(testManifest);
      const objectCount = Object.keys(testManifest.objects).length;
      debugLog(
        `[manifest-loader] ✅ Loaded test manifest from ${testManifestPath} (${objectCount} objects)`,
      );
      return testManifest;
    } catch (error) {
      debugLog(
        `[manifest-loader] ✗ Failed to load test manifest from ${testManifestPath}: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  // No manifest found - DON'T cache null, allow retries
  // This is important because the manifest may be generated later
  debugLog(
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
  ctor: SmrtObjectConstructor,
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
    const packageMeta = (ctor as { __package__?: string }).__package__;
    if (packageMeta) {
      return packageMeta;
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
                  const pkg = parse<{ name?: string }>(
                    readFileSync(pkgPath, 'utf-8'),
                  );
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

interface ManifestExportConditions {
  default?: string;
  import?: string;
  require?: string;
}

interface ExternalPackageJson {
  exports?: Record<string, string | ManifestExportConditions>;
}

function findWorkspaceRoot(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    if (existsSync(join(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function resolveInstalledPackageJsonPath(packageName: string): string | null {
  let currentDir = process.cwd();

  while (true) {
    const packageJsonPath = join(
      currentDir,
      'node_modules',
      packageName,
      'package.json',
    );

    if (existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function resolveWorkspacePackageJsonPath(packageName: string): string | null {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  if (!workspaceRoot) {
    return null;
  }

  const workspacePackagesDir = join(workspaceRoot, 'packages');
  if (!existsSync(workspacePackagesDir)) {
    return null;
  }

  for (const packageDirName of readdirSync(workspacePackagesDir)) {
    const packageJsonPath = join(
      workspacePackagesDir,
      packageDirName,
      'package.json',
    );
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = parse<{ name?: string }>(
        readFileSync(packageJsonPath, 'utf-8'),
      );
      if (packageJson.name === packageName) {
        return packageJsonPath;
      }
    } catch {
      // Ignore unreadable workspace package metadata and continue scanning.
    }
  }

  return null;
}

function resolveWorkspaceSourceManifestPath(packageDir: string): string | null {
  const candidates = [
    join(packageDir, 'src', 'manifest', 'manifest.json'),
    join(packageDir, '.smrt', 'manifest.json'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

interface ManifestLoadOptions {
  warn?: boolean;
}

function resolveManifestExportPath(
  packageName: string,
  options: ManifestLoadOptions = {},
): string | null {
  const shouldWarn = options.warn ?? true;
  const packageJsonPath =
    resolveInstalledPackageJsonPath(packageName) ||
    resolveWorkspacePackageJsonPath(packageName);

  if (!packageJsonPath) {
    return null;
  }

  const packageDir = dirname(packageJsonPath);
  const packageJson = parse<ExternalPackageJson>(
    readFileSync(packageJsonPath, 'utf-8'),
  );
  const manifestExports = ['./manifest.json', './manifest'];

  for (const exportKey of manifestExports) {
    const manifestExport = packageJson.exports?.[exportKey];
    if (!manifestExport) {
      continue;
    }

    const manifestRelativePath =
      typeof manifestExport === 'string'
        ? manifestExport
        : manifestExport.import ||
          manifestExport.default ||
          manifestExport.require;

    if (!manifestRelativePath) {
      if (shouldWarn) {
        logger.warn(
          `Package ${packageName} has invalid manifest export configuration for ${exportKey}`,
        );
      }
      return null;
    }

    if (!manifestRelativePath.endsWith('.json')) {
      if (shouldWarn) {
        logger.warn(
          `Package ${packageName} must export a JSON manifest for ${exportKey}, received ${manifestRelativePath}`,
        );
      }
      return null;
    }

    const manifestPath = join(packageDir, manifestRelativePath);
    if (existsSync(manifestPath)) {
      return manifestPath;
    }

    const workspaceSourceManifest =
      resolveWorkspaceSourceManifestPath(packageDir);
    if (workspaceSourceManifest) {
      return workspaceSourceManifest;
    }

    if (shouldWarn) {
      logger.warn(
        `Package ${packageName} declares manifest export ${manifestRelativePath}, but no manifest file was found.`,
      );
    }
    return null;
  }

  return null;
}

function collectDeclaredSmrtDependencies(
  manifests: Array<Manifest | null | undefined>,
): string[] {
  const dependencies = new Set<string>();

  for (const manifest of manifests) {
    for (const pkg of manifest?.smrtDependencies || []) {
      dependencies.add(pkg);
    }
  }

  return Array.from(dependencies);
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
export function loadExternalManifestSync(
  packageName: string,
  options: ManifestLoadOptions = {},
): Manifest | null {
  // Check cache first
  if (getManifestCacheMap().has(packageName)) {
    debugLog(`[manifest-loader] Using cached manifest for ${packageName}`);
    return getManifestCacheMap().get(packageName)!;
  }

  debugLog(
    `[manifest-loader] Attempting to load external manifest for ${packageName}`,
  );

  const manifestPath = resolveManifestExportPath(packageName, options);

  if (!manifestPath) {
    debugLog(
      `[manifest-loader] Package ${packageName} does not expose a JSON manifest export`,
    );
    return null;
  }

  try {
    const manifest = parse<Manifest>(readFileSync(manifestPath, 'utf-8'));

    if (!manifest.objects || typeof manifest.objects !== 'object') {
      if (options.warn ?? true) {
        logger.warn(`Invalid manifest structure for package ${packageName}`);
      }
      return null;
    }

    const cachedManifest = manifest.packageName
      ? manifest
      : { ...manifest, packageName };

    getManifestCacheMap().set(packageName, cachedManifest);
    debugLog(
      `[manifest-loader] ✅ Loaded external manifest for ${packageName} (${Object.keys(cachedManifest.objects).length} objects)`,
    );

    return cachedManifest;
  } catch (error) {
    if (options.warn ?? true) {
      logger.warn(
        `Failed to load manifest for package ${packageName}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return null;
  }
}

export async function loadExternalManifest(
  packageName: string,
  options: ManifestLoadOptions = {},
): Promise<Manifest | null> {
  // Delegate to synchronous version since all operations are sync anyway
  return loadExternalManifestSync(packageName, options);
}

/**
 * Load a manifest directly from a known file path and cache it by package name.
 *
 * This is used by workspace/dev flows where sibling packages may not be
 * installed into node_modules yet, but their generated manifests are still
 * available on disk.
 */
export function loadManifestFromPathSync(
  manifestPath: string,
): Manifest | null {
  try {
    const manifestJson = readFileSync(manifestPath, 'utf-8');
    const manifest: Manifest = parse(manifestJson);

    if (!manifest.objects || typeof manifest.objects !== 'object') {
      logger.warn(`Invalid manifest structure at ${manifestPath}`);
      return null;
    }

    const cacheKey = manifest.packageName || manifestPath;
    getManifestCacheMap().set(cacheKey, manifest);
    debugLog(
      `[manifest-loader] ✅ Loaded manifest from path ${manifestPath} (${Object.keys(manifest.objects).length} objects)`,
    );

    return manifest;
  } catch (error) {
    logger.warn(
      `Failed to load manifest from path ${manifestPath}: ${error instanceof Error ? error.message : error}`,
    );
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
  debugLog(`[manifest-loader] discoverManifestSync called for: ${className}`);

  // Ensure test-env caches are seeded before the composite queries them.
  // Historically, steps 1-2 of discoverManifestSync did this inline. The
  // composite's TestManifestSource and LocalTestManifestSource read directly
  // from cache state — without this seeding the first sync lookup in a
  // clean test process would miss core test classes on their first access
  // (regression noted in #1138 review).
  if (isTestEnvironment()) {
    if (!getLocalTestManifestCache()) {
      loadLocalTestManifestSync();
    }
    if (!getTestManifestCache()) {
      getTestManifest();
    }
  }

  // Carry qualified-name / package context into the composite lookup so
  // multi-package same-simple-name scenarios (issue #951) resolve to the
  // right manifest even via the sync path.
  const query = isQualifiedName(className)
    ? (() => {
        const parsed = parseQualifiedName(className);
        return {
          className: parsed.className,
          packageName: parsed.packageName,
          qualifiedName: className,
        };
      })()
    : { className };

  // Steps 1-4 (local-test → test → static → embedded cache) now live in
  // CompositeManifestSource at the exact same priority order.
  const compositeHit = getDefaultCompositeSource().lookup(query);
  if (compositeHit) {
    debugLog(
      `[manifest-loader] ✅ Found ${className} via ${compositeHit.source} source`,
    );
    const entry = compositeHit.def;
    if (!entry.packageName && compositeHit.packageName) {
      return { ...entry, packageName: compositeHit.packageName };
    }
    return entry;
  }

  // 5. Try loading from explicitly declared external SMRT package dependencies.
  debugLog(
    `[manifest-loader] ${className} not found in cached manifests, trying external packages...`,
  );

  const pendingPackages = collectDeclaredSmrtDependencies([
    getLocalTestManifestCache(),
    isTestEnvironment() ? getTestManifest() : null,
    getStaticManifest(),
    ...getManifestCacheMap().values(),
  ]);

  if (pendingPackages.length === 0) {
    debugLog(
      '[manifest-loader] No SMRT dependencies discovered. Run manifest generation if external packages are expected.',
    );
  }

  const visitedPackages = new Set<string>();

  while (pendingPackages.length > 0) {
    const pkg = pendingPackages.shift();
    if (!pkg || visitedPackages.has(pkg)) {
      continue;
    }

    visitedPackages.add(pkg);
    const manifest = loadExternalManifestSync(pkg);
    if (!manifest) {
      continue;
    }

    for (const dependency of manifest.smrtDependencies || []) {
      if (!visitedPackages.has(dependency)) {
        pendingPackages.push(dependency);
      }
    }

    // Use lookupInManifest for qualified name support (Issue #713)
    const entry = lookupInManifest(manifest, className);
    if (entry) {
      debugLog(
        `[manifest-loader] ✅ Found ${className} in external package ${pkg}`,
      );
      // Enrich entry with packageName from manifest if not already present
      if (!entry.packageName && manifest.packageName) {
        return { ...entry, packageName: manifest.packageName };
      }
      return entry;
    }
  }

  debugLog(`[manifest-loader] ❌ ${className} not found in any manifest`);
  return undefined;
}

// Note: manifestCollisions is now accessed via globalThis helper function
// getManifestCollisionsMap()

/**
 * Look up a manifest entry in a manifest's objects map.
 * Supports both qualified names and simple class names.
 *
 * Lookup order:
 * 1. Direct qualified name lookup (e.g., "@happyvertical/smrt-core:Product")
 * 2. Constructed qualified name (packageName + className)
 * 3. Search by className property (case-insensitive)
 *
 * @param manifest - The manifest to search in
 * @param nameOrQualified - Either a qualified name or simple class name
 * @returns ManifestEntry or undefined if not found
 */
export function lookupInManifest(
  manifest: SmartObjectManifest,
  nameOrQualified: string,
): ManifestEntry | undefined {
  // 1. First try direct lookup (handles both qualified names and exact matches)
  if (manifest.objects[nameOrQualified]) {
    return manifest.objects[nameOrQualified];
  }

  // 2. Get the className index for O(1) lookups (instead of O(n) iteration)
  // This is the key optimization for issue #729
  const classNameIndex = getClassNameIndex(manifest);

  // 3. If input is a qualified name, extract className and use index
  if (isQualifiedName(nameOrQualified)) {
    const { className } = parseQualifiedName(nameOrQualified);
    return classNameIndex.get(className.toLowerCase());
  }

  // 4. For simple class names, try constructing qualified name if manifest has packageName
  if (manifest.packageName) {
    const qualifiedKey = createQualifiedName(
      manifest.packageName,
      nameOrQualified,
    );
    if (manifest.objects[qualifiedKey]) {
      return manifest.objects[qualifiedKey];
    }
  }

  // 5. Use index for O(1) className lookup (instead of O(n) iteration)
  return classNameIndex.get(nameOrQualified.toLowerCase());
}

/**
 * Find a manifest entry by qualified name across all loaded manifests.
 *
 * @param qualifiedName - The fully qualified class name (e.g., "@happyvertical/smrt-core:Product")
 * @returns ManifestEntry or undefined if not found
 */
export function findManifestEntryByQualifiedName(
  qualifiedName: string,
): ManifestEntry | undefined {
  if (!isQualifiedName(qualifiedName)) {
    return undefined;
  }

  const { packageName } = parseQualifiedName(qualifiedName);

  // Check if we have the package's manifest cached
  const manifest = getManifestCacheMap().get(packageName);
  if (manifest) {
    // Try qualified name first, then fallback to simple names
    return lookupInManifest(manifest, qualifiedName);
  }

  // Check static manifest
  const staticManifestData = getStaticManifest();
  if (staticManifestData.packageName === packageName) {
    return lookupInManifest(staticManifestData, qualifiedName);
  }

  // Check test manifest (if in test environment)
  if (isTestEnvironment()) {
    const testManifest = getTestManifest();
    if (testManifest?.packageName === packageName) {
      return lookupInManifest(testManifest, qualifiedName);
    }

    // Check local test manifest
    const localTest = getLocalTestManifestCache();
    if (localTest?.packageName === packageName) {
      return lookupInManifest(localTest, qualifiedName);
    }
  }

  return undefined;
}

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
  ctor: SmrtObjectConstructor,
  className: string,
): Promise<ManifestEntry | undefined> {
  // ✅ FAST PATH: O(1) constructor-based lookup for already-registered classes
  // Skip manifest scanning if we already know this constructor's qualified name via WeakMap
  // This provides instant resolution and prevents collisions (each constructor is unique in memory)
  if (!(ctor as { _isManifestStub?: boolean })._isManifestStub) {
    const registered = ObjectRegistry.getClassByConstructor(ctor);
    if (
      registered?.qualifiedName &&
      isQualifiedName(registered.qualifiedName)
    ) {
      // Parse package name from qualified name (format: "@package/name:ClassName")
      const { packageName } = parseQualifiedName(registered.qualifiedName);

      const cachedManifest = getManifestCacheMap().get(packageName);
      if (cachedManifest) {
        const cachedEntry = lookupInManifest(
          cachedManifest,
          registered.qualifiedName,
        );
        if (cachedEntry) {
          return !cachedEntry.packageName && cachedManifest.packageName
            ? { ...cachedEntry, packageName: cachedManifest.packageName }
            : cachedEntry;
        }
      }

      // Load the manifest for this specific package before trusting any
      // existing runtime field metadata. Imported external classes can be
      // registered with only a partial field set until their manifest is
      // hydrated, which is exactly what happens with STI parents like Event.
      const manifest = await loadExternalManifest(packageName, {
        warn: registered.fields.size === 0,
      });
      if (manifest) {
        // Look up the entry using the qualified name (exact match)
        const entry = lookupInManifest(manifest, registered.qualifiedName);
        if (entry) {
          // Enrich entry with package name if missing
          return !entry.packageName && manifest.packageName
            ? { ...entry, packageName: manifest.packageName }
            : entry;
        }
      }

      // Source-registered classes with explicit field metadata do not need a
      // second manifest probe from fallback discovery when the package did not
      // resolve to a manifest. This keeps workspace/dev runtimes from spamming
      // missing-dist-manifest warnings for packages that are already fully
      // usable from source.
      if (registered.fields.size > 0) {
        return undefined;
      }
    }
  }

  // FALLBACK: Original manifest scanning logic for:
  // - First-time registration (WeakMap not populated yet)
  // - Manifest stubs (not in WeakMap)
  // - Undecorated classes (never registered)
  const name = className.toLowerCase();
  const constructorPackage = getPackageName(ctor);

  // Track all manifest sources that define this class
  const foundEntries: Array<{
    entry: ManifestEntry;
    packageName: string;
    filePath?: string;
    manifestSource: string;
  }> = [];

  // Build qualified name for lookup if we have package context
  const qualifiedName = constructorPackage
    ? createQualifiedName(constructorPackage, className)
    : undefined;

  // 2. Check localTestManifest first (domain package test classes) - ONLY in test environment
  // Do this BEFORE loading external manifest to avoid duplicate loading
  let localEntry: SmartObjectDefinition | undefined;
  if (isTestEnvironment()) {
    if (getLocalTestManifestCache() === undefined) {
      loadLocalTestManifestSync();
    }
    const localManifest = getLocalTestManifestCache();
    if (localManifest) {
      // Use lookupInManifest for consistent qualified name handling
      localEntry = lookupInManifest(localManifest, qualifiedName || className);
      if (localEntry) {
        foundEntries.push({
          entry: localEntry,
          packageName: localManifest.packageName || 'local-test',
          filePath: localEntry.filePath,
          manifestSource: 'local test manifest',
        });
      }
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
        // Use lookupInManifest for consistent qualified name handling
        const entry = lookupInManifest(manifest, qualifiedName || className);
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
    if (manifest) {
      // Use lookupInManifest for consistent qualified name handling
      const testEntry = lookupInManifest(manifest, qualifiedName || className);
      if (testEntry) {
        foundEntries.push({
          entry: testEntry,
          packageName: manifest.packageName || '@happyvertical/smrt-core',
          filePath: testEntry.filePath,
          manifestSource: '@happyvertical/smrt-core test manifest',
        });
      }
    }
  }

  // 4. Check staticManifest (core framework classes)
  const staticManifestData = getStaticManifest();
  // Use lookupInManifest for consistent qualified name handling
  const staticEntry = lookupInManifest(
    staticManifestData,
    qualifiedName || className,
  );
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

    // Use lookupInManifest for consistent qualified name handling
    const entry = lookupInManifest(manifest, qualifiedName || className);
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

  // Deduplicate entries that reference the same source file.
  // Consumer manifests (e.g. smrt-users, dashboard) re-export classes from
  // upstream packages (e.g. smrt-profiles). These appear in multiple manifests
  // but point to the same filePath — they are NOT real collisions.
  if (foundEntries.length > 1) {
    const uniqueByFile = new Map<string, (typeof foundEntries)[0]>();
    for (const entry of foundEntries) {
      // Normalize file paths so the same source file with different absolute
      // prefixes (local dev vs CI build) is recognized as identical.
      // Extract the relative path from the last "packages/" segment onward.
      let key = entry.filePath || `${entry.packageName}:${className}`;
      if (entry.filePath) {
        const pkgIdx = entry.filePath.lastIndexOf('packages/');
        if (pkgIdx !== -1) {
          key = entry.filePath.slice(pkgIdx);
        }
      }
      if (!uniqueByFile.has(key)) {
        uniqueByFile.set(key, entry);
      }
    }

    if (uniqueByFile.size === 1) {
      // All entries point to the same source file — not a real collision.
      // Use the first (highest priority) entry.
      foundEntries.splice(1);
    } else if (uniqueByFile.size > 1) {
      // True collision: different source files define the same class name
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
  // Reset all cached manifest state so tests/dev tooling can force a full
  // rediscovery pass on the next lookup.
  setStaticManifestCache(undefined);
  setStaticManifestLoadAttempted(false);
  setTestManifestCache(undefined);
  setTestManifestLoadAttempted(false);
  setLocalTestManifestCache(undefined);
  getManifestCacheMap().clear();
  getManifestCollisionsMap().clear();
  getSTISiblingCache().clear();
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
 *
 * Known limitation (#1579, won't-fix): the per-collection result is cached on
 * `globalThis.__smrtSTISiblingCache` after the first call and is not invalidated
 * when a manifest is registered *afterwards* and isn't reachable via
 * `smrtDependencies` (the Release-A self-register path). A sibling registered
 * after first discovery for a given collection can therefore be missed until the
 * cache is cleared. Accepted as low-risk: STI manifests are registered at
 * startup before query traffic, and the few self-register flows that could hit
 * it can reset the cache. Fixing it properly means a registration→cache
 * invalidation hook, which is disproportionate to the exposure.
 */
export function discoverSTISiblingsSync(
  collection: string,
): Array<{ className: string; entry: ManifestEntry; packageName?: string }> {
  // Check cache first to avoid repeated scans (fixes #644)
  const cache = getSTISiblingCache();
  const cached = cache.get(collection);
  if (cached !== undefined) {
    return cached;
  }

  const siblings: Array<{
    className: string;
    entry: ManifestEntry;
    packageName?: string;
  }> = [];

  // Track already-found class names to avoid duplicates (case-insensitive)
  // Use lowercase keys to prevent both 'praeco' and 'Praeco' from being added
  const foundClasses = new Set<string>();

  debugLog(
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
        // Use case-insensitive check to prevent registering both 'praeco' and 'Praeco'
        const lowerClassName = className.toLowerCase();
        if (!foundClasses.has(lowerClassName)) {
          foundClasses.add(lowerClassName);
          siblings.push({
            className,
            entry,
            packageName: entry.packageName || manifest.packageName,
          });
          debugLog(
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
  const testManifestData = isTestEnvironment() ? getTestManifest() : null;
  if (testManifestData) {
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
  const pendingDependencies = collectDeclaredSmrtDependencies([
    getLocalTestManifestCache(),
    isTestEnvironment() ? testManifestData : null,
    staticManifestData,
    ...getManifestCacheMap().values(),
  ]);
  const visitedDependencies = new Set<string>();

  debugLog(
    `[manifest-loader] Scanning ${pendingDependencies.length} SMRT dependencies for STI siblings: ${pendingDependencies.join(', ')}`,
  );

  while (pendingDependencies.length > 0) {
    const pkg = pendingDependencies.shift();
    if (!pkg || visitedDependencies.has(pkg)) {
      continue;
    }

    visitedDependencies.add(pkg);

    const manifest = loadExternalManifestSync(pkg);
    if (manifest) {
      addFromManifest(manifest, `smrtDependency:${pkg}`);

      for (const dependency of manifest.smrtDependencies || []) {
        if (!visitedDependencies.has(dependency)) {
          pendingDependencies.push(dependency);
        }
      }
    }
  }

  debugLog(
    `[manifest-loader] discoverSTISiblingsSync found ${siblings.length} siblings for collection: ${collection}`,
  );

  // Cache the results for future calls (fixes #644)
  cache.set(collection, siblings);

  return siblings;
}
