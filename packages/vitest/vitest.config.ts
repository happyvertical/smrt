import { defineConfig } from 'vitest/config';
import { getWorkspaceViteAliases } from './src/index.ts';

export default defineConfig({
  resolve: {
    alias: getWorkspaceViteAliases(__dirname),
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,mts}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
    ],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    // Disable parallelism to avoid race conditions with process.chdir() in tests
    fileParallelism: false,
  },
});
