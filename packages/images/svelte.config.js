import adapter from '@sveltejs/adapter-auto';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { svelteKitWorkspaceAliases } from './workspace-aliases.js';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    outDir: '.svelte-kit',
    alias: svelteKitWorkspaceAliases,
  },
  compilerOptions: {
    runes: true,
  },
};

export default config;
