// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). CLI ships as an SSR Node binary with
// `ssr: true` build mode, node24 target, and externalizes Node-only
// deps (rollup, esbuild, vite, jiti, tsx) that don't belong in a
// library-mode lib bundle. createPackageConfig is library-mode only.

import { defineConfig } from 'vite';
import { declarations } from '../../scripts/declarations.js';

export default defineConfig({
  build: {
    lib: {
      // `app` is the side-effect-free `@happyvertical/smrt-cli/app` subpath;
      // `index` runs the CLI on import.
      entry: { index: 'src/index.ts', app: 'src/app/index.ts' },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    // Build for Node.js, not browser
    ssr: true,
    rollupOptions: {
      external: [
        // Node.js built-ins
        /^node:/,
        'fs',
        'path',
        'url',
        'module',
        'os',
        'crypto',
        'util',
        'child_process',
        'https',
        'readline',
        'process',
        'events',
        'stream',
        'buffer',
        'zlib',
        'net',
        'dns',
        'http',
        'http2',
        'tls',
        'assert',
        'querystring',
        'perf_hooks',
        'v8',
        'vm',
        'tty',
        'worker_threads',

        // Internal SMRT packages
        '@happyvertical/smrt-agents',
        '@happyvertical/smrt-app-runtime',
        '@happyvertical/smrt-config',
        '@happyvertical/smrt-core',
        /^@happyvertical\/smrt-core\//,
        '@happyvertical/smrt-dev-mcp',
        /^@happyvertical\/smrt-dev-mcp\//,
        '@happyvertical/smrt-scanner',
        '@happyvertical/smrt-types',
        '@happyvertical/sql',
        '@happyvertical/utils',

        // External dependencies to externalize
        'fast-glob',
        'fdir',
        'picomatch',
        'tinyglobby',
        'oxc-parser',
        'oxc-resolver',
        'tar',
        'chokidar',
        'fsevents',
        'rollup',
        /^rollup\//,
        'esbuild',
        'vite',
        /^vite\//,
        'jiti',
        'tsx',
        'get-tsconfig',
      ],
    },
    target: 'node24',
    outDir: 'dist',
  },
  plugins: [
    declarations({
      packageDir: __dirname,
      entries: { app: 'src/app/index.ts' },
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks', // Fix for vitest 4.0 dynamic import timeouts in workspace
  },
});
