// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { SessionLocals } from '@happyvertical/smrt-users/sveltekit';

declare global {
  namespace App {
    // interface Error {}
    interface Locals extends SessionLocals {
      /**
       * URL-selected tenant candidate. Never use this as authorization; the
       * session-authorized tenant remains `tenantId` from SessionLocals.
       */
      selectedTenantId: string | null;
      selectedTenantSlug: string | null;
      /** Full context for the authorized session tenant, when present. */
      tenantContext?: import('@happyvertical/smrt-tenancy').MinimalTenantContext;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
