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
      // rollupTypes: true inlines the type-only re-exports from
      // @happyvertical/smrt-users/sveltekit (used by ./discovery.ts) into
      // the consolidated dist/index.d.ts. Without this, the per-file
      // discovery.d.ts retains `import type { ... } from
      // '@happyvertical/smrt-users/sveltekit'` and downstream consumers
      // who install smrt-app-cli without smrt-users get a TS error on
      // the re-exported CliResource / CommandDefinition types. The peer
      // `optional: true` flag only silences npm install warnings; it
      // doesn't prevent tsc errors. (#1311 review #6.)
      //
      // bundledPackages tells the dts roller it's OK to follow into
      // these packages and inline the referenced type shapes rather
      // than leaving the external import.
      rollupTypes: true,
      bundledPackages: ['@happyvertical/smrt-users'],
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
