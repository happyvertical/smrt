// Hand-written by design — does not use createPackageConfig (per
// docs/content/standards.md §3 and §9). Products is the reference for
// triple-consumption (npm library + module federation + standalone
// SvelteKit app). Uses @originjs/vite-plugin-federation, multi-mode
// builds (lib/app/federation), workspace-import rewriting in the dts
// plugin, and an index.html for the standalone variant — none of which
// fit createPackageConfig's library-only output shape.

import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const packageDir = resolve(__dirname, '.');
const workspacePackagesDir = resolve(packageDir, '..');

const externalPatterns = [
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
] as const;

function normalizePath(filePath: string): string {
	return filePath.replaceAll('\\', '/');
}

function matchesExternalPattern(id: string): boolean {
	return externalPatterns.some((pattern) =>
		typeof pattern === 'string'
			? id === pattern || id.startsWith(`${pattern}/`)
			: pattern.test(id),
	);
}

function isResolvedWorkspaceDependency(id: string, importer?: string): boolean {
	const normalizedId = normalizePath(id);
	const normalizedPackageDir = normalizePath(packageDir);
	const normalizedWorkspacePackagesDir = normalizePath(workspacePackagesDir);

	if (normalizedId.startsWith(normalizedWorkspacePackagesDir)) {
		return !normalizedId.startsWith(normalizedPackageDir);
	}

	if (!importer || !normalizedId.startsWith('.')) {
		return false;
	}

	const normalizedImporter = normalizePath(importer);
	if (!normalizedImporter.startsWith(normalizedWorkspacePackagesDir)) {
		return false;
	}

	const resolvedId = normalizePath(resolve(dirname(importer), id));
	if (!resolvedId.startsWith(normalizedWorkspacePackagesDir)) {
		return false;
	}

	return !resolvedId.startsWith(normalizedPackageDir);
}

function isExternalDependency(id: string, importer?: string): boolean {
	return (
		matchesExternalPattern(id) || isResolvedWorkspaceDependency(id, importer)
	);
}

const libEntries = {
	index: resolve(packageDir, 'src/index.ts'),
	models: resolve(packageDir, 'src/models.ts'),
	components: resolve(packageDir, 'src/components.ts'),
	stores: resolve(packageDir, 'src/stores.ts'),
	generated: resolve(packageDir, 'src/generated.ts'),
	utils: resolve(packageDir, 'src/utils.ts'),
	collections: resolve(packageDir, 'src/collections.ts'),
	// These `lib/*` entries are NOT public subpaths (they have no
	// `package.json#exports` mapping). They emit standalone modules into
	// `dist/lib/lib/` so the raw `.svelte` files produced by the
	// `svelte-package` passes below (over `src/lib/{components,features,stores}`)
	// can resolve their shared-module imports. `svelte-package` only emits
	// files under its `-i` input dir, so shared modules that live directly
	// under `src/lib` (and are imported as `../mock-smrt-client` /
	// `../i18n.js`) must be emitted here instead. `lib/i18n` closes the gap
	// reported in #1536 — without it the packaged components keep an
	// `import { M } from '../i18n.js'` that never resolves.
	'lib/mock-smrt-client': resolve(packageDir, 'src/lib/mock-smrt-client.ts'),
	'lib/i18n': resolve(packageDir, 'src/lib/i18n.ts'),
} as const;

/**
 * Vite mode → output target for the triple-consumption build.
 *
 * - `library`   (default): tree of ESM entries + .d.ts in `dist/lib`. This is
 *   what `npm run build` / turbo run and what consumers import. Externalizes
 *   workspace + node deps so nothing is bundled.
 * - `standalone`: the browser app from `index.html` (mounts `App.svelte`)
 *   into `dist/app`. Bundles everything for the browser (no `external`).
 * - `federation`: module-federation remote exposing the browser-safe
 *   components from `src/lib/federation-entry.ts` into `dist/federation`.
 *
 * Previously `build.lib` was unconditional, so `--mode standalone` /
 * `--mode federation` silently re-ran the library build and emitted nothing
 * to `dist/app` or `dist/federation` — the standalone + federation consumption
 * paths were dead. Each mode now produces its own artifact.
 */
export default defineConfig(async ({ mode }) => {
	// Import smrtPlugin for SMRT object scanning
	const { importWorkspaceModule } = await import(
		'../core/src/utils/import-workspace-module.js'
	);
	const { smrtPlugin } = await importWorkspaceModule<
		typeof import('@happyvertical/smrt-core/vite-plugin')
	>({
		packageName: '@happyvertical/smrt-core/vite-plugin',
		distEntry: 'packages/core/dist/vite-plugin.js',
		sourceEntry: 'packages/core/src/vite-plugin/index.ts',
		purpose: 'products package Vite config',
	});

	// SMRT object scanning is shared by every mode.
	const smrt = smrtPlugin({
		include: ['src/**/*.ts'],
		exclude: ['**/*.test.ts', '**/*.spec.ts'],
		generateTypes: true,
		hmr: false,
	});

	// The standalone app + federation remote bundle cross-package SMRT models
	// (smrt-assets, smrt-tenancy) for the browser rather than externalizing
	// them, so they need smrtConsumer() to emit `.smrt/register.js` for
	// runtime class loading. The library build externalizes those packages and
	// does not.
	const loadSmrtConsumer = async () => {
		const { smrtConsumer } = await importWorkspaceModule<
			typeof import('@happyvertical/smrt-core/consumer-plugin')
		>({
			packageName: '@happyvertical/smrt-core/consumer-plugin',
			distEntry: 'packages/core/dist/consumer-plugin.js',
			sourceEntry: 'packages/core/src/consumer-plugin/index.ts',
			purpose: 'products package consumer plugin',
		});
		return smrtConsumer({ projectRoot: packageDir });
	};

	// Standalone browser app: build index.html → dist/app. The app must bundle
	// its dependencies for the browser, so we deliberately do NOT pass the
	// library `external` predicate here.
	if (mode === 'standalone') {
		return {
			build: {
				outDir: resolve(packageDir, 'dist/app'),
				emptyOutDir: true,
				sourcemap: true,
				target: 'es2022',
				reportCompressedSize: false,
				rollupOptions: {
					input: resolve(packageDir, 'index.html'),
				},
			},
			server: {
				// Dev-mode API for the live demo page (#1756): run
				// `pnpm demo:live-server` alongside `pnpm dev:standalone`.
				proxy: {
					'/api/v1': 'http://127.0.0.1:39456',
				},
			},
			plugins: [svelte(), await loadSmrtConsumer(), smrt],
		};
	}

	// Module-federation remote: expose browser-safe components → dist/federation.
	if (mode === 'federation') {
		const { default: federation } = await import(
			'@originjs/vite-plugin-federation'
		);
		const { flattenedExposes } = await import(
			'./src/federation/expose.config.js'
		);
		const { sharedDependencies } = await import(
			'./src/federation/shared.config.js'
		);
		return {
			build: {
				outDir: resolve(packageDir, 'dist/federation'),
				emptyOutDir: true,
				sourcemap: true,
				// Module federation requires a modern target that supports
				// top-level await for the shared-scope bootstrap.
				target: 'esnext',
				minify: false,
				reportCompressedSize: false,
			},
			plugins: [
				svelte(),
				await loadSmrtConsumer(),
				smrt,
				federation({
					name: 'smrt_products',
					filename: 'remoteEntry.js',
					exposes: {
						'./federation-entry': resolve(
							packageDir,
							'src/lib/federation-entry.ts',
						),
						...flattenedExposes,
					},
					shared: sharedDependencies,
				}),
			],
		};
	}

	// Default + `library` mode: the published ESM library surface.
	return {
		build: {
			lib: {
				entry: libEntries,
				formats: ['es'] as const,
				fileName: (_format, entryName) => `${entryName}.js`,
			},
			rollupOptions: {
				output: {
					dir: resolve(packageDir, 'dist/lib'),
					format: 'es' as const,
					preserveModules: false,
					entryFileNames: '[name].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
				},
				external: isExternalDependency,
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
			smrt,
			// TypeScript declarations
			dts({
				outDir: resolve(packageDir, 'dist/lib'),
				include: [resolve(packageDir, 'src/**/*.ts')],
				exclude: ['**/*.test.ts', '**/*.spec.ts', '**/*.config.ts', '**/*.d.ts'],
				insertTypesEntry: false,
				rollupTypes: false,
				entryRoot: resolve(packageDir, 'src'),
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
