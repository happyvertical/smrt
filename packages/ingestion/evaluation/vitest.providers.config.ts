import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    include: ['evaluation/child-budget.integration.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
