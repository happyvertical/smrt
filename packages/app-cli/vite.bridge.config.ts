// The self-contained MCP stdio bridge (`@happyvertical/smrt-app-cli/mcp-bridge`):
// one ES module that imports only Node built-ins, so a desktop bundle can ship
// it byte for byte (`smrt desktop bundle --bridge`, smrt#4965). The same entry
// as the `smrt-mcp-bridge` bin, with every dependency inlined.

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/bin/smrt-mcp-bridge.ts',
    // Beside the bin build, whose output must stay: and `dist/bin/<name>` is
    // what maps the export back to its source for workspace test aliases.
    outDir: 'dist/bin',
    emptyOutDir: false,
    target: 'node24',
    rollupOptions: {
      output: {
        format: 'es',
        entryFileNames: 'smrt-mcp-bridge.mjs',
        codeSplitting: false,
        banner: '#!/usr/bin/env node',
      },
    },
  },
  ssr: { noExternal: true, target: 'node' },
});
