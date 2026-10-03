/**
 * Request foundation from `@happyvertical/smrt-app-runtime/sveltekit`, in
 * order: the fail-closed startup gate (`init`), URL tenant selection
 * (`locals.selectedTenant*`, never authority; tenant headers are ignored), the
 * signed session (the only source of tenant context and permissions), and
 * `locals.tenantContext` published only for the verified session tenant.
 *
 * Membership-gated tenant switching belongs in an explicit action using
 * `switchSessionTenant()` from `@happyvertical/smrt-users/sveltekit`.
 * Configure the runtime in `$lib/server/smrt`.
 */

import { runtime } from '$lib/server/smrt';

export const { handle, init } = runtime;
