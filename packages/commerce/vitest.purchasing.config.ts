import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
/** Isolated purchasing SSR contract suite; model tests keep their existing config. */
export default defineConfig({
 root:new URL('.',import.meta.url).pathname,
 plugins:[smrtVitestPlugin(),svelte()],
 test:{environment:'node',include:['test-support/purchasing-*.spec.ts'],fileParallelism:false,pool:'forks'},
});
