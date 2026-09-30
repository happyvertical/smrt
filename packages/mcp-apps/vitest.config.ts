import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({
  plugins: [smrtVitestPlugin({ exclude: ['**/*.test.ts', '**/dist/**'] })],
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
