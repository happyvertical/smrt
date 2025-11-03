import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [
        '@happyvertical/smrt-core',
        '@happyvertical/smrt-core/generators',
        '@happyvertical/smrt-core/manifest',
        '@happyvertical/smrt-core/prebuild',
        '@happyvertical/smrt-core/scanner',
        '@happyvertical/smrt-types',
        '@happyvertical/utils',
        'fast-glob',
        'tar',
        'node:fs',
        'node:fs/promises',
        'node:path',
        'node:process',
        'node:readline',
        'node:url',
        'node:child_process',
        'node:https',
        'node:os',
      ],
    },
    target: 'node24',
    outDir: 'dist',
  },
  plugins: [
    dts({
      rollupTypes: true,
      bundledPackages: [],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
  },
});
