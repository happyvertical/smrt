import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

// Function to read core package exports and generate entries
function getCoreEntries() {
  const pkgPath = resolve(__dirname, 'packages/core/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  const entries: Record<string, string> = {};

  for (const [key, value] of Object.entries(
    pkg.exports as Record<string, string>,
  )) {
    // Convert export key to entry name: '.' → 'index', './fields' → 'fields'
    const entryName = key === '.' ? 'index' : key.replace(/^\.\//, '');

    // Convert dist path to source path: './dist/fields.js' → 'src/fields.ts'
    const sourcePath = value
      .replace(/^\.\/dist\//, 'src/')
      .replace(/\.js$/, '.ts');

    entries[entryName] = resolve(__dirname, `packages/core/${sourcePath}`);
  }

  return entries;
}

// Function to create per-package build configuration
function createPackageBuild(packageName: string, entryPath: string) {
  // Special handling for core package with multiple entry points
  if (packageName === 'core') {
    const entries = getCoreEntries();

    return {
      lib: {
        entry: entries,
        formats: ['es'] as const,
      },
      rollupOptions: {
        output: {
          dir: `packages/${packageName}/dist`,
          format: 'es' as const,
          preserveModules: false, // Bundle entry points for smrt
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
          'svelte',
          'vite',
          'vitest',
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

          // Internal SMRT packages
          '@have/types',
          '@have/core',

          // External SDK packages
          '@have/utils',
          '@have/logger',
          '@have/files',
          '@have/sql',
          '@have/ai',

          // Virtual modules from SMRT framework
          '@smrt/types',
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
    };
  }

  // Standard configuration for all other packages
  return {
    lib: {
      entry: resolve(__dirname, entryPath),
      formats: ['es'] as const,
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: {
        dir: `packages/${packageName}/dist`,
        format: 'es' as const,
        preserveModules: false,
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
        'svelte',
        'vite',
        'vitest',
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

        // Internal SMRT packages
        '@have/types',
        '@have/core',

        // External SDK packages
        '@have/utils',
        '@have/logger',
        '@have/files',
        '@have/sql',
        '@have/ai',

        // Infrastructure packages (used by some modules)
        '@have/cache',
        '@have/config',
        '@have/documents',
        '@have/geo',
        '@have/translator',
        '@have/ocr',
        '@have/pdf',
        '@have/spider',
      ],
    },
    minify: false,
    sourcemap: true,
    target: 'es2022',
    reportCompressedSize: false,
  };
}

// Package configurations with entry points
const packages = [
  { name: 'types', entry: 'packages/types/src/index.ts' },
  { name: 'core', entry: 'packages/core/src/index.ts' },

  // Domain modules
  { name: 'accounts', entry: 'packages/accounts/src/index.ts' },
  { name: 'agents', entry: 'packages/agents/src/index.ts' },
  { name: 'assets', entry: 'packages/assets/src/index.ts' },
  { name: 'content', entry: 'packages/content/src/index.ts' },
  { name: 'events', entry: 'packages/events/src/index.ts' },
  { name: 'gnode', entry: 'packages/gnode/src/index.ts' },
  { name: 'places', entry: 'packages/places/src/index.ts' },
  { name: 'products', entry: 'packages/products/src/index.ts' },
  { name: 'profiles', entry: 'packages/profiles/src/index.ts' },
  { name: 'tags', entry: 'packages/tags/src/index.ts' },
];

export default defineConfig(({ command, mode }) => {
  // For build command, build specified package
  if (command === 'build') {
    const targetPackage = process.env.VITE_BUILD_PACKAGE;

    if (targetPackage) {
      const pkg = packages.find((p) => p.name === targetPackage);
      if (!pkg) {
        throw new Error(`Package ${targetPackage} not found`);
      }

      return {
        build: createPackageBuild(pkg.name, pkg.entry),
        plugins: [
          dts({
            outDir: `packages/${pkg.name}/dist`,
            include: [`packages/${pkg.name}/src/**/*.ts`],
            exclude: [
              `packages/${pkg.name}/src/**/*.test.ts`,
              `packages/${pkg.name}/src/**/*.spec.ts`,
              `packages/${pkg.name}/src/**/*.test.*.ts`,
              '**/*.config.ts',
              '**/*.config.js',
              `packages/${pkg.name}/src/**/*.d.ts`,
            ],
            insertTypesEntry: false,
            rollupTypes: false,
            tsconfigPath: resolve(
              __dirname,
              `packages/${pkg.name}/tsconfig.build.json`,
            ),
          }),
        ],
        resolve: {
          alias: {
            '@have/types': resolve(__dirname, 'packages/types/src'),
            '@have/core': resolve(__dirname, 'packages/core/src'),
            '@have/accounts': resolve(__dirname, 'packages/accounts/src'),
            '@have/agents': resolve(__dirname, 'packages/agents/src'),
            '@have/assets': resolve(__dirname, 'packages/assets/src'),
            '@have/content': resolve(__dirname, 'packages/content/src'),
            '@have/events': resolve(__dirname, 'packages/events/src'),
            '@have/gnode': resolve(__dirname, 'packages/gnode/src'),
            '@have/places': resolve(__dirname, 'packages/places/src'),
            '@have/products': resolve(__dirname, 'packages/products/src'),
            '@have/profiles': resolve(__dirname, 'packages/profiles/src'),
            '@have/tags': resolve(__dirname, 'packages/tags/src'),
          },
        },
      };
    }

    throw new Error(
      'Use package-specific build scripts. Set VITE_BUILD_PACKAGE environment variable.',
    );
  }

  // Development configuration
  return {
    resolve: {
      alias: {
        '@have/types': resolve(__dirname, 'packages/types/src'),
        '@have/core': resolve(__dirname, 'packages/core/src'),
        '@have/accounts': resolve(__dirname, 'packages/accounts/src'),
        '@have/agents': resolve(__dirname, 'packages/agents/src'),
        '@have/assets': resolve(__dirname, 'packages/assets/src'),
        '@have/content': resolve(__dirname, 'packages/content/src'),
        '@have/events': resolve(__dirname, 'packages/events/src'),
        '@have/gnode': resolve(__dirname, 'packages/gnode/src'),
        '@have/places': resolve(__dirname, 'packages/places/src'),
        '@have/products': resolve(__dirname, 'packages/products/src'),
        '@have/profiles': resolve(__dirname, 'packages/profiles/src'),
        '@have/tags': resolve(__dirname, 'packages/tags/src'),
      },
    },
    optimizeDeps: {
      include: [
        '@paralleldrive/cuid2',
        'date-fns',
        'pluralize',
        'uuid',
        'yaml',
      ],
    },
  };
});
