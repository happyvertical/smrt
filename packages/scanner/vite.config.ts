import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        cli: resolve(__dirname, 'src/cli.ts'),
        types: resolve(__dirname, 'src/types.ts'),
      },
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        /^node:/,
        'oxc-parser',
        'oxc-resolver',
        'fast-glob',
        'minimatch',
        '@happyvertical/smrt-core',
        '@happyvertical/smrt-types',
      ],
    },
    target: 'node20',
    sourcemap: true,
    minify: false,
  },
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
    }),
  ],
});
