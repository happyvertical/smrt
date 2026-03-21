import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageDir = __dirname;

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(packageDir, 'src/index.ts'),
        vite: resolve(packageDir, 'src/vite.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        /^node:/,
        'fs',
        'path',
        'url',
        'svelte',
        /^svelte\//,
        'vite',
        /^vite\//,
        'fast-glob',
        '@happyvertical/smrt-svelte',
        /^@happyvertical\/smrt-svelte\//,
      ],
      output: {
        dir: resolve(packageDir, 'dist'),
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
    minify: false,
    sourcemap: true,
    target: 'es2022',
  },
  plugins: [
    dts({
      outDir: resolve(packageDir, 'dist'),
      entryRoot: resolve(packageDir, 'src'),
      include: [resolve(packageDir, 'src/**/*.ts')],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/svelte/**'],
      rollupTypes: false,
      tsconfigPath: resolve(packageDir, 'tsconfig.json'),
    }),
  ],
});
