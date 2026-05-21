/**
 * SvelteKit server hooks.
 *
 * Pre-wired with:
 *   1. `enableTenancy()` — registers the @happyvertical/smrt-tenancy
 *      interceptor with `GlobalInterceptors` at priority 100, so any class
 *      decorated with `@TenantScoped` is auto-filtered by the tenant in
 *      AsyncLocalStorage. Idempotent — safe to call on every module load.
 *   2. A subdomain-based tenant resolver (`tenancyHandle`) — if the URL has
 *      a leading subdomain (e.g. `acme.demo.local`), the request runs inside
 *      `withTenant({ tenantId: 'acme' })`.
 *   3. `createSessionHandler({ enterTenantContext: true })` from
 *      @happyvertical/smrt-users/sveltekit — populates
 *      `event.locals.{user, permissions, tenantId, sessionId}` and pushes
 *      the session's tenant into the AsyncLocalStorage context.
 *   4. `reconcileTenantLocals` — final reconciliation step. The session
 *      handler initializes `event.locals.tenantId = null` before reading
 *      the session, so for unauthenticated public requests it clobbers the
 *      subdomain value set by step 2. This handle restores the subdomain
 *      tenant on `event.locals.tenantId` when no session tenant set it,
 *      so layout/page/action code reads a consistent value regardless of
 *      auth state.
 *
 * To swap the resolution strategy, edit `src/lib/server/tenancy.ts`.
 */

import { sequence } from '@sveltejs/kit/hooks';
import type { Handle, RequestEvent } from '@sveltejs/kit';

import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
import {
  createSvelteKitHandle,
  enableTenancy,
  getTenantId,
} from '@happyvertical/smrt-tenancy';

import { resolveTenant } from '$lib/server/tenancy';
import { getSmrtConfig } from '$lib/server/smrt';

// Register the tenancy interceptor globally. Idempotent — `enableTenancy()`
// guards against duplicate registration internally.
enableTenancy();

/**
 * Subdomain → tenantId handle. Runs BEFORE the session handler so generated
 * routes have a tenant in context even for unauthenticated public requests
 * (e.g. tenant-scoped catalog endpoints). If a session also carries a
 * tenant, the session handler's inner `withTenant()` will override.
 */
const tenancyHandle: Handle = createSvelteKitHandle({
  resolveTenantId: async (event) => {
    // The createSvelteKitHandle adapter passes a structural event; our
    // resolver accepts that same shape.
    const result = await resolveTenant(event as RequestEvent);
    return result.tenantId;
  },
});

/**
 * Session handle from @happyvertical/smrt-users. `enterTenantContext: true`
 * makes it call `enterTenantContext()` after loading the session, so
 * downstream code sees the *session's* tenant id when one is present.
 */
const sessionHandle: Handle = createSessionHandler({
  ...getSmrtConfig('Session'),
  enterTenantContext: true,
});

/**
 * Final reconciliation: read the active AsyncLocalStorage tenant (already
 * set correctly by tenancyHandle + sessionHandle, with session winning
 * over subdomain when both are present) and ensure `event.locals.tenantId`
 * matches. Without this, `createSessionHandler` resets `tenantId` to `null`
 * for unauthenticated requests, even when a tenant was resolved from the
 * subdomain — causing layouts and actions to read `null` while generated
 * REST routes (which consume the ALS context) read the correct tenant.
 */
const reconcileTenantLocals: Handle = async ({ event, resolve }) => {
  if (!event.locals.tenantId) {
    const tenantFromContext = getTenantId();
    if (tenantFromContext) {
      event.locals.tenantId = tenantFromContext;
    }
  }
  return resolve(event);
};

export const handle: Handle = sequence(
  tenancyHandle,
  sessionHandle,
  reconcileTenantLocals,
);
