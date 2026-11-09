// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type { SmrtRuntimeLocals } from '@happyvertical/smrt-app-runtime/sveltekit';

declare global {
  namespace App {
    // interface Error {}
    // Session user, permissions, the authorized `tenantId`/`tenantContext`,
    // and the URL-selected tenant candidate (never authorization).
    interface Locals extends SmrtRuntimeLocals {}
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
