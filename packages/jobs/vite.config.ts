import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        runner: resolve(__dirname, 'src/runner.ts'),
        ui: resolve(__dirname, 'src/ui.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        dir: resolve(__dirname, 'dist'),
        format: 'es',
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
      external: [
        // Node.js built-ins
        /^node:/,
        'events',
        'path',
        'fs',
        'url',
        'os',
        'crypto',

        // External SDK packages
        /^@happyvertical\//,

        // Internal SMRT packages
        /^@smrt\//,
      ],
    },
    minify: false,
    sourcemap: true,
    target: 'es2022',
  },
  plugins: [
    dts({
      outDir: resolve(__dirname, 'dist'),
      include: [resolve(__dirname, 'src/**/*.ts')],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      insertTypesEntry: false,
      rollupTypes: false,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
  },
});
