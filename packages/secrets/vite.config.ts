import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageDir = resolve(__dirname);
const sdkSecretsPath = resolve(__dirname, '../../../sdk/packages/secrets/dist/index.js');

export default defineConfig(async () => {
  // Dynamically import smrtPlugin
  const { smrtPlugin } = await import(
    '../../packages/core/src/vite-plugin/index.js'
  );

  return {
    resolve: {
      alias: {
        '@happyvertical/secrets': sdkSecretsPath,
      },
    },
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
          // External dependencies
          '@happyvertical/sql',
          '@happyvertical/utils',
          '@happyvertical/ai',
          '@happyvertical/smrt-core',
          '@happyvertical/smrt-tenancy',
          '@happyvertical/smrt-types',
          '@happyvertical/secrets',
        ],
      },
    },
    plugins: [
      smrtPlugin({
        packageDir,
        scanDirs: [resolve(packageDir, 'src')],
        generate: {
          types: true,
        },
      }),
      dts({
        outDir: resolve(packageDir, 'dist'),
        include: [resolve(packageDir, 'src/**/*')],
        exclude: ['**/*.test.ts', '**/*.spec.ts'],
        rollupTypes: true,
        tsconfigPath: resolve(packageDir, 'tsconfig.json'),
        clearPureImport: true,
      }),
    ],
  };
});
