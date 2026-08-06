import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin({ verbose: true })],
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    // bridge.test.ts spawns `tsx` on a fixture through StdioClientTransport and
    // completes an MCP handshake before it asserts anything. On vitest's 5s
    // default that passed locally and on the affected lane, then timed out
    // three times in the merge queue — where `mode: full` actually runs this
    // package — and ejected an unrelated PR (#2243). 30000 matches the value
    // used across the rest of the workspace.
    testTimeout: 30000,
    // Hooks do not inherit testTimeout; see TESTING_STANDARD.md.
    hookTimeout: 30000,
  },
});
