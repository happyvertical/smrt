import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [/^node:/, /^@happyvertical\//],
    },
    sourcemap: true,
    target: 'es2022',
  },
  plugins: [
    dts({
      outDir: resolve(__dirname, 'dist'),
      include: [resolve(__dirname, 'src/**/*.ts')],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.ts'],
      insertTypesEntry: false,
      rollupTypes: true,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],
});
