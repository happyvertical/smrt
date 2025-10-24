import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      rollupTypes: true,
    }),
  ],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: [
        '@modelcontextprotocol/sdk',
        '@happyvertical/ai',
        '@happyvertical/files',
        '@happyvertical/utils',
        'node:fs',
        'node:fs/promises',
        'node:path',
        'node:url',
        'node:process',
      ],
    },
    target: 'esnext',
    minify: false,
    sourcemap: true,
  },
});
