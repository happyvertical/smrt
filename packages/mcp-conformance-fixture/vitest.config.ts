import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    environment: 'node',
    testTimeout: 240_000,
    // The beforeAll hook generates the MCP server, spawns it through tsx, and
    // waits for the HTTP endpoint to answer. That is comfortably under
    // vitest's 10s hook default on an idle machine and reliably over it on a
    // contended CI runner, where it fails as `Hook timed out in 10000ms` with
    // every test reported as skipped. testTimeout was already raised for the
    // same reason; hooks need the same treatment (30000 matches the other
    // packages that hit this).
    hookTimeout: 30_000,
  },
});
