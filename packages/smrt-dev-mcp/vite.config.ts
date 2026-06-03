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
      entry: {
        index: 'src/index.ts',
        knowledge: 'src/knowledge/index.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        /^@modelcontextprotocol\/sdk/,
        /^@happyvertical\/smrt-core/,
        /^@happyvertical\/ai/,
        /^@happyvertical\/files/,
        /^@happyvertical\/utils/,
        /^node:/,
      ],
    },
    target: 'esnext',
    minify: false,
    sourcemap: true,
  },
});
