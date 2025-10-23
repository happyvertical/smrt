import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';

const packageDir = resolve(__dirname);

export default defineConfig({
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
        /^node:/,
        /^@happyvertical\//,
        /^@have\//,
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
    // Generate AST manifest for SMRT objects
    smrtPlugin({
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts'],
      generateTypes: true,
      hmr: false, // Disable HMR for library builds
    }),
    // Generate TypeScript declarations
    dts({
      outDir: resolve(packageDir, 'dist'),
      include: [resolve(packageDir, 'src/**/*.ts')],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.ts', '**/*.d.ts'],
      insertTypesEntry: false,
      rollupTypes: true,
      tsconfigPath: resolve(packageDir, 'tsconfig.json'),
    }),
  ],
});
