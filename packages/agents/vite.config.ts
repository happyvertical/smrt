import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

const packageDir = resolve(import.meta.dirname);

/**
 * Custom vite config for smrt-agents that includes UI entry point
 *
 * Extends the base package config pattern but adds ui.ts as a separate
 * entry point for the /ui subpath export.
 */
export default defineConfig(async () => {
	// Import smrtPlugin for SMRT object scanning
	const { smrtPlugin } = await import('../../packages/core/src/vite-plugin/index.js');

	return {
		build: {
			lib: {
				// Multiple entry points: index.ts, ui.ts, and vite-plugin.ts
				entry: {
					index: resolve(packageDir, 'src/index.ts'),
					ui: resolve(packageDir, 'src/ui.ts'),
					'vite-plugin': resolve(packageDir, 'src/vite-plugin.ts'),
				},
				formats: ['es'] as const,
			},
			rollupOptions: {
				output: {
					dir: resolve(packageDir, 'dist'),
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
					'child_process',
					'buffer',
					'Buffer',

					// External dependencies
					'cheerio',
					'crawlee',
					'puppeteer',
					'playwright',
					'playwright-core',
					'sqlite3',
					'better-sqlite3',
					'openai',
					/^openai\//,
					'anthropic',
					'@anthropic-ai/sdk',
					'@google/generative-ai',
					'@google/genai',
					'@aws-sdk/client-bedrock-runtime',
					'@langchain/core',
					'@langchain/openai',
					'@langchain/anthropic',
					'@langchain/community',
					'date-fns',
					'uuid',
					'@paralleldrive/cuid2',
					'yaml',
					'@modelcontextprotocol/sdk',
					/^@modelcontextprotocol\//,
					'cosmiconfig',
					'@libsql/client',

					// Internal SMRT packages
					/^@happyvertical\//,

					// External SDK packages
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
			smrtPlugin({
				include: ['src/**/*.ts'],
				exclude: ['**/*.test.ts', '**/*.spec.ts'],
				generateTypes: true,
				hmr: false,
			}),
			dts({
				outDir: resolve(packageDir, 'dist'),
				include: [resolve(packageDir, 'src/**/*.ts')],
				exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts'],
				insertTypesEntry: false,
				rollupTypes: true,
				tsconfigPath: resolve(packageDir, 'tsconfig.json'),
			}),
		],
	};
});
