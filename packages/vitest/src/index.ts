/**
 * SMRT Vitest Plugin
 *
 * Automatically loads manifests from SMRT peer dependencies before tests run.
 * This solves Issue #583 where cross-package integration tests fail because
 * external package classes aren't registered in the test manifest.
 *
 * Uses ManifestManager for unified manifest loading, which properly handles
 * the manifest priority order: .smrt/manifest.json (test) -> dist/manifest.json (production)
 *
 * @example
 * ```typescript
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 * import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
 *
 * export default defineConfig({
 *   plugins: [smrtVitestPlugin()],
 *   test: {
 *     globals: true,
 *     environment: 'node',
 *   },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';

/**
 * Configuration options for {@link smrtVitestPlugin} and
 * {@link setupSmrtManifests}.
 *
 * All fields are optional — the defaults work for the typical single-package
 * SMRT project.  Override them when you need to tune manifest generation,
 * add extra packages, or adjust the scan scope.
 */
export interface SmrtVitestPluginOptions {
  /**
   * Extra `@happyvertical/smrt-*` package names whose manifests should be
   * loaded in addition to those discovered automatically from `package.json`.
   *
   * Useful when a dependency is not listed in `dependencies`,
   * `peerDependencies`, or `devDependencies` but still needs its classes
   * registered (e.g., a dynamically loaded plugin).
   *
   * @default [] — only auto-discovered packages are loaded
   */
  packages?: string[];

  /**
   * Emit diagnostic log lines for each manifest discovered, loaded, or
   * skipped.  Helpful when debugging "No field metadata found" errors.
   *
   * @default false
   */
  verbose?: boolean;

  /**
   * Project root used to locate `package.json` and to resolve relative
   * manifest paths.
   *
   * @default process.cwd()
   */
  root?: string;

  /**
   * Automatically generate the local manifest at vitest startup using
   * `ManifestBuilder`.  When `true`, there is no need to run
   * `smrt generate:test` or `smrt test` before running vitest.
   *
   * The manifest is generated **once** at startup and cached for the session.
   * In watch mode, restart vitest after adding new `@smrt()` classes or
   * fields to pick up the changes.
   *
   * @default true
   */
  generateManifest?: boolean;

  /**
   * Glob patterns that determine which source files are scanned for SMRT
   * classes when `generateManifest` is `true`.
   *
   * @default ['src/**\/*.ts']
   */
  include?: string[];

  /**
   * Glob patterns excluded from the manifest scan.
   *
   * @default ['**\/*.d.ts', '**\/node_modules/**', '**\/dist/**']
   */
  exclude?: string[];

  /**
   * Override the setup file injected into Vitest projects.
   *
   * Defaults to the published package entry. Workspace packages can point this
   * at a local source file while still using the same plugin API.
   */
  setupFile?: string;
}

function resolveDefaultSetupFile(): string {
  const sourceSetupPath = fileURLToPath(new URL('./setup.ts', import.meta.url));
  if (existsSync(sourceSetupPath)) {
    return sourceSetupPath;
  }

  const distSetupPath = fileURLToPath(new URL('./setup.js', import.meta.url));
  if (existsSync(distSetupPath)) {
    return distSetupPath;
  }

  return '@happyvertical/smrt-vitest/setup';
}

type ViteAliasEntry = {
  find: string;
  replacement: string;
};

function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getWorkspaceSourceTsconfigPath(
  startDir = process.cwd(),
): string | null {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) {
    return null;
  }

  const tsconfigPath = join(workspaceRoot, 'tsconfig.package-build.json');
  return existsSync(tsconfigPath) ? tsconfigPath : null;
}

async function importWorkspaceSourceModule<T>(href: string): Promise<T> {
  const { register } = await import('tsx/esm/api');
  const tsconfigPath = getWorkspaceSourceTsconfigPath();
  const unregister = register(
    tsconfigPath ? { tsconfig: tsconfigPath } : undefined,
  );

  try {
    return (await import(href)) as T;
  } finally {
    await unregister();
  }
}

function readWorkspacePackageRoots(root: string): Map<string, string> {
  const workspaceRoot = findWorkspaceRoot(root);
  if (!workspaceRoot) {
    return new Map();
  }

  const packagesDir = join(workspaceRoot, 'packages');
  if (!existsSync(packagesDir)) {
    return new Map();
  }

  const packageRoots = new Map<string, string>();

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = join(packagesDir, entry.name);
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (typeof packageJson.name === 'string') {
        packageRoots.set(packageJson.name, packageRoot);
      }
    } catch {
      // Ignore invalid package manifests in the workspace scan.
    }
  }

  return packageRoots;
}

function addAliasIfPresent(
  aliases: ViteAliasEntry[],
  find: string,
  replacement: string,
): void {
  if (
    aliases.some((entry) => entry.find === find) ||
    !existsSync(replacement)
  ) {
    return;
  }

  if (existsSync(replacement)) {
    aliases.push({ find, replacement });
  }
}

export function getWorkspaceViteAliases(
  root = process.cwd(),
): ViteAliasEntry[] {
  const packageRoots = readWorkspacePackageRoots(root);
  const aliases: ViteAliasEntry[] = [];

  for (const [packageName, packageRoot] of packageRoots.entries()) {
    addAliasIfPresent(aliases, packageName, join(packageRoot, 'src/index.ts'));
    addAliasIfPresent(
      aliases,
      `${packageName}/svelte`,
      join(packageRoot, 'src/svelte/index.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/sveltekit`,
      join(packageRoot, 'src/sveltekit/index.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/ui`,
      join(packageRoot, 'src/ui.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/routes`,
      join(packageRoot, 'src/route-module.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/playground`,
      join(packageRoot, 'src/playground.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/playground`,
      join(packageRoot, 'src/svelte/playground.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/manifest`,
      join(packageRoot, 'src/manifest/index.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/manifest.json`,
      join(packageRoot, 'src/manifest/manifest.json'),
    );

    if (packageName === '@happyvertical/smrt-core') {
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/testing',
        join(packageRoot, 'src/testing.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/scanner',
        join(packageRoot, 'src/scanner/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/vite-plugin',
        join(packageRoot, 'src/vite-plugin/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/vite-plugin',
        join(packageRoot, 'src/vite-plugin.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/consumer-plugin',
        join(packageRoot, 'src/consumer-plugin/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/consumer-plugin',
        join(packageRoot, 'src/consumer-plugin.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/manifest',
        join(packageRoot, 'src/manifest/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/manifest/discover-base-classes',
        join(packageRoot, 'src/manifest/discover-base-classes.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/schema/utils',
        join(packageRoot, 'src/schema/utils.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/utils',
        join(packageRoot, 'src/utils.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/utils/import-workspace-module',
        join(packageRoot, 'src/utils/import-workspace-module.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/migrations',
        join(packageRoot, 'src/migrations.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/runtime',
        join(packageRoot, 'src/runtime.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/registry',
        join(packageRoot, 'src/registry.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators',
        join(packageRoot, 'src/generators.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators/cli',
        join(packageRoot, 'src/generators/cli.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators/mcp',
        join(packageRoot, 'src/generators/mcp.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators/rest',
        join(packageRoot, 'src/generators/rest.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/prebuild',
        join(packageRoot, 'src/prebuild.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/decorators',
        join(packageRoot, 'src/decorators/index.ts'),
      );
    }

    if (packageName === '@happyvertical/smrt-vitest') {
      // Shared Svelte component-test harness (S11 #1416). Flat `src/*.ts` files,
      // so the generic `/svelte` → `src/svelte/index.ts` convention misses them;
      // map the exact subpaths. The length-desc sort below makes these win over
      // the bare-package root alias.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-vitest/svelte',
        join(packageRoot, 'src/svelte.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-vitest/svelte-setup',
        join(packageRoot, 'src/svelte-setup.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-vitest/a11y',
        join(packageRoot, 'src/a11y.ts'),
      );
    }

    if (packageName === '@happyvertical/smrt-svelte') {
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/layout',
        join(packageRoot, 'src/components/layout/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/registry',
        join(packageRoot, 'src/registry/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/ui',
        join(packageRoot, 'src/components/ui/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/feedback',
        join(packageRoot, 'src/components/feedback/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/themes',
        join(packageRoot, 'src/themes/index.ts'),
      );
    }
  }

  return aliases.sort((left, right) => right.find.length - left.find.length);
}

function normalizeAliasEntries(
  alias: unknown,
): Array<{ find: string | RegExp; replacement: string }> {
  if (Array.isArray(alias)) {
    return alias.filter(
      (entry): entry is { find: string | RegExp; replacement: string } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        'find' in entry &&
        'replacement' in entry,
    );
  }

  if (alias && typeof alias === 'object') {
    return Object.entries(alias).map(([find, replacement]) => ({
      find,
      replacement: String(replacement),
    }));
  }

  return [];
}

/**
 * Discover SMRT packages from package.json dependencies
 */
function discoverSmrtPackages(
  root: string,
  additionalPackages: string[] = [],
): string[] {
  const packageJsonPath = join(root, 'package.json');

  if (!existsSync(packageJsonPath)) {
    console.warn('[smrt-vitest] No package.json found at', root);
    return additionalPackages;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.peerDependencies,
      ...packageJson.devDependencies,
    };

    // Find all @happyvertical/smrt-* packages (except smrt-vitest itself)
    const smrtPackages = Object.keys(allDeps).filter(
      (pkg) =>
        pkg.startsWith('@happyvertical/smrt-') &&
        pkg !== '@happyvertical/smrt-vitest',
    );

    // Combine with additional packages, removing duplicates
    const allPackages = [...new Set([...smrtPackages, ...additionalPackages])];

    return allPackages;
  } catch (error) {
    console.error('[smrt-vitest] Failed to read package.json:', error);
    return additionalPackages;
  }
}

/**
 * Find the root directory of a package
 * Tries require.resolve first, then falls back to node_modules lookup
 */
function findPackageRoot(packageName: string): string | null {
  const require = createRequire(`${process.cwd()}/package.json`);

  // Method 1: Try require.resolve to find package entry, then walk up to package.json
  try {
    const pkgMainPath = require.resolve(packageName);
    let dir = dirname(pkgMainPath);

    for (let i = 0; i < 10; i++) {
      const pkgJsonPath = join(dir, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const content = readFileSync(pkgJsonPath, 'utf-8');
          const json = JSON.parse(content);
          if (json.name === packageName) {
            return dir;
          }
        } catch {
          // Keep walking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to Method 2
  }

  // Method 2: Direct node_modules lookup (for file: protocol linked packages)
  const nodeModulesPath = join(process.cwd(), 'node_modules', packageName);
  const pkgJsonPath = join(nodeModulesPath, 'package.json');

  if (existsSync(pkgJsonPath)) {
    try {
      const content = readFileSync(pkgJsonPath, 'utf-8');
      const json = JSON.parse(content);
      if (json.name === packageName) {
        return nodeModulesPath;
      }
    } catch {
      // Fall through
    }
  }

  // Method 3: Workspace package (sibling in monorepo)
  const packageShortName = packageName.split('/').pop() || '';
  const packageWithoutScope = packageShortName.replace(/^smrt-/, '');

  const workspacePaths = [
    join(process.cwd(), '..', packageWithoutScope),
    join(process.cwd(), '..', packageShortName),
  ];

  for (const workspacePath of workspacePaths) {
    const workspacePkgPath = join(workspacePath, 'package.json');
    if (existsSync(workspacePkgPath)) {
      try {
        const content = readFileSync(workspacePkgPath, 'utf-8');
        const json = JSON.parse(content);
        if (json.name === packageName) {
          return workspacePath;
        }
      } catch {
        // Keep trying
      }
    }
  }

  return null;
}

async function importSmrtCoreModule(): Promise<
  typeof import('@happyvertical/smrt-core')
> {
  const specifier = '@happyvertical/smrt-core';

  try {
    return await import(specifier);
  } catch {
    const fallbackHref = new URL('../../core/src/index.ts', import.meta.url)
      .href;
    return await importWorkspaceSourceModule(fallbackHref);
  }
}

async function importSmrtCoreManifestModule(): Promise<
  typeof import('@happyvertical/smrt-core/manifest')
> {
  const specifier = '@happyvertical/smrt-core/manifest';

  try {
    return await import(specifier);
  } catch {
    const fallbackHref = new URL(
      '../../core/src/manifest/index.ts',
      import.meta.url,
    ).href;
    return await importWorkspaceSourceModule(fallbackHref);
  }
}

async function importDiscoverBaseClassesModule(): Promise<
  typeof import('@happyvertical/smrt-core/manifest/discover-base-classes')
> {
  const specifier = '@happyvertical/smrt-core/manifest/discover-base-classes';

  try {
    return await import(specifier);
  } catch {
    const fallbackHref = new URL(
      '../../core/src/manifest/discover-base-classes.ts',
      import.meta.url,
    ).href;
    return await importWorkspaceSourceModule(fallbackHref);
  }
}

/**
 * Load manifest from a package using ManifestManager
 *
 * This properly handles the manifest priority order:
 * 1. .smrt/manifest.json (test/dev manifest with all classes)
 * 2. dist/manifest.json (production manifest)
 */
async function loadAndRegisterManifest(
  packageName: string,
  verbose: boolean,
): Promise<boolean> {
  try {
    const { ObjectRegistry } = await importSmrtCoreModule();
    const { ManifestManager } = await importSmrtCoreManifestModule();

    // Find the package root directory
    const packageRoot = findPackageRoot(packageName);
    if (!packageRoot) {
      if (verbose) {
        console.log(
          `[smrt-vitest] Could not find package root for ${packageName}`,
        );
      }
      return false;
    }

    // Use ManifestManager to load manifest with proper priority
    // (.smrt/manifest.json -> dist/manifest.json)
    const manager = new ManifestManager(packageRoot);
    const manifest = manager.loadLocal();

    if (!manifest) {
      if (verbose) {
        console.log(`[smrt-vitest] No manifest found for ${packageName}`);
      }
      return false;
    }

    const registered = registerManifestObjects(
      ObjectRegistry,
      manifest,
      manifest.packageName || packageName,
    );

    if (verbose || registered > 0) {
      console.log(
        `[smrt-vitest] Loaded ${registered} classes from ${packageName}`,
      );
    }

    return true;
  } catch (error) {
    if (verbose) {
      console.error(
        `[smrt-vitest] Failed to load manifest from ${packageName}:`,
        error,
      );
    }
    return false;
  }
}

function registerManifestObjects(
  ObjectRegistry: {
    hasClass(name: string): boolean;
    registerFromManifest(
      name: string,
      objectDef: unknown,
      packageName?: string,
    ): void;
  },
  manifest: { objects?: Record<string, unknown>; packageName?: string } | null,
  packageName?: string,
): number {
  if (!manifest?.objects) {
    return 0;
  }

  let registered = 0;
  for (const [name, objectDef] of Object.entries(manifest.objects)) {
    if (!ObjectRegistry.hasClass(name)) {
      ObjectRegistry.registerFromManifest(name, objectDef, packageName);
      registered++;
    }
  }

  return registered;
}

async function loadAndRegisterLocalManifest(
  root: string,
  verbose: boolean,
): Promise<boolean> {
  try {
    const { ObjectRegistry } = await importSmrtCoreModule();
    const { ManifestManager } = await importSmrtCoreManifestModule();

    const manager = new ManifestManager(root);
    const manifest = manager.loadLocal();

    if (!manifest) {
      if (verbose) {
        console.log('[smrt-vitest] No local manifest found');
      }
      return false;
    }

    const registered = registerManifestObjects(
      ObjectRegistry,
      manifest,
      manifest.packageName,
    );

    if (verbose || registered > 0) {
      console.log(
        `[smrt-vitest] Loaded ${registered} classes from local manifest`,
      );
    }

    return true;
  } catch (error) {
    if (verbose) {
      console.error('[smrt-vitest] Failed to load local manifest:', error);
    }
    return false;
  }
}

/**
 * Generate local manifest using ManifestBuilder
 *
 * This ensures the manifest is always fresh after adding new classes/fields.
 * The ~1-2s overhead is minimal compared to test execution time.
 */
async function generateLocalManifest(
  _root: string,
  options: SmrtVitestPluginOptions,
  verbose: boolean,
): Promise<boolean> {
  try {
    console.log('[smrt-vitest] Generating test manifest...');

    const { ManifestBuilder } = await importSmrtCoreManifestModule();
    const { discoverBaseClasses } = await importDiscoverBaseClassesModule();

    // Discover base classes from external SMRT packages
    const baseClasses = await discoverBaseClasses();

    if (verbose) {
      console.log(
        `[smrt-vitest] Discovered ${baseClasses.length} base classes (including ${baseClasses.length - 3} from external packages)`,
      );
    }

    const builder = new ManifestBuilder();
    const manifest = await builder.generate({
      // File discovery
      include: options.include || ['src/**/*.ts'],
      exclude: options.exclude || [
        '**/*.d.ts',
        '**/node_modules/**',
        '**/dist/**',
      ],

      // Scanner configuration
      baseClasses,
      followImports: true,
      loadViteConfig: true,
      discoverExternalPackages: true,
      includeExternalBaseClasses: true,
      includePrivateMethods: false,
      includeStaticMethods: true,

      // Output configuration - write to .smrt directory (ManifestManager default)
      outputDir: '.smrt',
      outputName: 'manifest.json',
      generateTypeStub: false,

      // Metadata
      injectPackageInfo: true,
      moduleType: 'smrt',
    });

    const objectCount = Object.keys(manifest.objects).length;
    console.log(
      `[smrt-vitest] ✓ Generated manifest with ${objectCount} object(s)`,
    );

    return true;
  } catch (error) {
    console.error('[smrt-vitest] Failed to generate manifest:', error);
    return false;
  }
}

/**
 * Create the SMRT Vitest plugin
 *
 * This plugin automatically generates and loads manifests before tests run,
 * enabling cross-package integration tests without needing to run `smrt test` first.
 *
 * @param options - Plugin configuration options
 * @returns Vitest plugin
 *
 * @example Basic usage
 * ```typescript
 * import { defineConfig } from 'vitest/config';
 * import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
 *
 * export default defineConfig({
 *   plugins: [smrtVitestPlugin()],
 * });
 * ```
 *
 * @example With additional packages
 * ```typescript
 * import { defineConfig } from 'vitest/config';
 * import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
 *
 * export default defineConfig({
 *   plugins: [
 *     smrtVitestPlugin({
 *       packages: ['@my-org/custom-smrt-package'],
 *       verbose: true,
 *     }),
 *   ],
 * });
 * ```
 *
 * @example Disable auto-generation (use pre-built manifest)
 * ```typescript
 * export default defineConfig({
 *   plugins: [
 *     smrtVitestPlugin({
 *       generateManifest: false, // Use existing manifest only
 *     }),
 *   ],
 * });
 * ```
 */
/**
 * Resolve the per-test retry count injected into the vitest config.
 *
 * `SMRT_VITEST_RETRY` (when set to a non-negative integer) wins; otherwise the
 * default is 2 retries in CI (`process.env.CI`) and 0 everywhere else, so local
 * runs surface flaky tests immediately while the shared cross-package CI job
 * tolerates rare transient timing flakes.
 */
function resolveCiRetry(): number {
  const override = process.env.SMRT_VITEST_RETRY;
  if (override != null && override !== '') {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return process.env.CI ? 2 : 0;
}

export function smrtVitestPlugin(
  options: SmrtVitestPluginOptions = {},
): Plugin {
  const {
    packages = [],
    verbose = false,
    root = process.cwd(),
    generateManifest = true,
    setupFile = resolveDefaultSetupFile(),
  } = options;

  let manifestsLoaded = false;
  const setupFileId = setupFile;
  const workspaceAliases = getWorkspaceViteAliases(root);

  const ensureSetupFiles = (value: string | string[] | undefined): string[] => {
    const setupFiles = Array.isArray(value) ? [...value] : value ? [value] : [];

    if (!setupFiles.includes(setupFileId)) {
      setupFiles.push(setupFileId);
    }

    return setupFiles;
  };

  const applySetupFilesToProjects = (projects: unknown[] | undefined): void => {
    projects?.forEach((project) => {
      if (!project || typeof project !== 'object' || !('test' in project)) {
        return;
      }

      const projectConfig = project as Record<string, unknown> & {
        test?: { setupFiles?: string | string[] };
      };

      projectConfig.test = {
        ...projectConfig.test,
        setupFiles: ensureSetupFiles(projectConfig.test?.setupFiles),
      };
    });
  };

  return {
    name: 'smrt-vitest',

    config(userConfig) {
      applySetupFilesToProjects(userConfig.test?.projects);
      const setupFiles = ensureSetupFiles(userConfig.test?.setupFiles);
      const resolveConfig =
        userConfig.resolve && typeof userConfig.resolve === 'object'
          ? (userConfig.resolve as { alias?: unknown })
          : undefined;
      const alias = normalizeAliasEntries(resolveConfig?.alias);

      return {
        resolve: {
          alias: [...workspaceAliases, ...alias],
        },
        test: {
          setupFiles,
          // Re-run a failed test before failing the run, in CI only. Several
          // packages have rare, CI-environment-specific timing flakes that pass
          // on re-run (observed: every flaky "Test Packages" failure went green
          // on rerun, on a different package each time, none reproducible
          // locally). Retry keeps the shared cross-package CI job reliable
          // WITHOUT masking real failures — a deterministic failure still fails
          // all attempts, and vitest reports retried tests as "flaky" so they
          // stay visible. Local runs keep retry at 0 so flakes surface during
          // development. Override with SMRT_VITEST_RETRY=<n>.
          retry: resolveCiRetry(),
        },
      };
    },

    // Run during config resolution to ensure manifests are loaded before tests
    async configResolved() {
      if (manifestsLoaded) return;

      // Step 1: Generate local manifest if enabled (default: true)
      // This ensures manifest is always fresh after adding new classes/fields
      if (generateManifest) {
        await generateLocalManifest(root, options, verbose);
      }

      // Step 2: Load the local manifest so late-imported local classes are
      // available to schema preparation before the first DB call.
      await loadAndRegisterLocalManifest(root, verbose);

      // Step 3: Discover and load manifests from SMRT peer dependencies
      const smrtPackages = discoverSmrtPackages(root, packages);

      if (smrtPackages.length === 0) {
        if (verbose) {
          console.log('[smrt-vitest] No SMRT packages found to load');
        }
      } else {
        if (verbose) {
          console.log(
            `[smrt-vitest] Discovered ${smrtPackages.length} SMRT packages:`,
            smrtPackages,
          );
        }

        // Load manifests from all discovered packages
        const results = await Promise.all(
          smrtPackages.map((pkg) => loadAndRegisterManifest(pkg, verbose)),
        );

        const successCount = results.filter(Boolean).length;
        console.log(
          `[smrt-vitest] Loaded manifests from ${successCount}/${smrtPackages.length} packages`,
        );
      }

      // Step 4: Validate local manifest is loaded
      try {
        const { ManifestManager } = await importSmrtCoreManifestModule();
        const manager = new ManifestManager(root);
        const localManifest = manager.loadLocal();

        if (localManifest) {
          console.log(
            `[smrt-vitest] ✓ Local manifest: ${Object.keys(localManifest.objects).length} objects`,
          );
        } else if (!generateManifest) {
          // Only show warning if auto-generation is disabled
          // (if enabled and still missing, generateLocalManifest already logged an error)
          const devPath = manager.getOutputPath('dev');
          const buildPath = manager.getOutputPath('build');

          console.warn(`
╔═══════════════════════════════════════════════════════════════════════╗
║  [smrt-vitest] WARNING: No local manifest found                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Tests may fail with "No field metadata found" errors.                ║
║                                                                       ║
║  Checked locations:                                                   ║
║    • ${devPath.padEnd(55)}║
║    • ${buildPath.padEnd(55)}║
║                                                                       ║
║  To fix, either:                                                      ║
║    • Enable generateManifest: true in plugin options (default)        ║
║    • Run: smrt generate:test                                          ║
║    • Run: npm run build (if manifest is part of build)                ║
╚═══════════════════════════════════════════════════════════════════════╝
          `);
        }
      } catch (error) {
        if (verbose) {
          console.warn(
            '[smrt-vitest] Could not validate local manifest:',
            error,
          );
        }
      }

      manifestsLoaded = true;
    },
  };
}

/**
 * Discover and register SMRT manifests from peer dependencies.
 *
 * An imperative alternative to {@link smrtVitestPlugin} for environments
 * where a Vite plugin is not available (e.g., a plain `globalSetup` file or
 * a custom test runner bootstrap).
 *
 * The function reads `package.json` in the working directory, finds all
 * `@happyvertical/smrt-*` dependencies, locates their manifest files, and
 * registers every class in the global `ObjectRegistry`.  It does **not**
 * generate a new manifest — use `smrtVitestPlugin()` with
 * `generateManifest: true` (the default) if auto-generation is needed.
 *
 * @param options - Same options accepted by {@link smrtVitestPlugin}.
 *   Relevant fields: `packages`, `verbose`, `root`.
 * @returns A promise that resolves once all manifests have been loaded.
 *
 * @example
 * ```typescript
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   test: {
 *     globalSetup: ['@happyvertical/smrt-vitest/setup'],
 *   },
 * });
 * ```
 *
 * @example Calling directly in a custom bootstrap
 * ```typescript
 * import { setupSmrtManifests } from '@happyvertical/smrt-vitest';
 *
 * await setupSmrtManifests({ verbose: true });
 * ```
 *
 * @see {@link smrtVitestPlugin} for the recommended Vite-plugin approach that
 *   also handles manifest generation.
 */
export async function setupSmrtManifests(
  options: SmrtVitestPluginOptions = {},
): Promise<void> {
  const { packages = [], verbose = false, root = process.cwd() } = options;

  await loadAndRegisterLocalManifest(root, verbose);

  const smrtPackages = discoverSmrtPackages(root, packages);

  if (smrtPackages.length === 0) {
    return;
  }

  if (verbose) {
    console.log(
      `[smrt-vitest] Discovered ${smrtPackages.length} SMRT packages:`,
      smrtPackages,
    );
  }

  // Load manifests from all discovered packages
  const results = await Promise.all(
    smrtPackages.map((pkg) => loadAndRegisterManifest(pkg, verbose)),
  );

  const successCount = results.filter(Boolean).length;
  console.log(
    `[smrt-vitest] Loaded manifests from ${successCount}/${smrtPackages.length} packages`,
  );
}

export default smrtVitestPlugin;

// Export test database utilities
export {
  createIsolatedTestDb,
  createIsolatedTestDbFromManifest,
  createTestDb,
  getAdapterDisplayName,
  getInMemoryDbConfig,
  getTestAdapter,
  getTestDbConfig,
  type IsolatedTestDbOptions,
  type IsolatedTestDbResult,
  isPostgresAvailable,
  type ManifestTestDbOptions,
  type TestDbAdapter,
  type TestDbConfig,
} from './test-db.js';

// Export transaction types (temporary until SDK #722 is merged)
export type { TransactionHandle } from './types.js';
