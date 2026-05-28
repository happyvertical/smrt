// Hand-written: ships an SSR Node binary + library (`index.ts` and
// `bin/smrt-mcp-bridge.ts`), so `lib.entry` is multi-entry and the
// MCP SDK + Node built-ins are externalised. `createPackageConfig`
// is library-mode only and doesn't support multi-entry bin builds.

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
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

        '@modelcontextprotocol/sdk',
        /^@modelcontextprotocol\/sdk\//,
      ],
      output: {
        entryFileNames: '[name].js',
        // Preserve the shebang on the bin entry — Rollup strips it by default
        // because `#!` looks like a comment.
        banner: (chunk) =>
          chunk.fileName === 'bin/smrt-mcp-bridge.js'
            ? '#!/usr/bin/env node'
            : '',
      },
    },
    target: 'node24',
    outDir: 'dist',
  },
  plugins: [
    dts({
      rollupTypes: false,
      bundledPackages: [],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**'],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
  },
});
