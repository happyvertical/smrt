import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  resolve: {
    alias: {
      $lib: resolve(__dirname, 'src/lib'),
      '@happyvertical/smrt-facts': resolve(__dirname, 'src/workspace-facts.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    setupFiles: ['@happyvertical/smrt-vitest/setup'],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    singleFork: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/node_modules/**'],
    },
  },
});
