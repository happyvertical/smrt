import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

/**
 * Shared Vite configuration factory for all SMRT packages
 *
 * Creates a standardized build configuration for Node.js-only packages
 * with TypeScript declaration generation.
 *
 * Adapted from @have/sdk vite.config.base.ts pattern (PR 238)
 */
export function createPackageConfig(packageName: string) {
  const packageDir = resolve(__dirname, 'packages', packageName);

  // Packages that should NOT use smrtPlugin (framework infrastructure)
  const skipSmrtPlugin = ['core', 'types', 'config'];

  return defineConfig(async () => {
    // Dynamically import smrtPlugin only if needed
    const shouldUseSmrtPlugin = !skipSmrtPlugin.includes(packageName);
    let smrtPlugin = null;

    if (shouldUseSmrtPlugin) {
      const { smrtPlugin: plugin } = await import(
        './packages/core/src/vite-plugin/index.js'
      );
      smrtPlugin = plugin;
    }

    return {
      build: {
        lib: {
          entry: resolve(packageDir, 'src/index.ts'),
          formats: ['es'] as const,
          fileName: () => 'index.js',
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
            '@langchain/community',
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

            // Internal SMRT packages - externalize to avoid cross-package bundling
            /^@happyvertical\//,

            // External SDK packages
            /^@have\//,

            // Virtual modules from SMRT framework
            '@smrt/routes',
            '@smrt/client',
            '@smrt/mcp',
            '@smrt/manifest',
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
          ],
          insertTypesEntry: false, // We handle this in package.json
          rollupTypes: true, // Bundle types to preserve type-only exports
          // Use package-specific tsconfig
          tsconfigPath: resolve(packageDir, 'tsconfig.json'),
        }),
      ],
    };
  });
}
