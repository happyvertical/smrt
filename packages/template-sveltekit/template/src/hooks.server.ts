/**
 * Request foundation, in order:
 *
 * 1. Resolve a URL tenant candidate into `locals.selectedTenant*`. This is
 *    selection only and does not enter AsyncLocalStorage tenant context.
 * 2. Load the signed session. `enterTenantContext: true` establishes the
 *    authorized session tenant and its permission set for downstream code.
 * 3. Publish the authorized context on locals when it matches the session.
 *
 * This ordering prevents a spoofed header or hostname from becoming query
 * authority. Membership-gated tenant switching belongs in an explicit action
 * using `switchSessionTenant()` from `@happyvertical/smrt-users/sveltekit`.
 */

import { getCurrentTenant, enableTenancy } from '@happyvertical/smrt-tenancy';
import { createSessionHandler } from '@happyvertical/smrt-users/sveltekit';
import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

import { getSmrtConfig } from '$lib/server/smrt';
import { resolveTenant } from '$lib/server/tenancy';

enableTenancy();

const tenantSelectionHandle: Handle = async ({ event, resolve }) => {
  const selection = await resolveTenant(event);
  event.locals.selectedTenantId = selection.tenantId;
  event.locals.selectedTenantSlug = selection.tenantSlug;
  return resolve(event);
};

const sessionHandle = createSessionHandler({
  ...getSmrtConfig('Session'),
  enterTenantContext: true,
}) as unknown as Handle;

const authorizedTenantLocalsHandle: Handle = async ({ event, resolve }) => {
  const activeContext = getCurrentTenant();
  if (
    event.locals.user &&
    event.locals.tenantId &&
    activeContext?.tenantId === event.locals.tenantId
  ) {
    event.locals.tenantContext = activeContext;
  }
  return resolve(event);
};

export const handle: Handle = sequence(
  tenantSelectionHandle,
  sessionHandle,
  authorizedTenantLocalsHandle,
);
