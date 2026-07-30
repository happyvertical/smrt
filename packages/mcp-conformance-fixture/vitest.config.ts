import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    // The conformance spec generates a server, spawns it over stdio, and runs
    // the official suite against a forwarding HTTP harness.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
