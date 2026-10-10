// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). Core uses a custom getCoreEntries()
// helper that reads the package.json exports map to enumerate entries,
// preserveModules:true to keep the runtime/scanner/vite-plugin layout
// loadable as separate JS modules from consumer projects, and a much
// larger external allowlist than the base config exposes (oxc-* packages,
// @huggingface/transformers etc). Migration would require extending
// createPackageConfig with at least: per-package preserveModules toggle,
// programmatic entry derivation from exports map, and arbitrary external
// passthrough.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { declarations } from '../../scripts/declarations.js';

// Function to read core package exports and generate entries
export function getCoreEntries() {
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
    // A directory index export (`./dist/cookbook/index.js`) keeps its path so
    // the built file lands where the exports map points.
    const entryName =
      key === '.'
        ? 'index'
        : exportPath.endsWith('/index.js')
          ? exportPath.replace(/^\.\/dist\//, '').replace(/\.js$/, '')
          : key.replace(/^\.\//, '');

    // Convert dist path to source path: './dist/fields.js' → 'src/fields.ts'
    const sourcePath = exportPath
      .replace(/^\.\/dist\//, 'src/')
      .replace(/\.js$/, '.ts');

    entries[entryName] = resolve(__dirname, sourcePath);
  }

  // Also add browser entry point
  entries['browser'] = resolve(__dirname, 'src/browser.ts');
  // Browser variants selected through `package.json#browser`; nothing imports
  // them, so the module graph alone would not emit them.
  entries['host.browser'] = resolve(__dirname, 'src/host.browser.ts');
  entries['utils/json.browser'] = resolve(__dirname, 'src/utils/json.browser.ts');
  // The runtime static manifest is required by manifest-loader but is not a
  // public package export, so include it explicitly in the build graph.
  entries['manifest/static-manifest'] = resolve(
    __dirname,
    'src/manifest/static-manifest.ts',
  );

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

        // OXC native packages (Rust parser and transformer)
        'oxc-parser',
        'oxc-resolver',
        'oxc-transform',
        /^@oxc-project\//,

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
    declarations({
      packageDir: __dirname,
      exclude: [
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/*.config.ts',
        '**/__test-consumer-*/**',
        // Test generation owns this artifact; templates ship as source text.
        'src/manifest/test-manifest-stub.ts',
        'src/vite-plugin/templates/**',
      ],
    }),
  ],
});
