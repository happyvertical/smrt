// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). Secrets ships submodule exports
// (./models, ./service) backed by separate dist entries that downstream
// consumers import via type-import paths like
// `dist/models/index.d.ts -> ./SecretAuditLog.js`. The base config's
// rollupTypes:true bundles all types into a single d.ts per entry,
// which produces a different type-import structure that fails
// `verify:pack` for this package. Migration would require base config
// to support per-entry rollupTypes:false plus entryRoot, or this
// package's published surface needs to be re-shaped to a single entry.

import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageDir = resolve(__dirname);

export default defineConfig(async () => {
  const { importWorkspaceModule } = await import(
    '../core/src/utils/import-workspace-module.js'
  );
  const { smrtPlugin } = await importWorkspaceModule<
    typeof import('@happyvertical/smrt-core/vite-plugin')
  >({
    packageName: '@happyvertical/smrt-core/vite-plugin',
    distEntry: 'packages/core/dist/vite-plugin.js',
    sourceEntry: 'packages/core/src/vite-plugin/index.ts',
    purpose: 'secrets package Vite config',
  });

  return {
    build: {
      lib: {
        entry: {
          index: resolve(packageDir, 'src/index.ts'),
          'models/index': resolve(packageDir, 'src/models/index.ts'),
          'services/SecretService': resolve(
            packageDir,
            'src/services/SecretService.ts',
          ),
        },
        formats: ['es'] as const,
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
          '@happyvertical/sql',
          '@happyvertical/utils',
          '@happyvertical/ai',
          '@happyvertical/smrt-core',
          '@happyvertical/smrt-tenancy',
          '@happyvertical/smrt-types',
          '@happyvertical/secrets',
        ],
      },
      minify: false,
      sourcemap: true,
      target: 'es2022',
      reportCompressedSize: false,
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
        entryRoot: resolve(packageDir, 'src'),
        include: [resolve(packageDir, 'src/**/*')],
        exclude: ['**/*.test.ts', '**/*.spec.ts'],
        insertTypesEntry: false,
        rollupTypes: false,
        tsconfigPath: resolve(packageDir, 'tsconfig.json'),
        clearPureImport: true,
      }),
    ],
  };
});
