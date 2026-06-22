// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). The actual build is via svelte-package
// (see package.json `build` script); this vite config is only used by Vitest.

import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
    },
    rollupOptions: {
      external: ['svelte', /^svelte\//],
    },
  },
});
