import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { UserConfig, UserConfigFnPromise } from 'vite';
import dts from 'vite-plugin-dts';

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
  /**
   * When true, abort the build if `vite-plugin-dts` surfaces any
   * TypeScript error-level diagnostics while generating `.d.ts` files.
   *
   * Without this, the dts plugin prints errors to stderr but Vite still
   * exits 0, so broken types can ship to npm (see PR #1129 / #1130).
   *
   * Off by default so the repo-wide latent TS errors in other packages
   * (e.g. virtual `@smrt/*` modules, pre-existing type mismatches) do
   * not regress existing builds. Enable per-package as each package is
   * cleaned up.
   *
   * @default false
   */
  strictDts?: boolean;
}

interface WorkspacePackageInfo {
  dir: string;
  name: string;
}

function collectWorkspacePackages(rootDir: string): WorkspacePackageInfo[] {
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = resolve(rootDir, entry.name);
      const packageJsonPath = resolve(dir, 'package.json');
      if (!existsSync(packageJsonPath)) {
        return [];
      }

      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        if (typeof packageJson.name !== 'string' || packageJson.name === '') {
          return [];
        }

        return [
          {
            dir,
            name: packageJson.name,
          },
        ];
      } catch {
        return [];
      }
    });
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/');
}

function isPathInside(parentDir: string, targetPath: string): boolean {
  const relativePath = relative(parentDir, targetPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..')
  );
}

function rewriteWorkspaceDeclarationImports(
  filePath: string,
  content: string,
  packageDir: string,
  workspacePackages: WorkspacePackageInfo[],
): string {
  const currentDir = dirname(filePath);
  const rewriteSpecifier = (specifier: string): string => {
    if (!specifier.startsWith('.')) {
      return specifier;
    }

    const resolvedSpecifier = resolve(currentDir, specifier);
    const targetPackage = workspacePackages.find(
      (workspacePackage) =>
        workspacePackage.dir !== packageDir &&
        isPathInside(workspacePackage.dir, resolvedSpecifier),
    );

    if (!targetPackage) {
      return specifier;
    }

    const relativeToPackage = normalizePath(
      relative(targetPackage.dir, resolvedSpecifier),
    );
    if (
      !relativeToPackage.startsWith('src/') &&
      !relativeToPackage.startsWith('dist/')
    ) {
      return specifier;
    }

    let subpath = relativeToPackage.replace(/^(src|dist)\//, '');
    subpath = subpath
      .replace(/\.d\.ts$/, '')
      .replace(/\.[mc]?ts$/, '')
      .replace(/\.js$/, '');

    if (subpath === 'index') {
      return targetPackage.name;
    }

    if (subpath.endsWith('/index')) {
      subpath = subpath.slice(0, -'/index'.length);
    }

    return `${targetPackage.name}/${subpath}`;
  };

  return content
    .replace(
      /(from\s+['"])([^'"]+)(['"])/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${rewriteSpecifier(specifier)}${suffix}`,
    )
    .replace(
      /(import\(\s*['"])([^'"]+)(['"]\s*\))/g,
      (_match, prefix: string, specifier: string, suffix: string) =>
        `${prefix}${rewriteSpecifier(specifier)}${suffix}`,
    );
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
  const workspacePackages = collectWorkspacePackages(
    resolve(__dirname, 'packages'),
  );
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
        typeof import('@happyvertical/smrt-core/vite-plugin')
      >({
        packageName: '@happyvertical/smrt-core/vite-plugin',
        distEntry: 'packages/core/dist/vite-plugin.js',
        sourceEntry: 'packages/core/src/vite-plugin/index.ts',
        purpose: 'shared SMRT package build configuration',
      });
      smrtPlugin = plugin;
    }

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
            '@libsql/client',
            'fast-glob',
            'minimatch',
            'oxc-parser',
            'oxc-resolver',

            // Internal SMRT packages - externalize to avoid cross-package bundling
            /^@happyvertical\//,

            // External SDK packages
            /^@have\//,

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
        dts({
          outDir: resolve(packageDir, 'dist'),
          entryRoot: resolve(packageDir, 'src'),
          include: [resolve(packageDir, 'src/**/*.ts')],
          exclude: [
            // Test files
            '**/*.test.ts',
            '**/*.spec.ts',
            '**/*.test.*.ts',
            // Config files
            '**/*.config.ts',
            '**/*.config.js',
            // Declaration files
            '**/*.d.ts',
            // Svelte dir is handled by svelte-package
            ...(options.svelte ? [`**/${options.svelte}/**`] : []),
            ...(options.dtsExclude ?? []),
          ],
          insertTypesEntry: false, // We handle this in package.json
          // Don't rollup types when svelte subdir exists (separate entry points)
          rollupTypes: !options.svelte,
          // Prefer a package-specific build tsconfig when present so workspace
          // source resolution stays clean without requiring sibling dist output.
          tsconfigPath,
          // Fail the build on TS error-level diagnostics during dts
          // generation when opted in. Without this, `vite-plugin-dts`
          // prints errors to stderr but still emits and exits 0, which
          // means TS errors in package source can ship to npm (see PR
          // #1129 / #1130).
          ...(options.strictDts
            ? {
                afterDiagnostic: (diagnostics) => {
                  // 1 === ts.DiagnosticCategory.Error; inlined so this
                  // file does not need to import `typescript` for a
                  // single numeric enum.
                  const errors = diagnostics.filter((d) => d.category === 1);
                  if (errors.length > 0) {
                    throw new Error(
                      `vite-plugin-dts: ${errors.length} TypeScript error(s) during declaration generation. See log above.`,
                    );
                  }
                },
              }
            : {}),
          beforeWriteFile: (filePath, content) => ({
            filePath,
            content: rewriteWorkspaceDeclarationImports(
              filePath,
              content,
              packageDir,
              workspacePackages,
            ),
          }),
        }),
      ],
    } satisfies UserConfig;
  };
}
