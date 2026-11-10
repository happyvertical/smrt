import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Fully static output: every route is prerendered; `404.html` lets a static
    // host serve the app shell for any path that was not generated.
    adapter: adapter({ fallback: '404.html' }),
    // Set BASE_PATH (e.g. /smrt-planner) when hosting under a sub-path.
    typescript: {
      // Typecheck the catalog generator script alongside the app.
      config: (config) => ({
        ...config,
        include: [...config.include, '../scripts/**/*.ts'],
      }),
    },
    paths: { base: process.env.BASE_PATH ?? '' },
  },
};

export default config;
