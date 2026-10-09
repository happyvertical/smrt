import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({plugins:[smrtVitestPlugin(),svelte({hot:false})],resolve:{conditions:['browser']},test:{environment:'jsdom',include:['src/svelte/**/*.component.test.ts'],fileParallelism:false,testTimeout:30000,hookTimeout:60000}});
