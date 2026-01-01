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
        '@happyvertical/smrt-config',
        '@happyvertical/smrt-core',
        /^@happyvertical\/smrt-core\//,
        '@happyvertical/smrt-types',
        '@happyvertical/sql',
        '@happyvertical/utils',

        // External dependencies to externalize
        'fast-glob',
        'fdir',
        'picomatch',
        'tinyglobby',
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
