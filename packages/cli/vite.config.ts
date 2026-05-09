// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). CLI ships as an SSR Node binary with
// `ssr: true` build mode, node24 target, and externalizes Node-only
// deps (rollup, esbuild, vite, jiti, tsx) that don't belong in a
// library-mode lib bundle. createPackageConfig is library-mode only.

import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
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
        '@happyvertical/smrt-config',
        '@happyvertical/smrt-core',
        /^@happyvertical\/smrt-core\//,
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
    dts({
      rollupTypes: true,
      bundledPackages: [],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks', // Fix for vitest 4.0 dynamic import timeouts in workspace
  },
});
