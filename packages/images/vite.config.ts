import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Using the SMRT vite plugin to inject models and endpoints into SvelteKit
export default defineConfig(async () => {
  const { smrtPlugin } = await import('@happyvertical/smrt-core/vite-plugin');
  
  return {
    plugins: [
      sveltekit(),
      smrtPlugin({
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.spec.ts', 'src/svelte/**/*', 'src/routes/**/*', '**/*.svelte'],
        generateTypes: false,
        svelteKit: {
          enabled: true,
          routesDir: 'src/routes/api',
          objectsDir: 'src/models',
        },
      }),
    ],
  };
});
