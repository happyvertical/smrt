/**
 * SvelteKit server entry for `@happyvertical/smrt-app-runtime`.
 *
 * Server-only: this entry never imports Svelte components or browser code.
 * `@sveltejs/kit` is an optional peer dependency resolved from the consumer.
 *
 * @example
 * ```ts
 * // src/hooks.server.ts
 * import { createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
 *
 * export const runtime = createSmrtSvelteKitRuntime();
 * export const { handle, init } = runtime;
 * ```
 */

export {
  createRuntimeDiagnosticsHandler,
  createRuntimeHealthHandler,
  createSessionLayoutLoad,
  type DiagnosticsPrincipalLocals,
  RUNTIME_DIAGNOSTICS_READ_PERMISSION,
  type RuntimeDiagnosticsHandlerOptions,
  type SessionLayoutData,
} from './handlers.js';
export {
  createOwnerSetupPage,
  DEFAULT_OWNER_SETUP_MESSAGES,
  isLoopbackAddress,
  isLoopbackHostname,
  isLoopbackRequest,
  OWNER_SETUP_FIELDS,
  type OwnerSetupActionEvent,
  type OwnerSetupErrorCode,
  type OwnerSetupEvent,
  type OwnerSetupFailure,
  type OwnerSetupPage,
  type OwnerSetupPageData,
  type OwnerSetupPageOptions,
} from './owner-setup.js';
export {
  type ApplicationRuntimeDiagnosticsOptions,
  authorizedTenantLocalsHandle,
  composeHandles,
  createSmrtSvelteKitRuntime,
  defaultWriterLease,
  type ProviderReadinessComponent,
  type ProviderReadinessFactory,
  type RuntimeHealthBody,
  type SmrtRuntimeBoundPrincipal,
  type SmrtRuntimeLocals,
  type SmrtRuntimeMcpIdentity,
  type SmrtRuntimeMcpPrincipalMapping,
  type SmrtRuntimeSessionCookie,
  type SmrtRuntimeSessionOptions,
  type SmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntimeOptions,
  type WriterLease,
  type WriterLeaseContext,
} from './runtime.js';
export {
  createSubdomainTenantSelector,
  normalizeTenantSelection,
  type SubdomainTenantSelectorOptions,
  selectTenantSlug,
  type TenantSelection,
  type TenantSelectionEvent,
  type TenantSelector,
} from './tenancy.js';
