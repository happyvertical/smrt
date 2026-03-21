import { resolve } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig(async ({ mode }) => {
  // Library build mode (used by `pnpm run build`)
  if (mode === 'library') {
    const { createPackageConfig } = await import('../../vite.config.base.js');
    // Delegate to the shared package config which handles entry points,
    // externals, dts generation, and svelte-package exclusion.
    const config = createPackageConfig('content', {
      entries: ['ui', 'mock-smrt-client'],
      svelte: 'svelte'
    });
    // createPackageConfig returns a UserConfigExport; resolve it
    const resolved = typeof config === 'function' ? await (config as any)({ mode, command: 'build' }) : config;
    return resolved;
  }

  // SvelteKit dev mode (used by `pnpm run dev`)
  const { smrtPlugin } = await import('@happyvertical/smrt-core/vite-plugin');

  return {
    resolve: {
      alias: {
        '@happyvertical/smrt-facts': resolve(
          __dirname,
          '../facts/src/index.ts',
        ),
        '@happyvertical/smrt-messages': resolve(
          __dirname,
          '../messages/src/index.ts',
        ),
        '@happyvertical/smrt-profiles': resolve(
          __dirname,
          '../profiles/src/index.ts',
        ),
      },
    },
    plugins: [
      sveltekit(),
      smrtPlugin({
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.spec.ts', 'src/svelte/**/*', 'src/routes/**/*', '**/*.svelte'],
        generateTypes: false,
        svelteKit: {
          enabled: true,
          routesDir: 'src/routes/api/v1',
          objectsDir: 'src/models',
        },
      }),
    ],
  };
});
