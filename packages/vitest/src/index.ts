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

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vitest/config';

/**
 * Options for the SMRT Vitest plugin
 */
export interface SmrtVitestPluginOptions {
  /**
   * Additional SMRT packages to load manifests from.
   * By default, discovers packages from peerDependencies and devDependencies.
   */
  packages?: string[];

  /**
   * Enable verbose logging
   * @default false
   */
  verbose?: boolean;

  /**
   * Root directory to search for package.json
   * @default process.cwd()
   */
  root?: string;
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
    const { ObjectRegistry } = await import('@happyvertical/smrt-core');
    const { ManifestManager } = await import(
      '@happyvertical/smrt-core/manifest'
    );

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

    // Register each object from the manifest
    let registered = 0;
    for (const [name, objectDef] of Object.entries(manifest.objects)) {
      if (!ObjectRegistry.hasClass(name)) {
        ObjectRegistry.registerFromManifest(
          name,
          objectDef,
          manifest.packageName || packageName,
        );
        registered++;
      }
    }

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

/**
 * Create the SMRT Vitest plugin
 *
 * This plugin automatically discovers and loads manifests from SMRT peer
 * dependencies before tests run, enabling cross-package integration tests.
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
 */
export function smrtVitestPlugin(
  options: SmrtVitestPluginOptions = {},
): Plugin {
  const { packages = [], verbose = false, root = process.cwd() } = options;

  let manifestsLoaded = false;

  return {
    name: 'smrt-vitest',

    // Run during config resolution to ensure manifests are loaded before tests
    async configResolved() {
      if (manifestsLoaded) return;

      const smrtPackages = discoverSmrtPackages(root, packages);

      if (smrtPackages.length === 0) {
        if (verbose) {
          console.log('[smrt-vitest] No SMRT packages found to load');
        }
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

      // Validate local manifest is loaded (fail fast with actionable error)
      try {
        const { ManifestManager } = await import(
          '@happyvertical/smrt-core/manifest'
        );
        const manager = new ManifestManager(root);
        const localManifest = manager.loadLocal();

        if (localManifest) {
          console.log(
            `[smrt-vitest] Local manifest: ${Object.keys(localManifest.objects).length} objects`,
          );
        } else if (verbose) {
          console.warn(
            `[smrt-vitest] No local manifest found. ` +
              `Run 'smrt generate:test' or 'pnpm turbo generate:test' if tests fail with "unregistered class" errors.\n` +
              `Checked: ${manager.getOutputPath('dev')}, ${manager.getOutputPath('build')}`,
          );
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
 * Setup function for use with vitest globalSetup
 *
 * Alternative to using the plugin, can be used as a globalSetup file.
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
 */
export async function setupSmrtManifests(
  options: SmrtVitestPluginOptions = {},
): Promise<void> {
  const { packages = [], verbose = false, root = process.cwd() } = options;

  const smrtPackages = discoverSmrtPackages(root, packages);

  if (smrtPackages.length === 0) {
    if (verbose) {
      console.log('[smrt-vitest] No SMRT packages found to load');
    }
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
  createTestDb,
  getAdapterDisplayName,
  getInMemoryDbConfig,
  getTestAdapter,
  getTestDbConfig,
  type IsolatedTestDbOptions,
  type IsolatedTestDbResult,
  isPostgresAvailable,
  type TestDbAdapter,
  type TestDbConfig,
} from './test-db';

// Export transaction types (temporary until SDK #722 is merged)
export type { TransactionHandle } from './types';
