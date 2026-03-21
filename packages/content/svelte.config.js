import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { svelteKitWorkspaceAliases } from './workspace-aliases.js';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		outDir: '.svelte-kit',
		alias: svelteKitWorkspaceAliases
	}
};

export default config;
