// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). Same dual-mode (SvelteKit dev /
// library build) pattern as smrt-content; see content's vite.config.ts
// for rationale.

import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import {
  viteWorkspaceAliases,
  workspaceAliasPackageNames,
} from './workspace-aliases.js';

/**
 * Dual-mode Vite config for smrt-assets
 *
 * - `vite build --mode library` → standard SMRT library build via createPackageConfig
 * - `vite dev` (SvelteKit)      → local playground for component development
 */
export default defineConfig(async ({ mode }) => {
  const isPackageBuild =
    mode === 'library' || process.env.SMRT_PACKAGE_BUILD === '1';

  // Library build mode (used by `pnpm run build`)
  if (isPackageBuild) {
    const { createPackageConfig } = await import('../../vite.config.base.js');
    // Delegate to the shared package config which handles entry points,
    // externals, dts generation, and svelte-package exclusion.
    const config = createPackageConfig('assets', {
      entries: ['playground'],
      svelte: 'svelte',
      dtsExclude: ['src/routes/**/*'],
      // Fail the build on TS errors in dts generation so type-only bugs
      // (e.g. DOM-only types under a non-DOM lib config, see PR #1130)
      // can't ship to npm silently. Package-specific opt-in until the
      // rest of the monorepo is ready to follow.
      strictDts: true,
    });
    // createPackageConfig returns a UserConfigExport; resolve it
    const resolved = typeof config === 'function' ? await (config as any)({ mode, command: 'build' }) : config;
    return resolved;
  }

  // SvelteKit dev mode (used by `pnpm run dev`)
  const { importWorkspaceModule } = await import(
    '../core/src/utils/import-workspace-module.js'
  );
  const { smrtPlugin } = await importWorkspaceModule<
    typeof import('@happyvertical/smrt-core/vite-plugin')
  >({
    packageName: '@happyvertical/smrt-core/vite-plugin',
    distEntry: 'packages/core/dist/vite-plugin.js',
    sourceEntry: 'packages/core/src/vite-plugin/index.ts',
    purpose: 'assets package Vite config',
  });
  const { smrtConsumer } = await importWorkspaceModule<
    typeof import('@happyvertical/smrt-core/consumer-plugin')
  >({
    packageName: '@happyvertical/smrt-core/consumer-plugin',
    distEntry: 'packages/core/dist/consumer-plugin.js',
    sourceEntry: 'packages/core/src/consumer-plugin/index.ts',
    purpose: 'assets package consumer plugin',
  });

  return {
    resolve: {
      alias: viteWorkspaceAliases,
    },
    optimizeDeps: {
      exclude: workspaceAliasPackageNames,
    },
    ssr: {
      noExternal: workspaceAliasPackageNames,
    },
    plugins: [
      sveltekit(),
      smrtConsumer({
        projectRoot: process.cwd(),
        svelteKit: true,
      }),
      smrtPlugin({
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.spec.ts', 'src/svelte/**/*', 'src/routes/**/*', '**/*.svelte'],
        generateTypes: false,
        svelteKit: {
          enabled: true,
          routesDir: 'src/routes/api',
          objectsDir: 'src/models',
        },
      }),
    ],
  };
});
