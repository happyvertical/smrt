/**
 * The principal a runtime REST request acts for, and the rules the server
 * enforces from it (#5195).
 *
 * A host that configures `APIConfig.resolvePrincipal` decides who the caller
 * is, once per request, outside the server. The server then enforces, from
 * that principal and nothing in the request:
 *
 * - sign-in: a route that is not `api.public` needs `authenticated`;
 * - operation permissions: `<collection>.<action>` for create, update, delete,
 *   each mutating custom action and each sync item ({@link requirePermission});
 * - the tenant: a write body may not name another tenant
 *   ({@link assertWriteTenant}) and a query filter may not select one
 *   ({@link withoutTenantFilters}).
 *
 * Without `resolvePrincipal` the server keeps its fixed `APIContext` principal
 * and none of these rules apply; `authMiddleware` decides alone.
 */

import { resolveOperationPermissionAlias } from '../operation-permission.js';
import { resolvePermissionCollection } from '../permission-collection.js';
import { ObjectRegistry } from '../registry';
import type { SettledRequestPrincipal } from '../request-actor';
import { tenantOwnershipFields } from '../tenant-read-scope';
import { resolveWhereKey, whereColumnName } from '../where-keys';

/**
 * Who one REST request acts for, as the host decided it. See
 * `APIConfig.resolvePrincipal`.
 */
export interface APIRequestPrincipal {
  /** Tenant the caller acts in; `null` for a caller with no tenant. */
  tenantId: string | null;
  /** The caller is explicitly cross-tenant (an operator). */
  allowCrossTenant: boolean;
  /** The caller is signed in. A route that is not public needs this. */
  authenticated: boolean;
  /** The signed-in user, when there is one. */
  userId?: string;
  /**
   * Permission slugs the caller holds (`<collection>.<action>`). Read once,
   * when the principal is resolved. Absent: the caller holds none.
   */
  permissions?: Iterable<string>;
  /** What kind of caller this is (a user, an agent, a service), for hooks. */
  callerKind?: string;
  /**
   * The host verified a super-admin bypass. It stands in for an operation
   * permission only on a model that opts in with
   * `tenantScoped: { allowSuperAdminBypass: true }`.
   */
  superAdminBypass?: boolean;
}

/** Which kind of route a request reached; see {@link APIRequestInfo}. */
export type APIRequestRoute =
  | 'object'
  | 'sync/apply'
  | '_changes'
  | '_events'
  | '_inference'
  | '_preflight'
  | 'custom'
  | 'unmatched';

/** What `APIConfig.onRequest` is told about a request or a sync item. */
export interface APIRequestInfo {
  /** The route the request reached. */
  route: APIRequestRoute;
  /** Registry key of the model, when the route names one. */
  model?: string;
  /**
   * The operation: `list`, `get`, `count`, `create`, `update`, `delete`, a
   * custom action's name, or a sync item's op.
   */
  action?: string;
}

/**
 * The principal one request acts for, after defaults. Internal to the REST
 * server; hooks see {@link APIRequestPrincipal}.
 */
export interface ResolvedRequestPrincipal {
  /** `resolvePrincipal` is configured: the rules of this module apply. */
  readonly enforced: boolean;
  /** What hooks receive: the host's principal, or `null` for anonymous. */
  readonly principal: Readonly<APIRequestPrincipal> | null;
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly allowCrossTenant: boolean;
  readonly authenticated: boolean;
  /**
   * The tenant the request acts in: `tenantId`, else the tenant context the
   * host already entered. What the exposure gate and create targets read.
   */
  readonly effectiveTenantId: string | null;
  /** Permission slugs held; `undefined` when none were supplied. */
  readonly permissions: ReadonlySet<string> | undefined;
  readonly superAdminBypass: boolean;
}

/**
 * A refusal decided from the principal. Carries the HTTP status and code the
 * REST error boundary (`normalizeTypedHttpError`) answers with.
 */
export class RequestPrincipalRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RequestPrincipalRefusal';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

/** 403 `PERMISSION_DENIED`. */
export function permissionDenied(): RequestPrincipalRefusal {
  return new RequestPrincipalRefusal(
    403,
    'PERMISSION_DENIED',
    'Permission denied.',
  );
}

/** 403 `TENANT_MISMATCH`. */
export function tenantMismatch(): RequestPrincipalRefusal {
  return new RequestPrincipalRefusal(
    403,
    'TENANT_MISMATCH',
    'The request names a tenant other than the caller’s.',
  );
}

/**
 * Check and copy what a host's `resolvePrincipal` returned. `null` or
 * `undefined` is an anonymous caller. A value of the wrong shape is a host
 * defect and throws, which the server answers with a 500.
 */
export function normalizeRequestPrincipal(
  value: unknown,
): Readonly<APIRequestPrincipal> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('resolvePrincipal must return an object or null');
  }
  const raw = value as Record<string, unknown>;
  const tenantId = raw.tenantId;
  if (
    tenantId !== null &&
    tenantId !== undefined &&
    typeof tenantId !== 'string'
  ) {
    throw new TypeError('principal.tenantId must be a string or null');
  }
  let permissions: ReadonlySet<string> | undefined;
  if (raw.permissions !== undefined && raw.permissions !== null) {
    const source = raw.permissions as { [Symbol.iterator]?: unknown };
    if (
      typeof raw.permissions === 'string' ||
      typeof source[Symbol.iterator] !== 'function'
    ) {
      throw new TypeError('principal.permissions must be an iterable of slugs');
    }
    const slugs = new Set<string>();
    for (const slug of raw.permissions as Iterable<unknown>) {
      if (typeof slug !== 'string') {
        throw new TypeError('principal.permissions must hold strings only');
      }
      slugs.add(slug);
    }
    permissions = slugs;
  }
  const optionalText = (key: 'userId' | 'callerKind') => {
    const entry = raw[key];
    if (entry === undefined || entry === null) return undefined;
    if (typeof entry !== 'string') {
      throw new TypeError(`principal.${key} must be a string`);
    }
    return entry;
  };
  const userId = optionalText('userId');
  const callerKind = optionalText('callerKind');
  return Object.freeze({
    tenantId: typeof tenantId === 'string' && tenantId ? tenantId : null,
    allowCrossTenant: raw.allowCrossTenant === true,
    authenticated: raw.authenticated === true,
    ...(userId !== undefined ? { userId } : {}),
    ...(permissions ? { permissions } : {}),
    ...(callerKind !== undefined ? { callerKind } : {}),
    superAdminBypass: raw.superAdminBypass === true,
  });
}

/**
 * The principal as the request actor resolver reads it (#5375): tenant,
 * user, permissions, grant and sign-in, from the resolved principal only.
 */
export function settledPrincipalOf(
  principal: ResolvedRequestPrincipal,
): SettledRequestPrincipal {
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    ...(principal.permissions ? { permissions: principal.permissions } : {}),
    allowCrossTenant: principal.allowCrossTenant,
    authenticated: principal.authenticated,
  };
}

/** The REST segment of a model registered without a `collection`. */
function pluralSegment(name: string): string {
  const word = name.toLowerCase();
  if (word.endsWith('y')) return `${word.slice(0, -1)}ies`;
  if (word.endsWith('s') || word.endsWith('sh') || word.endsWith('ch')) {
    return `${word}es`;
  }
  return `${word}s`;
}

/**
 * The `<collection>.<action>` slug a model's operation needs, from the live
 * registry: the same collection the generated routes and the smrt-users
 * permission catalog use ({@link resolvePermissionCollection}).
 */
export function operationPermissionOf(model: string, action: string): string {
  const info = ObjectRegistry.getClass(model);
  const collection = resolvePermissionCollection({
    collection: info?.collection || pluralSegment(info?.name || model),
    decoratorConfig: ObjectRegistry.getConfig(model),
  });
  return `${collection}.${action}`;
}

/**
 * The action of a custom action's permission slug: its
 * `operationPermissions` alias, else its own name.
 */
export function customActionPermission(
  model: string,
  actionName: string,
): string {
  return (
    resolveOperationPermissionAlias(ObjectRegistry.getConfig(model), actionName)
      ?.action ?? actionName
  );
}

/**
 * Require the operation permission `<collection>.<action>` of `model`.
 *
 * The one check every write path of the runtime REST server uses: create,
 * update and delete, each mutating custom action, each sync item, and the
 * re-check against the row's own model when a row is a subtype of the route's
 * model. Applies only when the host resolves the principal. A model with
 * `api.public: true` keeps its unauthenticated write semantics, as on the
 * generated routes; a verified super-admin bypass stands in only on a model
 * that opts in with `allowSuperAdminBypass`.
 *
 * @throws {RequestPrincipalRefusal} 403 `PERMISSION_DENIED`
 */
export function requirePermission(
  principal: ResolvedRequestPrincipal,
  model: string,
  action: string,
): void {
  if (!principal.enforced) return;
  const api = ObjectRegistry.getConfig(model)?.api;
  if (
    api &&
    typeof api === 'object' &&
    (api as { public?: unknown }).public === true
  ) {
    return;
  }
  if (
    principal.superAdminBypass &&
    ObjectRegistry.getTenantScopedConfig(model)?.allowSuperAdminBypass === true
  ) {
    return;
  }
  if (principal.permissions?.has(operationPermissionOf(model, action))) return;
  throw permissionDenied();
}

/** Columns that record a row's tenant on `model`, for body and filter keys. */
function tenantColumns(model: string, includeDefaults: boolean): Set<string> {
  const columns = new Set(tenantOwnershipFields(model).values());
  if (includeDefaults) columns.add('tenant_id');
  return columns;
}

/**
 * Refuse a write body that names a tenant other than the principal's.
 *
 * The tenant keys are `tenantId`, `tenant_id` and the model's configured
 * ownership field, under any spelling that resolves to the same column. A key
 * whose value equals `principal.tenantId` passes (a client may echo the row it
 * read); any other value, `null` included, is refused rather than dropped, so
 * a client learns that the request could not choose its tenant. Applies only
 * when the host resolves the principal.
 *
 * @throws {RequestPrincipalRefusal} 403 `TENANT_MISMATCH`
 */
export function assertWriteTenant(
  principal: ResolvedRequestPrincipal,
  model: string | undefined,
  body: unknown,
): void {
  if (!principal.enforced || !model) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  const columns = tenantColumns(model, true);
  for (const [key, value] of Object.entries(body)) {
    if (!columns.has(whereColumnName(key))) continue;
    if (value !== principal.tenantId) throw tenantMismatch();
  }
}

/**
 * Remove every filter on a tenant ownership column of `model` from a request
 * `where`, unless the principal is explicitly cross-tenant. The tenant a read
 * acts in comes from the principal; a query parameter can neither select nor
 * exclude one. Applies only when the host resolves the principal.
 */
export function withoutTenantFilters<T extends Record<string, unknown>>(
  principal: ResolvedRequestPrincipal,
  model: string | undefined,
  where: T | undefined,
): T | undefined {
  if (!principal.enforced || principal.allowCrossTenant || !model || !where) {
    return where;
  }
  const columns = tenantColumns(model, false);
  if (columns.size === 0) return where;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (columns.has(resolveWhereKey(key).column)) continue;
    kept[key] = value;
  }
  return kept as T;
}
