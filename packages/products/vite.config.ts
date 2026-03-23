import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const packageDir = resolve(__dirname, '.');

export default defineConfig(async () => {
	// Import smrtPlugin for SMRT object scanning
	const { smrtPlugin } = await import(
		'../../packages/core/src/vite-plugin/index.js'
	);

		return {
		build: {
			lib: {
				entry: resolve(packageDir, 'src/index.ts'),
				formats: ['es'] as const,
				fileName: () => 'index.js',
			},
			rollupOptions: {
				output: {
					dir: resolve(packageDir, 'dist/lib'),
					format: 'es' as const,
					preserveModules: false,
					entryFileNames: '[name].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
				},
				external: [
					// Node.js built-ins
					/^node:/,
					/^bun:/,
					'fs',
					'path',
					'url',
					'os',
					'crypto',
					'stream',
					'util',
					'events',
					'buffer',

					// External dependencies
					'svelte',
					'svelte/internal',
					/^svelte\//,

					// Internal packages
					/^@happyvertical\//,
					/^@have\//,

					// Virtual modules
					'@smrt/routes',
					'@smrt/client',
					'@smrt/mcp',
					'@smrt/manifest',
				],
			},
			minify: false,
			sourcemap: true,
			target: 'es2022',
			reportCompressedSize: false,
		},
		plugins: [
			// Svelte plugin for .svelte component files
			svelte(),
			// SMRT plugin for SMRT object scanning and code generation
			smrtPlugin({
				include: ['src/**/*.ts'],
				exclude: ['**/*.test.ts', '**/*.spec.ts'],
				generateTypes: true,
				hmr: false,
			}),
			// TypeScript declarations
			dts({
				outDir: resolve(packageDir, 'dist/lib'),
				include: [resolve(packageDir, 'src/**/*.ts')],
				exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.ts', '**/*.d.ts'],
				insertTypesEntry: false,
				rollupTypes: false,
				tsconfigPath: resolve(packageDir, 'tsconfig.json'),
				aliasesExclude: [
					'@smrt/routes',
					'@smrt/client',
					'@smrt/mcp',
					'@smrt/manifest',
					'@smrt/types',
				],
			}),
		],
	};
});
