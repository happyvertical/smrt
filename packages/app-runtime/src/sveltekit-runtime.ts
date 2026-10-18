/**
 * Server implementation boundary for the SvelteKit adapter. Applications use
 * ./sveltekit; this entry stays external while its Kit-facing wrappers bundle.
 * Keep value imports from @sveltejs/kit out of this dependency graph.
 */
export * from './sveltekit/runtime.js';
