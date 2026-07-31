import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: ['src/svelte/__tests__/components.test.ts'],
    coverage: {
      provider: 'v8',
      exclude: ['**/__tests__/**', '**/*.{test,spec}.ts', '**/*.d.ts'],
    },
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
  },
});
