import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  // hookTimeout matches testTimeout because this suite's expensive work is in
  // beforeAll, not in the tests: it generates the MCP server, spawns `tsx` on
  // the generated TypeScript for the stdio transport, completes a protocol
  // handshake, and then spawns the HTTP adapter as a second process. The `it`
  // blocks only POST to that already-running adapter. Left at vitest's 10s
  // default the hook aborted at 10067ms on a contended runner, reporting both
  // tests as skipped and taking unrelated PRs down with it (#2240).
  test: { environment: 'node', testTimeout: 240_000, hookTimeout: 240_000 },
});
