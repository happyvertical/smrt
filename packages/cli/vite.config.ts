// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). CLI ships as an SSR Node binary with
// `ssr: true` build mode, node24 target, and externalizes Node-only
// deps (rollup, esbuild, vite, jiti, tsx) that don't belong in a
// library-mode lib bundle. createPackageConfig is library-mode only.

import { defineConfig } from 'vite';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { relative, resolve } from 'node:path';
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
          filter: (file) => !/(?:^|\/)(node_modules|\.svelte-kit|\.gitignore)(?:\/|$)/.test(file),
        });
        const overlay = resolve(template, 'cookbook-template');
        const authoredRoutes = new Set<string>();
        cpSync(overlay, target, {
          recursive: true,
          filter: (file) => {
            const path = relative(overlay, file).replaceAll('\\', '/');
            if (path.startsWith('src/routes/api/') && path.endsWith('/+server.ts'))
              authoredRoutes.add(path);
            return !/(?:^|\/)\.gitignore$/.test(file);
          },
        });
        // pnpm pack treats nested .gitignore as an exclusion list. Ship only
        // the renamed template, and keep authored routes tracked after apply.
        rmSync(resolve(target, '.gitignore'), { force: true });
        const file = resolve(target, 'package.json');
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        pkg.smrt = { ...pkg.smrt, cookbookHost: true };
        for (const name of ['agents', 'app-mcp', 'chat', 'types'])
          pkg.dependencies[`@happyvertical/smrt-${name}`] = pkg.dependencies['@happyvertical/smrt-core'];
        // The CLI can finish before other providers on a cold parallel build.
        // Resolve their runtime closure from authored metadata, never whichever
        // generated manifests happen to exist when this bundle completes.
        const dependencies = new Map<string, string[]>();
        const packagesDir = resolve(__dirname, '..');
        for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const metadata = resolve(packagesDir, entry.name, 'package.json');
          if (!existsSync(metadata)) continue;
          const provider = JSON.parse(readFileSync(metadata, 'utf8'));
          dependencies.set(provider.name, Object.keys({ ...provider.dependencies, ...provider.optionalDependencies })
            .filter((name) => name.startsWith('@happyvertical/smrt-')));
        }
        const providers = new Set<string>(Object.keys(pkg.dependencies));
        for (const name of providers) {
          for (const dependency of dependencies.get(name) ?? []) {
            providers.add(dependency);
            pkg.dependencies[dependency] ??= pkg.dependencies['@happyvertical/smrt-core'];
          }
        }
        pkg.scripts.build = 'vite build';
        pkg.scripts['smrt:build'] = 'smrt source build';
        writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
        rmSync(resolve(target, 'src/lib/objects'), { recursive: true, force: true });
        const ignore = resolve(target, 'gitignore.template');
        writeFileSync(ignore, `${readFileSync(ignore, 'utf8')}\n${[...authoredRoutes].sort().map((path) => `!${path}`).join('\n')}\n.smrt-local\n`);
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
