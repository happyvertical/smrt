import { resolve } from 'node:path';
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
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
export default defineConfig({
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
    include: ['src/**/*.{test,spec}.{js,ts}', 'src/**/*.{test,spec}.{mjs,mts}'],

    // Exclude patterns
    exclude: ['**/node_modules/**', '**/dist/**', '**/docs/**', '**/*.d.ts'],

    // Timeouts for async operations
    testTimeout: 30000,
    hookTimeout: 10000,

    // Setup files removed - file doesn't exist
    // setupFiles: ['../../vitest.setup.ts'],

    // Reporter
    reporter: 'default',

    // Coverage configuration
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{js,ts}'],
      exclude: [
        'src/**/*.{test,spec}.{js,ts}',
        'src/**/*.d.ts',
        'src/types/**',
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
});
