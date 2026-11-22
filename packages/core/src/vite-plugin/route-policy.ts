/**
 * Policy a generated route reads from a model, and the helpers it emits from
 * that policy.
 *
 * The generated CRUD routes (`sveltekit-generator.ts`) and the generated
 * sync-apply route (`sync-apply-route.ts`) answer the same questions about a
 * model: which body fields a write may set, whether it is tenant-scoped, which
 * principal a request must carry. Both generators call the functions in this
 * module, so the two routes cannot answer differently. The permission slug
 * collection comes from `../permission-collection.ts`, which the runtime REST
 * server reads too.
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
 * Whether an object is `@TenantScoped` (carries a `tenantScoped` config in its
 * `@smrt()`/`@TenantScoped()` decorator). Drives tenant-context establishment in
 * generated routes (#1540, facet 2).
 */
export function isTenantScoped(objectDef: SmartObjectDefinition): boolean {
  return !!objectDef.decoratorConfig?.tenantScoped;
}

/**
 * The ownership property a tenant-scoped model's manifest names: its
 * `tenantScoped.field`, else `tenantId`. Empty when the model is not
 * tenant-scoped in its manifest.
 */
export function manifestOwnershipProperties(
  objectDef: SmartObjectDefinition,
): string[] {
  const config = objectDef.decoratorConfig?.tenantScoped;
  if (!config) return [];
  const field =
    typeof config === 'object'
      ? (config as { field?: unknown }).field
      : undefined;
  return [typeof field === 'string' && field.length > 0 ? field : 'tenantId'];
}

/**
 * Whether a tenant-scoped model lets a verified super-admin bypass act with
 * no tenant: `tenantScoped: { allowSuperAdminBypass: true }`.
 */
export function allowsSuperAdminBypass(
  objectDef: SmartObjectDefinition,
): boolean {
  const config = objectDef.decoratorConfig?.tenantScoped;
  return (
    !!config &&
    typeof config === 'object' &&
    (config as { allowSuperAdminBypass?: unknown }).allowSuperAdminBypass ===
      true
  );
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
 * Emit the request tenancy helper of a generated route (#5375).
 *
 * Every generated handler calls `enterTenancy(locals, operation)` after the
 * auth guard. It asks core, at request time, for the tenancy the model has
 * now, whatever this manifest declared:
 *
 * - the actor, from the canonical `locals.tenantId` the smrt-users auth hook
 *   sets (with `user` / `session` / `tenantContext` fallbacks), or the tenant
 *   context the host entered; a disagreeing context is refused with 403;
 * - the model's policy and the policy of every STI member the route serves;
 * - the decision for the operation: a read by a caller with no tenant is
 *   refused for a required-mode model and held to rows without an owner for
 *   an optional one; a write needs a tenant (or an explicit system context, or
 *   a bypass the model opts into); a custom read with no scope argument is
 *   refused to a caller with no tenant;
 * - the actor's tenant context and the bound decision, which every
 *   collection call in the handler (custom action bodies included) is held to.
 *
 * A refusal becomes `error(401 | 403)`. The manifest's `tenantScoped` flag
 * selects nothing here: a model whose tenancy is registered at run time is
 * served like one that declares it.
 *
 * @param requirePrincipal - The model requires a complete principal
 *   (tenant, user and permissions; `api.principalContext`)
 * @param model - The model's registry key, as the route's other policy
 *   lookups use it
 * @param familyScope - Registry keys of the model's STI family members this
 *   manifest generated routes for, when the model has a family: a member
 *   registered elsewhere is not served through the route
 */
export function generateTenantContextHelper(
  requirePrincipal: boolean,
  model: string,
  familyScope?: readonly string[],
): string {
  const scope = familyScope
    ? `\nconst TENANCY_MODEL_SCOPE: ReadonlySet<string> = new Set(${JSON.stringify([...familyScope].sort())});\n`
    : '';
  return `
import {
  enterRequestTenancy,
  getRequestTenantContext as getCurrentTenant,
  normalizeTypedHttpError as tenancyRefusalOf,
} from '@happyvertical/smrt-core';

const TENANCY_MODEL = ${JSON.stringify(model)};
${scope}
function enterTenancy(
  locals: unknown,
  operation: 'list' | 'get' | 'create' | 'update' | 'delete' | 'action',
  action?: {
    mutating: boolean;
    parameters?: readonly string[];
    itemScoped?: boolean;
  },
) {
  try {
    return enterRequestTenancy({
      model: TENANCY_MODEL,
      locals,
      operation,
      requirePrincipal: ${requirePrincipal},${familyScope ? '\n      modelScope: TENANCY_MODEL_SCOPE,' : ''}
      ...(action ? { action } : {}),
    });
  } catch (cause) {
    const failure = tenancyRefusalOf(cause);
    if (failure) throw error(failure.status, failure.message);
    throw cause;
  }
}
`;
}
