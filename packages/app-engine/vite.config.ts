// Preserve module adjacency: AppHost discovers the worker next to host.js.
import { defineConfig } from 'vite';
import { declarations } from '../../scripts/declarations.js';

export default defineConfig({
  plugins: [declarations({ packageDir: import.meta.dirname })],
  build: {
    lib: {
      entry: { index: 'src/index.ts', 'app-worker': 'src/app-worker.ts' },
      formats: ['es'],
    },
    ssr: true,
    target: 'node26',
    rollupOptions: {
      external: [/^node:/, /^@happyvertical\//, 'quickjs-emscripten'],
      output: { preserveModules: true, preserveModulesRoot: 'src', entryFileNames: '[name].js' },
    },
  },
});
