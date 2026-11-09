import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
