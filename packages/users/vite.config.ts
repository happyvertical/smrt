import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
        sveltekit: resolve(__dirname, 'src/sveltekit/index.ts'),
      },
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
        // External SDK packages
        /^@happyvertical\//,
        // SvelteKit
        /^@sveltejs\//,
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
      ],
      insertTypesEntry: false,
      rollupTypes: false,
      tsconfigPath: resolve(__dirname, 'tsconfig.json'),
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
  },
});
