/**
 * Leaf manifest storage + pure fs/URL helpers.
 *
 * This module has **no dependency on ObjectRegistry, registry.ts, or
 * class-registration.ts**. It owns the globalThis manifest caches and the
 * filesystem helpers that resolve and read manifest.json files from the
 * workspace, installed node_modules, and smrt-core's own bundle.
 *
 * Breaking the cycle: Before this module existed, `registry.ts` and
 * `manifest-loader.ts` both maintained their own copies of these helpers
 * (`registry.ts` had its own because `registerPackageManifest` needed them
 * and could not import `manifest-loader.ts` due to a module cycle —
 * `registry.ts → class-registration.ts → manifest-loader.ts → registry.ts`).
 * Centralizing them here lets both files import from a leaf, so the cycle
 * goes away and Release B's `ManifestSource` abstraction can live above
 * this leaf without re-creating it.
 *
 * @see https://github.com/happyvertical/smrt/issues/1133
 */

import { recordRegistryDiagnostic } from '../registry/diagnostics.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import type { ColumnDefinition } from '../schema/types.js';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from '../utils/qualified-names.js';

export type ManifestLoadOptions = {
  warn?: boolean;
};

// ── Runtime environment detection ────────────────────────────────────────

/**
 * Detect whether we're running inside a test runner. Test manifests must
 * never load in production to avoid test classes colliding with real ones.
 */
export function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST === 'true' ||
    process.env.JEST_WORKER_ID !== undefined
  );
}

/**
 * Best-effort detection of the current package under test.
 *
 * In workspace consumers, `process.cwd()` points at the consuming app/package,
 * while in smrt-core's own tests it points at `packages/core`. We use that
 * distinction to keep smrt-core's internal test manifest scoped to its own
 * test suite instead of leaking those fixtures into every consumer test run.
 */
export function getCurrentPackageName(): string | null {
  const explicitPackageName = process.env.npm_package_name;
  if (explicitPackageName) {
    return explicitPackageName;
  }

  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  let currentDir = process.cwd();

  while (true) {
    const packageJsonPath = builtins.path.join(currentDir, 'package.json');
    if (builtins.fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          builtins.fs.readFileSync(packageJsonPath, 'utf-8'),
        ) as { name?: string };
        return packageJson.name ?? null;
      } catch {
        return null;
      }
    }

    const parentDir = builtins.path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

/**
 * smrt-core's committed test manifest is for smrt-core's own tests only.
 * Consumer packages should expose only their local test manifest plus real
 * published manifests from dependencies.
 */
export function shouldLoadCoreTestManifest(): boolean {
  if (!isTestEnvironment()) {
    return false;
  }

  const explicitPackageName = process.env.npm_package_name;
  if (explicitPackageName) {
    return explicitPackageName === '@happyvertical/smrt-core';
  }

  const builtins = getNodeBuiltins();
  if (!builtins) {
    return false;
  }

  const moduleDir = builtins.path.dirname(
    builtins.url.fileURLToPath(import.meta.url),
  );
  const workspaceRoot = findWorkspaceRootSync(moduleDir);
  if (!workspaceRoot) {
    return false;
  }

  const corePackageJsonPath = builtins.path.join(
    workspaceRoot,
    'packages',
    'core',
    'package.json',
  );
  if (!builtins.fs.existsSync(corePackageJsonPath)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(
      builtins.fs.readFileSync(corePackageJsonPath, 'utf-8'),
    ) as { name?: string };
    if (packageJson.name !== '@happyvertical/smrt-core') {
      return false;
    }
  } catch {
    return false;
  }

  const relative = builtins.path.relative(workspaceRoot, process.cwd());
  return (
    relative === '' ||
    (!relative.startsWith('..') && !builtins.path.isAbsolute(relative))
  );
}

// ── Node builtins access ─────────────────────────────────────────────────

/**
 * Resolve Node's built-in `fs`/`path`/`url` modules without a static import.
 *
 * `process.getBuiltinModule()` is a Node 22+ API that returns the live
 * built-in without going through the module loader. This avoids Vite's
 * static-import analysis flagging these builtins and simulated
 * "externalized for browser" warnings in bundled browser builds.
 */
export function getNodeBuiltins() {
  const getBuiltinModule = (
    process as typeof process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    return null;
  }

  const fs = getBuiltinModule('node:fs') as
    | typeof import('node:fs')
    | undefined;
  const path = getBuiltinModule('node:path') as
    | typeof import('node:path')
    | undefined;
  const url = getBuiltinModule('node:url') as
    | typeof import('node:url')
    | undefined;

  if (!fs || !path || !url) {
    return null;
  }

  return { fs, path, url };
}

// ── globalThis cache accessors ───────────────────────────────────────────

type ManifestGlobals = typeof globalThis & {
  __smrtManifestStatic?: SmartObjectManifest | null;
  __smrtManifestStaticLoadAttempted?: boolean;
  __smrtManifestTest?: SmartObjectManifest | null;
  __smrtManifestLocalTest?: SmartObjectManifest | null;
  __smrtManifestCache?: Map<string, SmartObjectManifest>;
};

function getManifestGlobals(): ManifestGlobals {
  return globalThis as ManifestGlobals;
}

/**
 * Return the mutable external-manifest cache, creating it if absent.
 *
 * Writers: `registerPackageManifest()` (Release A, each package's shim),
 * `loadExternalManifestSyncWithNode()`, `loadManifestFromPathSyncWithNode()`.
 * Readers: all discovery paths.
 */
export function getManifestCache(): Map<string, SmartObjectManifest> {
  const globals = getManifestGlobals();
  if (!globals.__smrtManifestCache) {
    globals.__smrtManifestCache = new Map();
  }
  return globals.__smrtManifestCache;
}

/** Read-only snapshot of the static manifest, if cached. */
export function getStaticManifestCache(): SmartObjectManifest | null {
  return getManifestGlobals().__smrtManifestStatic ?? null;
}

/** Read-only snapshot of the core test manifest, if cached. */
export function getTestManifestCache(): SmartObjectManifest | null {
  return getManifestGlobals().__smrtManifestTest ?? null;
}

/**
 * Read-only snapshot of the local (domain package) test manifest.
 *
 * Preserves the three-state semantics that `discoverManifestEntry()` relies
 * on: `undefined` means "never attempted to load" and triggers the lazy
 * loader; `null` means "attempted but no local test manifest in this
 * package"; a manifest object means "loaded". Do not collapse `undefined`
 * to `null` here — the async-discovery lazy-load path keys off the
 * distinction (see manifest-loader.ts:`if (getLocalTestManifestCache() === undefined) loadLocalTestManifestSync()`).
 */
export function getLocalTestManifestCache():
  | SmartObjectManifest
  | null
  | undefined {
  return getManifestGlobals().__smrtManifestLocalTest;
}

// ── Manifest shape helpers ───────────────────────────────────────────────

export function createEmptyStaticManifest(): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: Date.now(),
    objects: {},
    packageName: '@happyvertical/smrt-core',
  };
}

/**
 * Deep-clone a manifest's schema column map so downstream mutators don't
 * corrupt the cached manifest. Foreign-key descriptors get their own copy
 * because manifest-loader.ts and registerFromManifest() both splice them
 * into live schema entries.
 */
export function cloneManifestSchemaColumns(
  columns: Record<string, unknown> | undefined,
): Record<string, ColumnDefinition> {
  return Object.fromEntries(
    Object.entries(columns || {}).map(([columnName, column]) => {
      const clonedColumn = {
        ...(column as ColumnDefinition & Record<string, unknown>),
      } as ColumnDefinition;

      if (clonedColumn.foreignKey) {
        clonedColumn.foreignKey = { ...clonedColumn.foreignKey };
      }

      return [columnName, clonedColumn];
    }),
  ) as Record<string, ColumnDefinition>;
}

/**
 * Look up a class definition inside a single manifest.
 *
 * Tries qualified-key, simple-name, and lowercase-name lookups, then falls
 * back to iterating every entry in the manifest comparing lowered names.
 * This is the low-level primitive used by every sync discovery path.
 */
export function lookupCachedManifestEntry(
  manifest: SmartObjectManifest | null | undefined,
  className: string,
): SmartObjectDefinition | undefined {
  if (!manifest?.objects) {
    return undefined;
  }

  const requestedQualifiedName = isQualifiedName(className)
    ? className
    : undefined;
  const requestedClassName = requestedQualifiedName
    ? parseQualifiedName(requestedQualifiedName).className
    : className;
  const lowerClassName = requestedClassName.toLowerCase();
  const packageName = manifest.packageName;
  const qualifiedKey =
    requestedQualifiedName ||
    (packageName
      ? createQualifiedName(packageName, requestedClassName)
      : undefined);

  return (
    (qualifiedKey ? manifest.objects[qualifiedKey] : undefined) ||
    manifest.objects[requestedClassName] ||
    manifest.objects[lowerClassName] ||
    Object.values(manifest.objects).find((entry) => {
      if (!entry) {
        return false;
      }

      if (entry.className?.toLowerCase() === lowerClassName) {
        return true;
      }

      return (
        requestedQualifiedName !== undefined &&
        packageName !== undefined &&
        createQualifiedName(packageName, entry.className || '') ===
          requestedQualifiedName
      );
    })
  );
}

// ── Filesystem helpers ───────────────────────────────────────────────────

export function findWorkspaceRootSync(startDir: string): string | null {
  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  let currentDir = startDir;

  while (true) {
    if (
      builtins.fs.existsSync(
        builtins.path.join(currentDir, 'pnpm-workspace.yaml'),
      )
    ) {
      return currentDir;
    }

    const parentDir = builtins.path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function resolveInstalledPackageJsonPathSync(
  packageName: string,
): string | null {
  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  let currentDir = process.cwd();

  while (true) {
    const packageJsonPath = builtins.path.join(
      currentDir,
      'node_modules',
      packageName,
      'package.json',
    );

    if (builtins.fs.existsSync(packageJsonPath)) {
      return packageJsonPath;
    }

    const parentDir = builtins.path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function resolveWorkspacePackageJsonPathSync(
  packageName: string,
): string | null {
  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  const workspaceRoot = findWorkspaceRootSync(process.cwd());
  if (!workspaceRoot) {
    return null;
  }

  const workspacePackagesDir = builtins.path.join(workspaceRoot, 'packages');
  if (!builtins.fs.existsSync(workspacePackagesDir)) {
    return null;
  }

  for (const packageDirName of builtins.fs.readdirSync(workspacePackagesDir)) {
    const packageJsonPath = builtins.path.join(
      workspacePackagesDir,
      packageDirName,
      'package.json',
    );
    if (!builtins.fs.existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(
        builtins.fs.readFileSync(packageJsonPath, 'utf-8'),
      ) as { name?: string };
      if (packageJson.name === packageName) {
        return packageJsonPath;
      }
    } catch {
      // Ignore unreadable workspace package metadata and continue scanning.
    }
  }

  return null;
}

export function resolveWorkspaceSourceManifestPathSync(
  packageDir: string,
): string | null {
  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  const candidates = [
    builtins.path.join(packageDir, 'src', 'manifest', 'manifest.json'),
    builtins.path.join(packageDir, '.smrt', 'manifest.json'),
  ];

  for (const candidate of candidates) {
    if (builtins.fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveManifestExportPathSync(
  packageName: string,
  options: ManifestLoadOptions = {},
): string | null {
  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  const shouldWarn = options.warn ?? true;
  const packageJsonPath =
    resolveInstalledPackageJsonPathSync(packageName) ||
    resolveWorkspacePackageJsonPathSync(packageName);

  if (!packageJsonPath) {
    return null;
  }

  const packageDir = builtins.path.dirname(packageJsonPath);
  const packageJson = JSON.parse(
    builtins.fs.readFileSync(packageJsonPath, 'utf-8'),
  ) as {
    exports?: Record<
      string,
      string | { default?: string; import?: string; require?: string }
    >;
  };
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
      recordRegistryDiagnostic(
        'error',
        'MANIFEST_EXPORT_INVALID',
        `Package ${packageName} has invalid manifest export configuration for ${exportKey}`,
        { packageName, exportKey },
      );
      if (shouldWarn) {
        console.warn(
          `Package ${packageName} has invalid manifest export configuration for ${exportKey}`,
        );
      }
      return null;
    }

    if (!manifestRelativePath.endsWith('.json')) {
      recordRegistryDiagnostic(
        'error',
        'MANIFEST_EXPORT_NOT_JSON',
        `Package ${packageName} must export a JSON manifest for ${exportKey}, received ${manifestRelativePath}`,
        { packageName, exportKey, manifestRelativePath },
      );
      if (shouldWarn) {
        console.warn(
          `Package ${packageName} must export a JSON manifest for ${exportKey}, received ${manifestRelativePath}`,
        );
      }
      return null;
    }

    const manifestPath = builtins.path.join(packageDir, manifestRelativePath);
    if (builtins.fs.existsSync(manifestPath)) {
      return manifestPath;
    }

    const workspaceSourceManifest =
      resolveWorkspaceSourceManifestPathSync(packageDir);
    if (workspaceSourceManifest) {
      return workspaceSourceManifest;
    }

    recordRegistryDiagnostic(
      'error',
      'MANIFEST_EXPORT_NOT_FOUND',
      `Package ${packageName} declares manifest export ${manifestRelativePath}, but no manifest file was found.`,
      { packageName, exportKey, manifestRelativePath },
    );
    if (shouldWarn) {
      console.warn(
        `Package ${packageName} declares manifest export ${manifestRelativePath}, but no manifest file was found.`,
      );
    }
    return null;
  }

  return null;
}

// ── Manifest reading (seeds caches) ──────────────────────────────────────

/**
 * Load smrt-core's own bundled manifest from disk, caching in
 * `__smrtManifestStatic`. Resolves against this module's own `import.meta.url`
 * so paths work whether the code is running from `dist/` or `src/`.
 */
export function loadStaticManifestSyncWithNode(): SmartObjectManifest | null {
  const globals = getManifestGlobals();

  if (globals.__smrtManifestStatic !== undefined) {
    return globals.__smrtManifestStatic ?? null;
  }

  const builtins = getNodeBuiltins();
  globals.__smrtManifestStaticLoadAttempted = true;
  if (!builtins) {
    const fallbackManifest = createEmptyStaticManifest();
    globals.__smrtManifestStatic = fallbackManifest;
    return fallbackManifest;
  }

  // store.ts lives at src/manifest/store.ts (source) → dist/manifest/store.js
  // (compiled). In src, the static manifest is a sibling JSON; in dist, it is
  // the package's dist/manifest.json one level up.
  const candidates = import.meta.url.endsWith('.ts')
    ? [
        new URL('./static-manifest.json', import.meta.url),
        new URL('../../dist/manifest.json', import.meta.url),
      ]
    : [new URL('../manifest.json', import.meta.url)];

  for (const candidate of candidates) {
    try {
      if (!builtins.fs.existsSync(candidate)) {
        continue;
      }

      const manifest = JSON.parse(
        builtins.fs.readFileSync(candidate, 'utf-8'),
      ) as SmartObjectManifest;

      if (!manifest.objects || typeof manifest.objects !== 'object') {
        continue;
      }

      const cachedManifest = manifest.packageName
        ? manifest
        : { ...manifest, packageName: '@happyvertical/smrt-core' };
      globals.__smrtManifestStatic = cachedManifest;
      return cachedManifest;
    } catch {
      // Try the next candidate and fall back to the empty manifest if needed.
    }
  }

  const fallbackManifest = createEmptyStaticManifest();
  globals.__smrtManifestStatic = fallbackManifest;
  return fallbackManifest;
}

/**
 * Load a package's published manifest by package name, caching in
 * `__smrtManifestCache` under the package key. Returns null on miss or
 * invalid shape; records a diagnostic instead of throwing.
 */
export function loadExternalManifestSyncWithNode(
  packageName: string,
  options: ManifestLoadOptions = {},
): SmartObjectManifest | null {
  const cache = getManifestCache();

  if (cache.has(packageName)) {
    return cache.get(packageName) || null;
  }

  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  const manifestPath = resolveManifestExportPathSync(packageName, options);
  if (!manifestPath) {
    return null;
  }

  try {
    const manifest = JSON.parse(
      builtins.fs.readFileSync(manifestPath, 'utf-8'),
    ) as SmartObjectManifest;

    if (!manifest.objects || typeof manifest.objects !== 'object') {
      if (options.warn ?? true) {
        console.warn(`Invalid manifest structure for package ${packageName}`);
      }
      return null;
    }

    const cachedManifest = manifest.packageName
      ? manifest
      : { ...manifest, packageName };

    cache.set(packageName, cachedManifest);

    return cachedManifest;
  } catch (error) {
    if (options.warn ?? true) {
      console.warn(
        `Failed to load manifest for package ${packageName}: ${error instanceof Error ? error.message : error}`,
      );
    }
    return null;
  }
}

/**
 * Load a manifest from an explicit filesystem path, caching in
 * `__smrtManifestCache` under the manifest's packageName (or the path as a
 * fallback key). Used by `loadAllManifests({ manifestPaths })` in registry.ts
 * and by the Release B `ExplicitPathsManifestSource`.
 */
export function loadManifestFromPathSyncWithNode(
  manifestPath: string,
): SmartObjectManifest | null {
  const builtins = getNodeBuiltins();
  if (!builtins) {
    return null;
  }

  try {
    const manifest = JSON.parse(
      builtins.fs.readFileSync(manifestPath, 'utf-8'),
    ) as SmartObjectManifest;

    if (!manifest.objects || typeof manifest.objects !== 'object') {
      console.warn(`Invalid manifest structure at ${manifestPath}`);
      return null;
    }

    getManifestCache().set(manifest.packageName || manifestPath, manifest);

    return manifest;
  } catch (error) {
    console.warn(
      `Failed to load manifest from path ${manifestPath}: ${error instanceof Error ? error.message : error}`,
    );
    return null;
  }
}

/**
 * Synchronous lookup across every cached manifest source, in priority order.
 *
 * Matches the historical order from manifest-loader.ts and registry.ts:
 * local test → core test → static (smrt-core bundled) → external cache.
 * The Release B `CompositeManifestSource` wraps the same priority behind a
 * higher-level abstraction.
 */
export function discoverCachedManifestSync(
  className: string,
): SmartObjectDefinition | undefined {
  const manifests: Array<SmartObjectManifest | null | undefined> = [
    getLocalTestManifestCache(),
    getTestManifestCache(),
    loadStaticManifestSyncWithNode(),
    ...getManifestCache().values(),
  ];

  for (const manifest of manifests) {
    const entry = lookupCachedManifestEntry(manifest, className);
    if (entry) {
      return entry;
    }
  }

  return undefined;
}
