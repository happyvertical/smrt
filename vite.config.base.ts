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

  return defineConfig({
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
          /^@smrt\//,

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
        rollupTypes: false,
        // Use package-specific tsconfig
        tsconfigPath: resolve(packageDir, 'tsconfig.json'),
      }),
    ],
  });
}
