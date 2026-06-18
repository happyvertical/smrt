import { resolve } from 'node:path';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

/**
 * Standalone Vitest configuration for SMRT Products template
 *
 * This is a self-contained configuration that includes:
 * - SMRT plugin for virtual module generation
 * - Svelte support for UI components
 * - Module federation testing support
 * - Full test environment setup
 *
 * This template can be copied to other repositories as a complete example
 * of testing SMRT-based microservices with triple-purpose architecture
 * (standalone, federation, and NPM library).
 */
export default defineConfig(async () => {
  const { importWorkspaceModule } = await import(
    '../core/src/utils/import-workspace-module.ts'
  );
  const { smrtPlugin } = await importWorkspaceModule<
    typeof import('@happyvertical/smrt-core/vite-plugin')
  >({
    packageName: '@happyvertical/smrt-core/vite-plugin',
    distEntry: 'packages/core/dist/vite-plugin.js',
    sourceEntry: 'packages/core/src/vite-plugin/index.ts',
    purpose: 'products package Vitest config',
  });

  return {
    plugins: [
      svelte(),
      smrtVitestPlugin({ verbose: true }),
      smrtPlugin({
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.spec.ts'],
        baseClasses: ['SmrtObject', 'SmrtCollection'],
        generateTypes: true,
        watch: false,
        hmr: false,
        mode: 'server', // Enable file scanning for auto-generation
        typeDeclarationsPath: 'src/types',
      }),
    ],

    test: {
      // Test environment
      environment: 'node',

      // Test discovery patterns for this template
      include: [
        'src/**/*.{test,spec}.{js,ts}',
        'src/**/*.{test,spec}.{mjs,mts}',
      ],

      // Exclude patterns
      exclude: ['**/node_modules/**', '**/dist/**', '**/docs/**', '**/*.d.ts'],

      // Timeouts for async operations
      testTimeout: 30000,
      hookTimeout: 30000,

      // Setup files removed - file doesn't exist
      // setupFiles: ['../../vitest.setup.ts'],

      // Reporter
      reporter: 'default',

      // Coverage configuration
      //
      // The coverage denominator is this package's authored business logic:
      // `src/lib/models`, `src/lib/collections`, `src/lib/utils`, and the
      // `src/lib/stores` runes state. The exclusions below drop code that is
      // NOT authored business logic and only deflates the signal:
      //   - re-export barrels (top-level `src/*.ts` package entry points and the
      //     per-folder `index.ts` aggregators)
      //   - app-mode / server / federation entrypoints — this package is the
      //     reference "triple-consumption" template, so it ships standalone
      //     server + demo app + federation scaffolding alongside the library
      //   - the demo app under `src/app/**` and the `mock-smrt-client` demo glue
      //   - `@smrt`-generated code, `.svelte` components, and the `.svelte.ts`
      //     runes stores: v8 cannot meaningfully instrument anything the Svelte
      //     compiler touches (the same reason smrt-svelte is exempt from the
      //     gate). The stores are demo-app reactive state over `mock-smrt-client`,
      //     exercised by the app surface, not by line coverage.
      //
      // What remains in the denominator is the published library business logic:
      // `src/lib/models`, `src/lib/collections`, `src/lib/utils`, `src/lib/types`.
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{js,ts}'],
        exclude: [
          'src/**/*.{test,spec}.{js,ts}',
          'src/**/*.d.ts',
          'src/types/**',
          '**/*.svelte',
          // Top-level re-export barrels + register glue
          'src/index.ts',
          'src/models.ts',
          'src/collections.ts',
          'src/components.ts',
          'src/stores.ts',
          'src/utils.ts',
          'src/generated.ts',
          'src/client.ts',
          'src/__smrt-register__.ts',
          // App-mode + standalone server + MCP entrypoints (template scaffolding)
          'src/main.ts',
          'src/mcp.ts',
          'src/server.ts',
          'src/native-api-server.ts',
          'src/simple-api-server.ts',
          'src/simple-server.ts',
          'src/app/**',
          'src/federation/**',
          // lib barrels, federation glue, generated code, and demo mock client
          'src/lib/index.ts',
          'src/lib/federation-entry.ts',
          'src/lib/generated/**',
          'src/lib/mock-smrt-client.ts',
          'src/lib/collections/index.ts',
          'src/lib/components/index.ts',
          'src/lib/models/index.ts',
          // Svelte-runes demo stores (compiled by the svelte plugin; v8 cannot
          // reliably instrument them) — see the rationale above.
          'src/lib/stores/**',
        ],
      },
    },

    resolve: {
      alias: {
        $lib: resolve(__dirname, 'src/lib'),
      },
    },

    // Server configuration for development
    server: {
      port: 3004,
      host: true,
    },
  };
});
