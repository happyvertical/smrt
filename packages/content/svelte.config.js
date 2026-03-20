import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		outDir: '.svelte-kit',
		alias: {
			'@happyvertical/smrt-facts': './src/workspace-facts.ts'
		}
	}
};

export default config;
