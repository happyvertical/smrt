/**
 * Framework Adapters for smrt-tenancy
 *
 * Provides middleware/hooks for popular frameworks to set up tenant context.
 *
 * @example SvelteKit
 * ```typescript
 * // hooks.server.ts
 * import { createSvelteKitHandle } from '@happyvertical/smrt-tenancy/adapters';
 *
 * export const handle = createSvelteKitHandle({
 *   resolveTenantId: async (event) => {
 *     // Get from subdomain, header, cookie, etc.
 *     return event.request.headers.get('x-tenant-id');
 *   }
 * });
 * ```
 */

export { type CliContextOptions, createCliContext } from './cli.js';
export {
  createExpressMiddleware,
  type ExpressMiddlewareOptions,
} from './express.js';
export {
  createSvelteKitHandle,
  type SvelteKitHandleOptions,
} from './sveltekit.js';
