/**
 * SMRT Vitest Plugin
 *
 * Automatically loads manifests from SMRT peer dependencies before tests run.
 * This solves Issue #583 where cross-package integration tests fail because
 * external package classes aren't registered in the test manifest.
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
import { join } from 'node:path';
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
 * Load manifest from a package and register its classes
 */
async function loadAndRegisterManifest(
  packageName: string,
  verbose: boolean,
): Promise<boolean> {
  try {
    // Import the manifest loader from smrt-core
    const { loadExternalManifestSync } = await import(
      '@happyvertical/smrt-core/manifest'
    );
    const { ObjectRegistry } = await import('@happyvertical/smrt-core');

    const manifest = loadExternalManifestSync(packageName);

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
          manifest.packageName,
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
