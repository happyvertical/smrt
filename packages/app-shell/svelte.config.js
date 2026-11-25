import adapter from '@sveltejs/adapter-node';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
        // Both `node build` and the desktop sidecar enter at build/index.js,
        // which raises BODY_SIZE_LIMIT before handler imports capture
        // adapter-node's default 512 KiB, owns the shutdown (tools/start-entry.js)
        // and starts adapter-node's listener (kept as server-start.js).
        // build/embed.js is the same handler without a listener, plus the
        // drain, for a host that owns both (tools/embed-entry.js, #5546).
        // build/operator.js runs one operator command and exits
        // (tools/operator-entry.js, #5193).
        await rename('build/index.js', 'build/server-start.js');
        const limit = String(IMPORT_MAX_BYTES);
        for (const [from, to] of [
          ['tools/start-entry.js', 'build/index.js'],
          ['tools/embed-entry.js', 'build/embed.js'],
          ['tools/operator-entry.js', 'build/operator.js'],
        ]) {
          // Beside this config, whatever the build's working directory is.
          const text = await readFile(
            fileURLToPath(new URL(`./${from}`, import.meta.url)),
            'utf8',
          );
          await writeFile(to, text.replaceAll('__IMPORT_MAX_BYTES__', limit));
        }
      },
    },
    alias: { $lib: 'src/lib' },
  },
};
