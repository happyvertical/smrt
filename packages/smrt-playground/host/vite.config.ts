import { resolve } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { smrtPlaygroundVitePlugin } from '@happyvertical/smrt-playground/vite';

export default defineConfig({
  esbuild: {
    // Workspace playground modules should not depend on each child package's
    // local `.svelte-kit` state just to transpile TypeScript metadata files.
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    }),
  },
  resolve: {
    alias: [
      {
        find: /^@happyvertical\/smrt-playground\/svelte$/,
        replacement: resolve(__dirname, '../src/svelte/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-playground\/vite$/,
        replacement: resolve(__dirname, '../src/vite.ts'),
      },
      {
        find: /^@happyvertical\/smrt-playground$/,
        replacement: resolve(__dirname, '../src/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/themes$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/themes/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/layout$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/components/layout/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/ui$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/components/ui/index.ts'),
      },
      {
        find: /^@happyvertical\/smrt-svelte\/registry$/,
        replacement: resolve(__dirname, '../../smrt-svelte/src/registry/index.ts'),
      },
    ],
  },
  plugins: [smrtPlaygroundVitePlugin({ mode: 'workspace' }), sveltekit()],
  server: {
    port: 5560,
  },
});
