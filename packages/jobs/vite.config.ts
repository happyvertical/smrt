import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageDir = resolve(import.meta.dirname);

export default defineConfig(async () => {
  const { smrtPlugin } = await import('../../packages/core/src/vite-plugin/index.js');

  return {
    build: {
      lib: {
        entry: {
          index: resolve(packageDir, 'src/index.ts'),
          runner: resolve(packageDir, 'src/runner.ts'),
          ui: resolve(packageDir, 'src/ui.ts'),
        },
        formats: ['es'],
      },
      rollupOptions: {
        output: {
          dir: resolve(packageDir, 'dist'),
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
      smrtPlugin({
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.spec.ts'],
        generateTypes: true,
        hmr: false,
      }),
      dts({
        outDir: resolve(packageDir, 'dist'),
        include: [resolve(packageDir, 'src/**/*.ts')],
        exclude: ['**/*.test.ts', '**/*.spec.ts'],
        insertTypesEntry: false,
        rollupTypes: false,
        tsconfigPath: resolve(packageDir, 'tsconfig.json'),
      }),
    ],
    test: {
      globals: true,
      environment: 'node',
      testTimeout: 30000,
    },
  };
});
