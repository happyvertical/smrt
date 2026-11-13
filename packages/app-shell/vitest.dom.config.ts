// Component tests for the shell's layout (jsdom). They mount the real
// `+layout.svelte` over smrt-svelte's built `AppShell`; `$app/*` are stubs.
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
    alias: {
      $lib: here('./src/lib'),
      '$app/forms': here('./src/test/app-forms.ts'),
      '$app/state': here('./src/test/app-state.ts'),
      '$app/navigation': here('./src/test/app-navigation.ts'),
    },
  },
  test: {
    globalSetup: ['../vitest/src/test-home.global-setup.ts'],
    globals: true,
    environment: 'jsdom',
    // jsdom's storage under Node 26 (the host accessor shadows it).
    setupFiles: ['@happyvertical/smrt-ui/test-support/setup'],
    include: ['src/**/*.dom.test.ts'],
    testTimeout: 30000,
  },
});
