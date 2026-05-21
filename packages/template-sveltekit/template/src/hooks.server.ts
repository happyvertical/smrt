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
  getCurrentTenant,
} from '@happyvertical/smrt-tenancy';

import { resolveTenant } from '$lib/server/tenancy';
import { getSmrtConfig } from '$lib/server/smrt';

// Register the tenancy interceptor globally. Idempotent — `enableTenancy()`
// guards against duplicate registration internally.
enableTenancy();

// Both upstream factories (`createSvelteKitHandle` from smrt-tenancy and
// `createSessionHandler` from smrt-users/sveltekit) declare a structural
// event type with `locals: Record<string, unknown>` to avoid taking a
// hard dependency on `@sveltejs/kit`. SvelteKit's own `Handle` expects
// `event.locals: App.Locals` — a strict named interface without an
// index signature — so the two shapes aren't directly assignable under
// strict typechecking. The casts below adapt the upstream return types
// to SvelteKit's `Handle` once. Runtime behaviour is unchanged; the
// types still flow through `Handle` to the `sequence(...)` composition.

/**
 * Subdomain → tenantId handle. Runs BEFORE the session handler so generated
 * routes have a tenant in context even for unauthenticated public requests
 * (e.g. tenant-scoped catalog endpoints). If a session also carries a
 * tenant, the session handler's inner `withTenant()` will override.
 */
const tenancyHandle = createSvelteKitHandle({
  resolveTenantId: async (event) => {
    // The createSvelteKitHandle adapter passes a structural event; our
    // resolver accepts that same shape.
    const result = await resolveTenant(event as RequestEvent);
    return result.tenantId;
  },
}) as unknown as Handle;

/**
 * Session handle from @happyvertical/smrt-users. `enterTenantContext: true`
 * makes it call `enterTenantContext()` after loading the session, so
 * downstream code sees the *session's* tenant id when one is present.
 */
const sessionHandle = createSessionHandler({
  ...getSmrtConfig('Session'),
  enterTenantContext: true,
}) as unknown as Handle;

/**
 * Final reconciliation: read the active AsyncLocalStorage tenant (already
 * set correctly by tenancyHandle + sessionHandle, with session winning
 * over subdomain when both are present) and align BOTH `event.locals.tenantId`
 * AND `event.locals.tenantContext` to it.
 *
 * Two failure modes this guards against:
 *
 *   1. **Public requests with a subdomain.** `createSessionHandler` resets
 *      `event.locals.tenantId` to `null` before checking for a session
 *      cookie. With no session, the session handler returns without
 *      repopulating it, so the subdomain-resolved tenant goes missing
 *      from layouts/actions even though the ALS context (set by
 *      `tenancyHandle`) still carries it.
 *   2. **Authenticated requests where the session's tenant differs from
 *      the subdomain.** The session handler calls `withTenant(sessionCtx, ...)`
 *      — switching the ALS context to the session tenant — and updates
 *      `event.locals.tenantId` to match. But it does NOT touch
 *      `event.locals.tenantContext`, which is still the subdomain context
 *      previously written by `tenancyHandle`. Layouts/actions reading
 *      `tenantContext` would then see stale permissions/superAdminBypass
 *      that don't match the tenant their queries are scoped to.
 *
 * Reading the live ALS context here and writing it back to BOTH
 * `locals.tenantId` and `locals.tenantContext` keeps the three vantage
 * points (locals.tenantId, locals.tenantContext, ALS-scoped queries) in
 * sync regardless of auth state.
 *
 * **ALS-scope dependency:** this handle reads `getCurrentTenant()` from
 * AsyncLocalStorage, which only works because both upstream handles
 * call `resolve(event)` *inside* their own ALS scope:
 *   - `createSvelteKitHandle` (smrt-tenancy) wraps in `withTenant(ctx, () => resolve(event))`.
 *   - `createSessionHandler` (smrt-users) wraps in `withSessionPermissionContext`,
 *     which internally calls `withTenant(sessionCtx, fn)` when the session
 *     has a tenantId.
 * If a future refactor moved either handle's `resolve()` call outside
 * its ALS scope, `getCurrentTenant()` here would return `undefined` and
 * the reconciliation would silently no-op. We deliberately do NOT fall
 * back to `event.locals.tenantId` here — that would re-introduce the
 * stale-tenantContext bug from the subdomain handler. If the upstream
 * scoping ever changes, this handle should be updated to read from a
 * dedicated cross-handler carrier (e.g. `event.locals._tenantSource`)
 * rather than guessing.
 */
const reconcileTenantLocals: Handle = async ({ event, resolve }) => {
  const activeContext = getCurrentTenant();
  if (activeContext) {
    event.locals.tenantId = activeContext.tenantId;
    event.locals.tenantContext = activeContext;
  }
  return resolve(event);
};

export const handle: Handle = sequence(
  tenancyHandle,
  sessionHandle,
  reconcileTenantLocals,
);
