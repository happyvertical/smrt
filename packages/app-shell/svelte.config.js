import adapter from '@sveltejs/adapter-node';
import { rename, writeFile } from 'node:fs/promises';
import { IMPORT_MAX_BYTES } from './src/lib/import-limits.ts';

const nodeAdapter = adapter();
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: {
      ...nodeAdapter,
      async adapt(builder) {
        await nodeAdapter.adapt(builder);
        // Both `node build` and the desktop sidecar enter here, before handler imports
        // capture adapter-node's default 512 KiB BODY_SIZE_LIMIT.
        await rename('build/index.js', 'build/server-start.js');
        await writeFile('build/index.js', `process.env.BODY_SIZE_LIMIT ??= '${IMPORT_MAX_BYTES}';\nawait import('./server-start.js');\n`);
      },
    },
    alias: { $lib: 'src/lib' },
  },
};
