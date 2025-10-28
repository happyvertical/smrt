import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  if (mode === 'test') {
    // Test app configuration
    return {
      root: 'test-app',
      plugins: [
        svelte({
          compilerOptions: {
            runes: true
          }
        })
      ],
      resolve: {
        alias: {
          '@': resolve(__dirname, 'src')
        }
      }
    };
  }

  // Library build configuration
  return {
    plugins: [
      svelte({
        compilerOptions: {
          runes: true
        }
      })
    ],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/lib/index.ts'),
        name: 'SmrtSvelte',
        fileName: 'index'
      },
      rollupOptions: {
        external: ['svelte', 'svelte/internal', 'svelte/store', 'svelte/transition', 'svelte/animate'],
        output: {
          globals: {
            svelte: 'svelte'
          }
        }
      }
    }
  };
});
