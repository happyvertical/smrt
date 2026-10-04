import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { smrtVitestPlugin } from '../vitest/src/index.ts';
export default defineConfig({ plugins: [smrtVitestPlugin(), svelte({ hot: false })], test: { environment: 'node', include: ['src/components/forms/__tests__/code-select.ssr-contract.ts'] } });
