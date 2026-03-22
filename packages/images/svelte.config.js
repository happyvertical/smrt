import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { svelteKitWorkspaceAliases } from './workspace-aliases.js';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    outDir: '.svelte-kit',
    alias:
      process.env.SMRT_PACKAGE_BUILD === '1' ? {} : svelteKitWorkspaceAliases,
  },
  compilerOptions: {
    runes: true,
  },
};

export default config;
