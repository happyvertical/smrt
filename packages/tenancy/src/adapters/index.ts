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

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

export { type CliContextOptions, createCliContext } from './cli.js';
export {
  createExpressMiddleware,
  type ExpressMiddlewareOptions,
} from './express.js';
export {
  createSvelteKitHandle,
  type SvelteKitHandleOptions,
} from './sveltekit.js';
