// Hand-written: ships an SSR Node binary + library (`index.ts` and
// executable entries), so `lib.entry` is multi-entry and the
// MCP SDK + Node built-ins are externalised. `createPackageConfig`
// is library-mode only and doesn't support multi-entry bin builds.

import { defineConfig } from 'vite';
import { declarations } from '../../scripts/declarations.js';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        'bin/smrt-app': 'src/bin/smrt-app.ts',
        'bin/smrt-mcp-bridge': 'src/bin/smrt-mcp-bridge.ts',
      },
      formats: ['es'],
    },
    ssr: true,
    rollupOptions: {
      external: [
        /^node:/,
        'fs',
        'fs/promises',
        'path',
        'url',
        'os',
        'process',
        'stream',
        'crypto',
        'http',
        'https',

        /^@modelcontextprotocol\//,
        '@happyvertical/smrt-users',
        /^@happyvertical\/smrt-users\//,
      ],
      output: {
        entryFileNames: '[name].js',
        // Preserve the shebang on the bin entry — Rollup strips it by default
        // because `#!` looks like a comment.
        banner: (chunk) =>
          chunk.fileName === 'bin/smrt-app.js' ||
          chunk.fileName === 'bin/smrt-mcp-bridge.js'
            ? '#!/usr/bin/env node'
            : '',
      },
    },
    target: 'node24',
    outDir: 'dist',
  },
  plugins: [
    declarations({ packageDir: __dirname }),
  ],
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
  },
});
