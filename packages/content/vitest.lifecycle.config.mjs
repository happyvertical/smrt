import { svelte } from '@sveltejs/vite-plugin-svelte';
import { transformWithOxc } from 'vite';

const testTypeScript = {
  name: 'content-lifecycle-test-typescript',
  enforce: 'pre',
  async transform(code, id) {
    if (!id.endsWith('.ts')) return undefined;
    return transformWithOxc(code, id, {
      lang: 'ts',
      tsconfig: false,
    });
  },
};

export default {
  root: new URL('../..', import.meta.url).pathname,
  oxc: false,
  plugins: [testTypeScript, svelte()],
  resolve: { conditions: ['browser'] },
  optimizeDeps: { noDiscovery: true, include: [] },
  test: {
    environment: 'node',
    include: [
      'packages/content/src/svelte/content-list-lifecycle.test.ts',
      'packages/content/src/svelte/components/ContentListLifecyclePanel.test.ts',
      'packages/content/src/svelte/components/ContentList.lifecycle.test.ts',
    ],
    setupFiles: ['packages/vitest/src/svelte-setup.ts'],
  },
};
