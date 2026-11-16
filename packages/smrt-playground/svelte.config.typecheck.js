import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import config from './svelte.config.js';

// CSS checks over sibling source must not start the Vite runtime plugins that
// generate manifests for application builds.
export default {
  ...config,
  preprocess: vitePreprocess({ style: { configFile: false } }),
};
