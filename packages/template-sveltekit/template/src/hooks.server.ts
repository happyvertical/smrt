/**
 * SvelteKit server hooks.
 *
 * Pre-wired with:
 *   1. `enableTenancy()` — registers the @happyvertical/smrt-tenancy
 *      interceptor with `GlobalInterceptors` at priority 100, so any class
 *      decorated with `@TenantScoped` is auto-filtered by the tenant in
 *      AsyncLocalStorage. Idempotent — safe to call on every module load.
 *   2. `createSessionHandler({ enterTenantContext: true })` from
 *      @happyvertical/smrt-users/sveltekit — populates
 *      `event.locals.{user, permissions, tenantId, sessionId}` and pushes
 *      the session's tenant into the AsyncLocalStorage context that
 *      generated REST routes consume.
 *   3. A subdomain-based tenant resolver (`tenancyHandle`) — if the URL has
 *      a leading subdomain (e.g. `acme.demo.local`), the request runs inside
 *      `withTenant({ tenantId: 'acme' })`. The session handler runs *after*
 *      this so a session-bound tenant can still override the host-derived
 *      tenant when both are present.
 *
 * To swap the resolution strategy, edit `src/lib/server/tenancy.ts`.
 */

import { sequence } from '@sveltejs/kit/hooks';
import type { Handle, RequestEvent } from '@sveltejs/kit';

import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
import {
  createSvelteKitHandle,
  enableTenancy,
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

export const handle: Handle = sequence(tenancyHandle, sessionHandle);
