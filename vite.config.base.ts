import { existsSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { transform } from 'esbuild';
import type { Plugin, UserConfig, UserConfigFnPromise } from 'vite';
import { declarations } from './scripts/declarations.js';

interface PackageConfigOptions {
  /**
   * Svelte component subdirectory (relative to src/).
   * When set, vite externalizes .svelte imports and skips that directory
   * for dts generation. Use `svelte-package` in a secondary build step
   * to generate proper .svelte.d.ts type declarations.
   *
   * Example build script: `vite build --mode library && svelte-package -i src/svelte -o dist/svelte -p`
   */
  svelte?: string;
  /**
   * Additional entry points beyond the default `index.ts`.
   * Each entry is emitted as a separate file in dist/ (e.g., `ui` → `dist/ui.js`).
   *
   * A string entry resolves to `src/<name>.ts`.
   * An object entry allows custom source files when the emitted name should stay
   * stable but the source path needs to differ.
   */
  entries?: Array<
    | string
    | {
        name: string;
        source: string;
      }
  >;
  /**
   * Additional declaration-file exclude globs, relative to the package root.
   * Use this for package-local app/dev surfaces that should not ship as
   * publishable library types.
   */
  dtsExclude?: string[];
}

function isPathInside(parentDir: string, targetPath: string): boolean {
  const relativePath = relative(parentDir, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
  );
}

function createLegacyDecoratorTransformPlugin(packageDir: string): Plugin {
  return {
    name: 'smrt-legacy-decorator-transform',
    enforce: 'pre',
    async transform(code, id) {
      const [filePath] = id.split('?');
      if (
        !filePath ||
        filePath.endsWith('.d.ts') ||
        filePath.includes('/node_modules/') ||
        !/\.[cm]?tsx?$/.test(filePath) ||
        !isPathInside(packageDir, filePath)
      ) {
        return null;
      }

      const result = await transform(code, {
        loader: filePath.endsWith('x') ? 'tsx' : 'ts',
        sourcefile: filePath,
        sourcemap: true,
        target: 'es2022',
        tsconfigRaw: {
          compilerOptions: {
            experimentalDecorators: true,
            emitDecoratorMetadata: false,
          },
        },
      });

      return {
        code: result.code,
        map: result.map ? JSON.parse(result.map) : null,
      };
    },
  };
}

/**
 * Shared Vite configuration factory for all SMRT packages
 *
 * Creates a standardized build configuration for Node.js-only packages
 * with TypeScript declaration generation.
 *
 * For packages with Svelte components, pass `{ svelte: 'svelte' }` and add
 * a `svelte-package` step to the build script. See smrt-analytics for example.
 *
 * Adapted from @have/sdk vite.config.base.ts pattern (PR 238)
 */
export function createPackageConfig(
  packageName: string,
  options: PackageConfigOptions = {},
): UserConfigFnPromise {
  const packageDir = resolve(__dirname, 'packages', packageName);
  const buildTsconfigPath = resolve(packageDir, 'tsconfig.build.json');
  const tsconfigPath = existsSync(buildTsconfigPath)
    ? buildTsconfigPath
    : resolve(packageDir, 'tsconfig.json');

  // Packages that should NOT use smrtPlugin (framework infrastructure)
  const skipSmrtPlugin = [
    'core',
    'types',
    'config',
    'scanner',
    'vitest',
    'smrt-playground',
    // Framework wrapper library — has no @smrt() classes of its own; it
    // consumes generated definitions passed in as arguments (#1761).
    'smrt-web',
    'smrt-workbench',
  ];

  return async () => {
    // Dynamically import smrtPlugin only if needed
    const shouldUseSmrtPlugin = !skipSmrtPlugin.includes(packageName);
    let smrtPlugin = null;

    if (shouldUseSmrtPlugin) {
      const { importWorkspaceModule } = await import(
        './packages/core/src/utils/import-workspace-module.js'
      );
      const { smrtPlugin: plugin } = await importWorkspaceModule<
        typeof import('./packages/core/src/vite-plugin/index.js')
      >({
        packageName: '@happyvertical/smrt-core/vite-plugin',
        distEntry: 'packages/core/dist/vite-plugin.js',
        sourceEntry: 'packages/core/src/vite-plugin/index.ts',
        purpose: 'shared SMRT package build configuration',
      });
      smrtPlugin = plugin;
    }
    const sveltePlugin = options.svelte
      ? (await import('@sveltejs/vite-plugin-svelte')).svelte
      : null;

    // Build entry points map
    const entryPoints: Record<string, string> = {
      index: resolve(packageDir, 'src/index.ts'),
    };
    if (options.entries) {
      for (const entry of options.entries) {
        if (typeof entry === 'string') {
          entryPoints[entry] = resolve(packageDir, `src/${entry}.ts`);
          continue;
        }

        entryPoints[entry.name] = resolve(packageDir, entry.source);
      }
    }

    // Preserve local type-only helper modules in dist when packages expose
    // declarations that reference `./types`.
    const typesEntryPath = resolve(packageDir, 'src/types.ts');
    if (existsSync(typesEntryPath) && !('types' in entryPoints)) {
      entryPoints.types = typesEntryPath;
    }

    return {
      build: {
        lib: {
          entry: entryPoints,
          formats: ['es'] as const,
        },
        rollupOptions: {
          output: {
            dir: resolve(packageDir, 'dist'),
            format: 'es' as const,
            preserveModules: false,
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
          external: [
            // Node.js built-ins - externalize completely
            /^node:/,
            /^bun:/,
            'fs',
            'path',
            'url',
            'os',
            'crypto',
            'stream',
            'util',
            'events',
            'child_process',
            'buffer',
            'Buffer',
            'zlib',
            'assert',
            'http',
            'https',
            'net',
            'tls',
            'dns',
            'cluster',
            'worker_threads',
            'perf_hooks',
            'readline',
            'repl',
            'vm',
            'v8',
            'inspector',

            // External dependencies - don't bundle these
            'cheerio',
            'crawlee',
            'puppeteer',
            'playwright',
            'playwright-core',
            'sqlite3',
            'better-sqlite3',
            'pg',
            'mysql2',
            'typeorm',
            'prisma',
            '@prisma/client',
            'sharp',
            'canvas',
            'pdf-parse',
            'pdf2pic',
            'tesseract.js',
            'openai',
            /^openai\//,
            'anthropic',
            '@anthropic-ai/sdk',
            '@google/generative-ai',
            '@google/genai',
            '@aws-sdk/client-bedrock-runtime',
            '@langchain/core',
            '@langchain/openai',
            '@langchain/anthropic',
            'date-fns',
            'pluralize',
            'uuid',
            '@paralleldrive/cuid2',
            'yaml',
            // HTML sanitizer (smrt-content body-format): CJS with postcss and
            // htmlparser2 underneath; the consumer's bundler resolves it.
            'sanitize-html',
            'jsdom',
            'happy-dom',
            'axios',
            'node-fetch',
            'express',
            'cors',
            'dotenv',
            'typescript',
            'vite',
            /^vite\//,
            '@googlemaps/google-maps-services-js',
            '@google-cloud/translate',
            'deepl-node',
            'redis',
            '@modelcontextprotocol/sdk',
            /^@modelcontextprotocol\//,
            'undici',
            'unpdf',
            'pngjs',
            'jpeg-js',
            '@gutenye/ocr-node',
            'cosmiconfig',
            // jiti loads its own babel transform via a relative require
            // (`../dist/babel.cjs`); bundling it breaks that path, so it must
            // stay external (#1783).
            'jiti',
            /^jiti\//,
            '@libsql/client',
            'fast-glob',
            'minimatch',
            'oxc-parser',
            'oxc-resolver',

            // Internal SMRT packages - externalize to avoid cross-package bundling
            /^@happyvertical\//,

            // External SDK packages
            /^@have\//,

            // TanStack client-data engine (smrt-web): externalized so the
            // consumer resolves a single lockstep-pinned copy, and so the
            // ~76 kB runtime code-splits cleanly out of public/site bundles.
            /^@tanstack\//,

            // Virtual modules from SMRT framework
            '@smrt/routes',
            '@smrt/client',
            '@smrt/mcp',
            '@smrt/manifest',

            // When svelte option is set, externalize .svelte imports
            // (they're handled by svelte-package in a secondary build step)
            ...(options.svelte
              ? [/\.svelte$/, 'svelte', 'svelte/internal', 'svelte/store']
              : []),
          ],
        },
        minify: false, // Keep code readable for library usage
        sourcemap: true,
        target: 'es2022',
        reportCompressedSize: false, // Speed up build
      },
      plugins: [
        createLegacyDecoratorTransformPlugin(packageDir),
        // Add Svelte config for packages that ship Svelte components.
        ...(sveltePlugin ? [sveltePlugin()] : []),
        // Add smrtPlugin for packages with SMRT objects
        ...(shouldUseSmrtPlugin && smrtPlugin
          ? [
              smrtPlugin({
                include: ['src/**/*.ts'],
                exclude: ['**/*.test.ts', '**/*.spec.ts'],
                generateTypes: true,
                hmr: false, // Disable HMR for library builds
              }),
            ]
          : []),
        // Generate TypeScript declarations
        declarations({
          packageDir,
          tsconfigPath,
          entries: entryPoints,
          exclude: [
            '**/*.test.ts',
            '**/*.spec.ts',
            '**/*.test.*.ts',
            '**/*.config.ts',
            '**/*.config.js',
            ...(options.svelte ? [`src/${options.svelte}/**`] : []),
            ...(options.dtsExclude ?? []),
          ],
        }),
      ],
    } satisfies UserConfig;
  };
}
