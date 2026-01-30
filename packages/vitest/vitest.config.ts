import { defineConfig } from 'vitest/config';

export default defineConfig({
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
  },
});
