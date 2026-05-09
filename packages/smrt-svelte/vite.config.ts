// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3). The actual build is via svelte-package
// (see package.json `build` script: `svelte-package -i src --tsconfig
// tsconfig.svelte.json`); this vite config is only used by the playground
// dev server and Vitest. Migration would replace it with a
// createPackageConfig({ svelte: 'src' }) call once the test runner is
// happy with workspace svelte resolution.

import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es']
    },
    rollupOptions: {
      external: ['svelte', /^svelte\//]
    }
  }
});
