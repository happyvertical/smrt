import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// Function to read core package exports and generate entries
function getCoreEntries() {
  const pkgPath = resolve(__dirname, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const entries: Record<string, string> = {};

  for (const [key, value] of Object.entries(
    pkg.exports as Record<string, string | Record<string, string>>,
  )) {
    // Skip JSON exports - they are data files, not modules to build
    if (key.endsWith('.json')) {
      continue;
    }

    // Handle conditional exports (objects with browser/default keys)
    let exportPath: string;
    if (typeof value === 'object' && value !== null) {
      // Use 'default' export for build (Node.js entry point)
      exportPath = value.default || value.browser || '';
    } else {
      exportPath = value as string;
    }

    // Skip non-JS exports (e.g., JSON files)
    if (!exportPath.endsWith('.js')) {
      continue;
    }

    // Convert export key to entry name: '.' → 'index', './fields' → 'fields'
    const entryName = key === '.' ? 'index' : key.replace(/^\.\//, '');

    // Convert dist path to source path: './dist/fields.js' → 'src/fields.ts'
    const sourcePath = exportPath
      .replace(/^\.\/dist\//, 'src/')
      .replace(/\.js$/, '.ts');

    entries[entryName] = resolve(__dirname, sourcePath);
  }

  // Also add browser entry point
  entries['browser'] = resolve(__dirname, 'src/browser.ts');

  return entries;
}

// Core package has multiple entry points, so needs custom configuration
export default defineConfig({
  build: {
    lib: {
      entry: getCoreEntries(),
      formats: ['es'] as const,
    },
    rollupOptions: {
      output: {
        dir: resolve(__dirname, 'dist'),
        format: 'es' as const,
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
      external: [
        // Node.js built-ins
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

        // External dependencies
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
        'tar',
        'vite',
        /^vite\//,
        'chokidar',
        'fsevents',
        'fast-glob',
        'micromatch',
        'picomatch',
        'braces',
        'fill-range',
        'to-regex-range',

        // Internal SMRT packages
        /^@smrt\//,

        // External SDK packages
        /^@have\//,
        /^@happyvertical\//,

        // Virtual modules
        '@smrt/routes',
        '@smrt/client',
        '@smrt/mcp',
        '@smrt/manifest',
      ],
    },
    minify: false,
    sourcemap: true,
    target: 'es2022',
    reportCompressedSize: false,
  },
  plugins: [
    dts({
      outDir: resolve(__dirname, 'dist'),
      include: [resolve(__dirname, 'src/**/*.ts')],
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.config.ts',
        '**/*.config.js',
        '**/*.d.ts',
        // Exclude browser template - loaded as string, not compiled
        'src/vite-plugin/templates/default-ui.ts',
      ],
      insertTypesEntry: false,
      rollupTypes: false,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    poolMatchGlobs: [
      [
        // Scanner tests are slower and hang with 'forks' in CI.
        // Run them in 'threads' pool with longer timeout.
        'src/scanner/scanner.test.ts',
        'threads',
      ],
      [
        // All other tests use 'forks' pool for performance
        '**/*.test.ts',
        'forks',
      ],
    ],
    testTimeout: 30000, // Scanner tests need longer timeout in CI
  },
});
