/**
 * The one authorization decision for generated and runtime routes (#5195).
 *
 * The runtime REST handler (`rest.ts`) and the generated SvelteKit routes
 * answer four questions about a request the same way, by calling this module:
 *
 * 1. sign-in: a route needs `principal.authenticated` unless the model's
 *    `api.public` opens it (`true` opens every operation, `'read'` only reads);
 * 2. operation permission: a mutating operation needs `<collection>.<action>`,
 *    except on an `api.public: true` model; a verified super-admin bypass
 *    stands in only on a model that opts in with `allowSuperAdminBypass`;
 * 3. tenant: a write body may not name another tenant ({@link authorize}),
 *    and a read filter may not select one ({@link stripTenantFilters});
 * 4. which principal: {@link apiPrincipalFromLocals} derives the principal of
 *    a SvelteKit request from `locals`, so both transports feed the same
 *    decision.
 *
 * Everything here is pure: no registry, no request, no I/O. A caller reads the
 * model's policy (public access, permission collection, tenant columns, the
 * bypass opt-in) from its own source (the registry at run time, the manifest at
 * generation time) and passes it in. The REST handler applies the decision only
 * when its host resolves principals; this module always enforces what it is
 * given.
 */

import { principalFromLocals } from '../request-actor';
import { resolveWhereKey, whereColumnName } from '../where-keys';
import type { APIRequestPrincipal } from './request-principal';

/** Operations that only read; every other operation mutates unless told. */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'list',
  'get',
  'count',
  'read',
]);

/** Tenant column a model's rows carry when it names no other. */
const DEFAULT_TENANT_COLUMN = 'tenant_id';

/** What one operation on one model is decided from. */
export interface AuthorizeInput {
  /** The caller. See {@link apiPrincipalFromLocals} for SvelteKit. */
  principal: APIRequestPrincipal;
  /**
   * The operation: `list`, `get`, `count`, `create`, `update`, `delete`,
   * `sync` or a custom action's name.
   */
  op: string;
  /** `<collection>` prefix of the permission slug (`resolvePermissionCollection`). */
  permissionCollection: string;
  /** The model's `api.public` posture (`getApiPublicAccess`). */
  publicAccess: boolean | 'read';
  /**
   * The model opted in with `tenantScoped: { allowSuperAdminBypass: true }`.
   * A principal's `superAdminBypass` counts only when this is set.
   */
  allowSuperAdminBypass?: boolean;
  /**
   * Whether the operation mutates. Defaults to false for `list`, `get`,
   * `count` and `read`, true for any other name; a custom action states it.
   */
  mutating?: boolean;
  /**
   * The permission action when it is not `op` (a custom action's
   * `operationPermissions` alias).
   */
  permissionAction?: string;
  /**
   * Columns that record a row's tenant (snake_case), for the write-body check.
   * Defaults to `tenant_id`; pass the model's ownership columns too.
   */
  tenantColumns?: ReadonlySet<string>;
  /** The write body, checked for a tenant other than the principal's. */
  body?: unknown;
}

/** Why a request was refused: the HTTP status and a stable code. */
export interface AuthorizeDenial {
  allow: false;
  status: 401 | 403;
  code: 'AUTHENTICATION_REQUIRED' | 'PERMISSION_DENIED' | 'TENANT_MISMATCH';
  message: string;
}

/** The request is admitted for `principal`. */
export interface AuthorizeAllowed {
  allow: true;
  principal: APIRequestPrincipal;
}

export type AuthorizeDecision = AuthorizeAllowed | AuthorizeDenial;

function deny(
  status: AuthorizeDenial['status'],
  code: AuthorizeDenial['code'],
  message: string,
): AuthorizeDenial {
  return { allow: false, status, code, message };
}

/** Whether an operation mutates, from its name unless stated. */
export function isMutatingOperation(op: string, mutating?: boolean): boolean {
  return mutating ?? !READ_OPERATIONS.has(op);
}

/** Whether the model's `api.public` lets an unsigned caller run the operation. */
export function isOperationPublic(
  publicAccess: boolean | 'read',
  mutating: boolean,
): boolean {
  return publicAccess === true || (publicAccess === 'read' && !mutating);
}

function holds(
  permissions: Iterable<string> | undefined,
  slug: string,
): boolean {
  if (!permissions) return false;
  if (permissions instanceof Set) return permissions.has(slug);
  for (const granted of permissions) {
    if (granted === slug) return true;
  }
  return false;
}

/**
 * Decide one operation on one model for one principal.
 *
 * Order: sign-in (401), operation permission (403 `PERMISSION_DENIED`), write
 * body tenant (403 `TENANT_MISMATCH`). A `body` key on a tenant column passes
 * only when its value equals `principal.tenantId`; `null` and any other value
 * are refused.
 */
export function authorize(input: AuthorizeInput): AuthorizeDecision {
  const { principal, op, publicAccess } = input;
  const mutating = isMutatingOperation(op, input.mutating);

  if (!principal.authenticated && !isOperationPublic(publicAccess, mutating)) {
    return deny(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  }

  if (mutating && publicAccess !== true) {
    const bypass =
      principal.superAdminBypass === true &&
      input.allowSuperAdminBypass === true;
    const slug = `${input.permissionCollection}.${input.permissionAction ?? op}`;
    if (!bypass && !holds(principal.permissions, slug)) {
      return deny(403, 'PERMISSION_DENIED', 'Permission denied.');
    }
  }

  if (
    input.body &&
    typeof input.body === 'object' &&
    !Array.isArray(input.body)
  ) {
    const columns = input.tenantColumns ?? new Set([DEFAULT_TENANT_COLUMN]);
    for (const [key, value] of Object.entries(input.body)) {
      if (columns.has(whereColumnName(key)) && value !== principal.tenantId) {
        return deny(
          403,
          'TENANT_MISMATCH',
          'The request names a tenant other than the caller’s.',
        );
      }
    }
  }

  return { allow: true, principal };
}

/**
 * Remove every filter on a tenant column from a request `where`, unless the
 * principal is explicitly cross-tenant: the tenant a read acts in comes from
 * the principal, never from a query parameter.
 */
export function stripTenantFilters<T extends Record<string, unknown>>(
  principal: Pick<APIRequestPrincipal, 'allowCrossTenant'>,
  tenantColumns: ReadonlySet<string>,
  where: T | undefined,
): T | undefined {
  if (principal.allowCrossTenant || !where || tenantColumns.size === 0) {
    return where;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(where)) {
    if (tenantColumns.has(resolveWhereKey(key).column)) continue;
    kept[key] = value;
  }
  return kept as T;
}

/**
 * The principal of a SvelteKit request, from `locals`, by the rules the
 * generated guard has always used (`principalFromLocals`): signed in when
 * `user` or `session` is an object or `smrtAuth === true` (never a callable
 * `locals.auth`); tenant from `tenantId`, then `user`, `session`,
 * `tenantContext`; permissions from `permissions`, `permissionSet`,
 * `smrtPermissions` and `tenantContext.permissions` together; a super-admin
 * bypass only from `tenantContext.superAdminBypass === true`. `locals` has no
 * cross-tenant marker, so `allowCrossTenant` is false.
 *
 * Pass `activeTenantId` (the tenant context the host already entered) as the
 * tenant when `locals` names none.
 */
export function apiPrincipalFromLocals(
  locals: unknown,
  activeTenantId?: string | null,
): APIRequestPrincipal {
  const fromLocals = principalFromLocals(locals);
  const l = (locals && typeof locals === 'object' ? locals : {}) as Record<
    string,
    unknown
  >;
  const context = l.tenantContext;
  const contextPermissions =
    context && typeof context === 'object'
      ? (context as Record<string, unknown>).permissions
      : undefined;
  const permissions = new Set<string>(fromLocals.permissions ?? []);
  if (Array.isArray(contextPermissions) || contextPermissions instanceof Set) {
    for (const slug of contextPermissions as Iterable<unknown>) {
      if (typeof slug === 'string') permissions.add(slug);
    }
  }
  return {
    tenantId: fromLocals.tenantId ?? activeTenantId ?? null,
    allowCrossTenant: false,
    authenticated: fromLocals.authenticated,
    ...(fromLocals.userId ? { userId: fromLocals.userId } : {}),
    permissions,
    superAdminBypass: fromLocals.bypass,
  };
}
