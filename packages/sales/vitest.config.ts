import { configDefaults, defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    exclude: [
      ...configDefaults.exclude,
      'src/svelte/__tests__/lead-components.test.ts',
    ],
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
  },
});
