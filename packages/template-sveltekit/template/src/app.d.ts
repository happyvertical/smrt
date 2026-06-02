// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { SessionLocals } from '@happyvertical/smrt-users/sveltekit';

declare global {
  namespace App {
    // interface Error {}
    interface Locals extends SessionLocals {
      /**
       * Tenant context object set by the smrt-tenancy SvelteKit handle.
       * `event.locals.tenantId` (from SessionLocals) is the canonical id
       * string; this object carries the full context (permissions,
       * superAdminBypass, etc.) when needed.
       */
      tenantContext?: import('@happyvertical/smrt-tenancy').MinimalTenantContext;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
