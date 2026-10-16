import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [sveltekit()],
  // One smrt-ui (and one Svelte) for the tests as for the app: a linked
  // smrt-svelte (vite.config.ts's local aliases, a QA override) would
  // otherwise bring its own copy, and contexts set by one are invisible to
  // the other ("Theme context not found").
  resolve: { dedupe: ['svelte', '@happyvertical/smrt-ui'] },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.dom.test.ts'],
        },
      },
      {
        // `*.dom.test.ts` mount components: a DOM and Svelte's browser build.
        extends: true,
        resolve: { conditions: ['browser'] },
        test: {
          name: 'dom',
          include: ['tests/**/*.dom.test.ts'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
