import { resolve } from 'node:path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// Isolated bundle-cost measurement for the spike (#1756). Not part of any
// package build; run manually via:
//   npx vite build --config .spike-measure/vite.measure.mts
const dir = resolve(import.meta.dirname);
const entry = process.env.MEASURE_ENTRY ?? 'entry-tanstack.ts';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: resolve(dir, 'out', entry.replace(/\W/g, '_')),
    emptyOutDir: true,
    target: 'es2022',
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve(dir, entry),
      output: { entryFileNames: 'bundle.js' },
    },
  },
});
