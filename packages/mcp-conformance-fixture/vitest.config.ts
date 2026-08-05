import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';

export default defineConfig({
  plugins: [smrtVitestPlugin()],
  test: {
    environment: 'node',
    testTimeout: 240_000,
    // Match testTimeout. Nearly all of this suite's work happens in `beforeAll`,
    // not in the test bodies: it regenerates the MCP server with `MCPGenerator`,
    // spawns a `tsx` child over stdio to negotiate the protocol and list tools,
    // then spawns a second `tsx` child for the HTTP adapter. Left at vitest's
    // 10s `hookTimeout` default that hook measured 10,022ms on a loaded runner
    // and ejected PR #2230 from the merge queue (#2238). This package sits in
    // the shared `test-packages` shard, so the miss was not local to that PR.
    hookTimeout: 240_000,
  },
});
