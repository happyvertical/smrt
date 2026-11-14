/**
 * The application's SMRT runtime: app options only.
 *
 * `runtime` composes the configured profile (local SQLite or deployed
 * PostgreSQL), storage custody, the owner bootstrap, tenant selection, the
 * signed session, and (local profile) the single-writer lease shared with
 * `smrt app` operations; `src/hooks.server.ts` mounts its `handle` and `init`.
 * The smrt() Vite plugin registers the generated objects before this module
 * runs, and generated API routes resolve collections through
 * `runtime.getCollection()`.
 *
 * `runtime.getCollection()` and `runtime.classOptions()` are request-scoped:
 * under `database-rls` isolation they carry the request's transaction, so
 * call them per request and never keep the result.
 */

import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import './settings-registry';

export const runtime = createSmrtSvelteKitRuntime({
  // Deployed profiles prove authentication, asset, and secret readiness
  // through the modules named by SMRT_*_READINESS_MODULE, or the default for the
  // configured provider; pass `providerReadiness` only to replace that.
  // Per-object overrides, for example:
  //   AuditLog: { db: { type: 'postgres', url: process.env.AUDIT_DB_URL! } }
  classOverrides: {},
});
