/**
 * A downstream app's unit-test setup: smrt-vitest loads the app's built,
 * aggregated .smrt/manifest.json (not a regenerated local scan), the way an
 * integration suite runs after `vite build`.
 */
import { fileURLToPath } from 'node:url';
import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  plugins: [smrtVitestPlugin({ root, generateManifest: false })],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 30000,
  },
});
