/**
 * Vite Plugin: Agent Admin Routes
 *
 * Generates SvelteKit route files from agent manifest adminRoutes declarations.
 * This allows agents to define their own admin route trees that become real
 * SvelteKit routes with SSR, code splitting, and deep linking.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { vitePluginAgentRoutes } from '@happyvertical/smrt-agents/vite';
 *
 * export default defineConfig({
 *   plugins: [
 *     sveltekit(),
 *     vitePluginAgentRoutes({
 *       agents: [
 *         { packageName: '@happyvertical/praeco', agentClass: 'Praeco' },
 *       ],
 *     }),
 *   ],
 * });
 * ```
 */

export interface AgentRoutesPluginOptions {
	/** Where to write generated route files (default: 'src/routes/portal/[siteSlug]/agents/[agentId]') */
	routeBase?: string;
	/** Agent manifest sources — package names to read manifests from */
	agents: Array<{
		packageName: string;
		agentClass: string;
	}>;
}

/**
 * Vite plugin that generates SvelteKit route files from agent adminRoutes.
 *
 * Currently a no-op stub — route generation will be implemented when agents
 * define sub-routes (e.g., sources/[sourceId]). The existing [slotId] dynamic
 * route handles flat slot navigation.
 *
 * Returns a plain object to avoid Vite version type conflicts between
 * the host app's Vite version and this package's Vite version.
 */
export function vitePluginAgentRoutes(_options: AgentRoutesPluginOptions): { name: string } {
	return {
		name: 'smrt-agent-routes',
		// Route generation will be added here when needed
	};
}
