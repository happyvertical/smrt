import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';
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
    smrtPlugin({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      baseClasses: ['SmrtObject', 'SmrtCollection'],
      generateTypes: true,
      watch: true,
      hmr: true,
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
    reporter: process.env.CI ? 'github' : 'default',

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
      $lib: '/workspaces/sdk/smrt/products/src',
      // Map workspace packages for development
      // These would be npm packages in a standalone repo
      '@happyvertical/smrt-core': '/workspaces/sdk/packages/smrt/src',
      '@happyvertical/pdf': '/workspaces/sdk/packages/pdf/src',
      '@happyvertical/spider': '/workspaces/sdk/packages/spider/src',
      '@happyvertical/files': '/workspaces/sdk/packages/files/src',
      '@happyvertical/utils': '/workspaces/sdk/packages/utils/src',
      '@happyvertical/sql': '/workspaces/sdk/packages/sql/src',
      '@happyvertical/ai': '/workspaces/sdk/packages/ai/src',
    },
  },

  // Server configuration for development
  server: {
    port: 3004,
    host: true,
  },
});
