// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). CLI ships as an SSR Node binary with
// `ssr: true` build mode, node24 target, and externalizes Node-only
// deps (rollup, esbuild, vite, jiti, tsx) that don't belong in a
// library-mode lib bundle. createPackageConfig is library-mode only.

import { defineConfig } from 'vite';
import { cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { declarations } from '../../scripts/declarations.js';
import { resolveRecipeIndex } from './src/commands/cookbook/recipe-index.js';

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
        '@happyvertical/smrt-assets',
        '@happyvertical/smrt-assets/locator',
        '@happyvertical/smrt-config',
        /^@happyvertical\/smrt-config\//,
        '@happyvertical/smrt-core',
        /^@happyvertical\/smrt-core\//,
        '@happyvertical/smrt-desktop',
        /^@happyvertical\/smrt-desktop\//,
        '@happyvertical/smrt-dev-mcp',
        /^@happyvertical\/smrt-dev-mcp\//,
        '@happyvertical/smrt-scanner',
        '@happyvertical/smrt-types',
        '@happyvertical/sql',
        '@happyvertical/utils',
        /^@happyvertical\/encryption(?:\/|$)/,

        // External dependencies to externalize
        /^@modelcontextprotocol\//,
        'fdir',
        'picomatch',
        'tinyglobby',
        'oxc-parser',
        'oxc-resolver',
        'tar',
        'yaml',
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
    {
      name: 'smrt:bundle-cookbook-template',
      async closeBundle() {
        const target = resolve(__dirname, 'dist/templates/cookbook');
        const template = resolve(__dirname, '../template-sveltekit');
        cpSync(resolve(template, 'template'), target, {
          recursive: true,
          filter: (file) => !/(?:^|\/)(node_modules|\.svelte-kit)(?:\/|$)/.test(file),
        });
        cpSync(resolve(template, 'cookbook-template'), target, { recursive: true });
        const file = resolve(target, 'package.json');
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        pkg.smrt = { ...pkg.smrt, cookbookHost: true };
        for (const name of ['agents', 'app-mcp', 'chat', 'types'])
          pkg.dependencies[`@happyvertical/smrt-${name}`] = pkg.dependencies['@happyvertical/smrt-core'];
        const index = await resolveRecipeIndex({}, { dir: __dirname, registry: false });
        const providers = new Set<string>(Object.keys(pkg.dependencies));
        for (const name of providers) {
          for (const dependency of index.packages.get(name)?.manifest.smrtDependencies ?? []) {
            providers.add(dependency);
            pkg.dependencies[dependency] ??= pkg.dependencies['@happyvertical/smrt-core'];
          }
        }
        pkg.scripts.build = 'vite build';
        pkg.scripts['smrt:build'] = 'smrt source build';
        writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
        rmSync(resolve(target, 'src/lib/objects'), { recursive: true, force: true });
        const ignore = resolve(target, 'gitignore.template');
        writeFileSync(ignore, `${readFileSync(ignore, 'utf8')}\n.smrt-local\n`);
      },
    },
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
