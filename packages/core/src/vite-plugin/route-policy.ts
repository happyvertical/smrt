/**
 * Policy a generated route reads from a model, and the helpers it emits from
 * that policy.
 *
 * The generated CRUD routes (`sveltekit-generator.ts`) and the generated
 * sync-apply route (`sync-apply-route.ts`) answer the same questions about a
 * model: which body fields a write may set, whether it is tenant-scoped, which
 * principal a request must carry. Both generators call the functions in this
 * module, so the two routes cannot answer differently.
 */

import { generatedExpression } from '../generated-fields.js';
import type { ApiConfig } from '../registry/types.js';
import type { SmartObjectDefinition } from '../scanner/types';

export function getApiConfigObject(apiConfig: unknown): ApiConfig | null {
  if (!apiConfig || typeof apiConfig !== 'object') {
    return null;
  }

  return apiConfig as ApiConfig;
}

/**
 * Collect property names a generated write never sets: fields marked
 * `@field({ readonly: true })` and database-calculated fields (#1540, 2b).
 */
export function collectReadonlyFieldNames(
  objectDef: SmartObjectDefinition,
): string[] {
  const fields = objectDef.fields || {};
  const names: string[] = [];
  for (const [name, def] of Object.entries(fields)) {
    const meta = (def as { _meta?: Record<string, unknown> })._meta;
    if (
      (def as { readonly?: boolean }).readonly === true ||
      meta?.readonly === true ||
      generatedExpression(def) !== undefined
    ) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Every body key a generated write of this model drops as read-only: the
 * read-only and calculated fields, and the projected `displayLabel`.
 */
export function collectRouteReadonlyFields(
  objectDef: SmartObjectDefinition,
): string[] {
  return [
    ...collectReadonlyFieldNames(objectDef),
    ...(objectDef.displayLabelProjection ? ['displayLabel'] : []),
  ];
}

/**
 * Resolve the optional `@smrt({ api: { writable: [...] } })` allowlist. When
 * present, only these fields may be set from a create/update request body.
 */
export function getApiWritableAllowlist(apiConfig: unknown): string[] | null {
  const config = getApiConfigObject(apiConfig);
  return Array.isArray(config?.writable) ? config.writable : null;
}

/**
 * Resolve the `@smrt({ api: { public } })` posture (fail-closed default).
 * - `false`/unset → all routes require an authenticated principal.
 * - `true` → all routes are public.
 * - `'read'` → reads are public, mutations still require auth.
 */
export function getApiPublicAccess(apiConfig: unknown): boolean | 'read' {
  const config = getApiConfigObject(apiConfig);
  const value = config?.public;
  if (value === true || value === 'read') {
    return value;
  }
  return false;
}

/**
 * The collection segment of generated operation permission slugs. Mirrors the
 * smrt-users `PermissionCatalogService` derivation: an explicit
 * `@smrt({ collection })` wins, then the manifest collection. A hosted STI
 * subclass moved to its own route collection keeps the STI base's slugs through
 * `permissionCollection` (#3770).
 */
export function resolvePermissionCollection(
  objectDef: SmartObjectDefinition,
): string {
  if (objectDef.permissionCollection) return objectDef.permissionCollection;
  const configured = (
    objectDef.decoratorConfig as { collection?: unknown } | undefined
  )?.collection;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : objectDef.collection;
}

/**
 * Whether an object is `@TenantScoped` (carries a `tenantScoped` config in its
 * `@smrt()`/`@TenantScoped()` decorator). Drives tenant-context establishment in
 * generated routes (#1540, facet 2).
 */
export function isTenantScoped(objectDef: SmartObjectDefinition): boolean {
  return !!objectDef.decoratorConfig?.tenantScoped;
}

/**
 * Whether generated routes must publish the authenticated principal into the
 * tenancy ALS without making the model itself tenant-scoped. This is an
 * explicit model-level opt-in: body data is never an identity source.
 */
export function usesPrincipalContext(
  objectDef: SmartObjectDefinition,
): boolean {
  const api = getApiConfigObject(objectDef.decoratorConfig?.api);
  return api?.principalContext === true;
}

/**
 * Emit the tenant-context establishment and write gate helpers for
 * `@TenantScoped` objects (#1540 facet 2; #1782). Generated
 * handlers call `establishTenantContext(locals)` after the auth guard so every
 * query runs inside the tenant context derived from the authenticated
 * principal — engaging the `@TenantScoped` interceptors that auto-filter by
 * tenant.
 *
 * `establishTenantContext` reads the canonical `locals.tenantId` set by the
 * smrt-users auth hook (with `user`/`session`/`tenantContext` fallbacks). An
 * upstream context must identify the same tenant/user; conflicting authority
 * fails closed.
 *
 * When no context could be established, an `optional`-mode query would fall
 * through the interceptor UNFILTERED (the interceptor only hard-fails
 * `required` mode). So for a tenant-scoped model:
 *
 * - every generated read calls core's `resolveAnonymousTenantReadScope()`
 *   (or `resolveTenantReadOptionsScope()` for custom GET actions taking
 *   options), resolved at request time from the live registry, which
 *   restricts reads to rows without an owner when tenancy is on and no tenant
 *   is active (#1782);
 * - write handlers call `requireTenantWriteContext(locals)`, which refuses the
 *   request (403, or 401 for an anonymous caller) when tenancy is enabled and
 *   no tenant context is active, unless the principal is explicitly
 *   cross-tenant. A caller with no tenant never writes a tenant-scoped row,
 *   global rows included.
 *
 * @param requirePrincipal - Whether a complete principal (tenant, user and
 *   permissions) is required. `'per-target'` emits
 *   `establishTenantContext(locals, requirePrincipal)` for a route that serves
 *   several models and decides per call (the sync-apply route).
 * @param tenantScoped - Whether to emit the write gate (and the tenancy
 *   imports it needs)
 * @param includeSuperAdminBypass - Whether to import `isSuperAdminBypass`
 *   for routes whose action options carry the read scope
 */
export function generateTenantContextHelper(
  requirePrincipal: boolean | 'per-target',
  tenantScoped: boolean,
  includeSuperAdminBypass = false,
): string {
  const perTarget = requirePrincipal === 'per-target';
  const principalCondition = `typeof tenantId !== 'string' || !tenantId ||
    typeof userId !== 'string' || !userId ||
    !permissions`;
  const principalGuard = perTarget
    ? `  if (
    requirePrincipal && (
    ${principalCondition})
  ) {
    throw error(403, 'Authenticated principal context is incomplete');
  }
`
    : requirePrincipal
      ? `  if (
    ${principalCondition}
  ) {
    throw error(403, 'Authenticated principal context is incomplete');
  }
`
      : '';
  const fullContext = perTarget
    ? '{ tenantId, userId: userId as string, permissions }'
    : '{ tenantId, userId, permissions }';
  const contextArgument = perTarget
    ? `requirePrincipal ? ${fullContext} : { tenantId }`
    : requirePrincipal
      ? fullContext
      : '{ tenantId }';
  const strictUserMismatch = 'active.userId !== userId';
  const lenientUserMismatch =
    "typeof userId === 'string' && userId && active.userId && active.userId !== userId";
  const activeUserMismatch = perTarget
    ? `requirePrincipal ? ${strictUserMismatch} : ${lenientUserMismatch}`
    : requirePrincipal
      ? strictUserMismatch
      : lenientUserMismatch;
  const refreshActive = perTarget
    ? '    if (requirePrincipal) enterTenantContext({ ...active, tenantId: tenantId as string, userId: userId as string, permissions });\n'
    : requirePrincipal
      ? '    enterTenantContext({ ...active, tenantId, userId, permissions });\n'
      : '';
  const tenancyImport = [
    'enterTenantContext',
    'getCurrentTenant',
    ...(tenantScoped ? ['hasTenantContext'] : []),
    ...(includeSuperAdminBypass ? ['isSuperAdminBypass'] : []),
    ...(tenantScoped ? ['isSystemContext', 'isTenancyEnabled'] : []),
  ].join(', ');
  const writeGate = tenantScoped
    ? `
// Writes need a tenant. With tenancy enabled and no tenant context, an
// optional-mode write would run with no tenant predicate at all, so it is
// refused unless the principal is explicitly cross-tenant (a system context,
// or a verified super-admin bypass). Global rows are no exception.
function hasTenantWriteContext(locals: unknown): boolean {
  if (!isTenancyEnabled() || hasTenantContext() || isSystemContext()) {
    return true;
  }
  const l =
    locals && typeof locals === 'object'
      ? (locals as Record<string, unknown>)
      : {};
  const tenantContext =
    l.tenantContext && typeof l.tenantContext === 'object'
      ? (l.tenantContext as Record<string, unknown>)
      : {};
  return tenantContext.superAdminBypass === true;
}

function requireTenantWriteContext(locals: unknown): void {
  if (hasTenantWriteContext(locals)) return;
  throw error(
    hasAuthenticatedPrincipal(locals) ? 403 : 401,
    'Tenant context required',
  );
}
`
    : '';
  return `
import { ${tenancyImport} } from '@happyvertical/smrt-tenancy';

function establishTenantContext(locals: unknown${perTarget ? ', requirePrincipal: boolean' : ''}): void {
  if (!locals || typeof locals !== 'object') return;
  const l = locals as Record<string, unknown>;
  const user = l.user as Record<string, unknown> | undefined;
  const session = l.session as Record<string, unknown> | undefined;
  const tenantContext = l.tenantContext as Record<string, unknown> | undefined;
  const tenantId = l.tenantId ?? user?.tenantId ?? session?.tenantId ?? tenantContext?.tenantId;
  const userId = l.userId ?? user?.id ?? user?.userId ?? session?.userId ?? tenantContext?.userId;
  const rawPermissions =
    l.permissions ?? l.permissionSet ?? l.smrtPermissions ?? tenantContext?.permissions;
  const permissions =
    rawPermissions instanceof Set && [...rawPermissions].every((value) => typeof value === 'string')
      ? rawPermissions
      : Array.isArray(rawPermissions) && rawPermissions.every((value) => typeof value === 'string')
        ? new Set(rawPermissions)
        : undefined;
${principalGuard}
  const active = getCurrentTenant();
  if (active) {
    if (
      (typeof tenantId === 'string' && tenantId && active.tenantId !== tenantId) ||
      (${activeUserMismatch})
    ) {
      throw error(403, 'Tenant context does not match authenticated principal');
    }
${refreshActive}    return;
  }
  if (typeof tenantId === 'string' && tenantId) {
    enterTenantContext(
      ${contextArgument},
    );
  }
}
${writeGate}
`;
}
