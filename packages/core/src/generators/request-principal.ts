/**
 * The principal a runtime REST request acts for, and the rules the server
 * enforces from it (#5195).
 *
 * A host that configures `APIConfig.resolvePrincipal` decides who the caller
 * is, once per request, outside the server. The server then enforces, from
 * that principal and nothing in the request:
 *
 * This module holds the principal's shape and what resolves it. The rules the
 * server enforces from it are decided in one place, `route-authz.ts`
 * (`authorize`, `stripTenantFilters`), which the REST handler and the generated
 * SvelteKit routes share:
 *
 * - sign-in: a route that is not `api.public` needs `authenticated`;
 * - operation permissions: `<collection>.<action>` for create, update, delete,
 *   each mutating custom action and each sync item;
 * - the tenant: a write body may not name another tenant and a query filter
 *   may not select one.
 *
 * Without `resolvePrincipal` the server keeps its fixed `APIContext` principal
 * and none of these rules apply; `authMiddleware` decides alone.
 */

import { GUEST_CALLER_KIND } from '../guest-request';
import { resolveOperationPermissionAlias } from '../operation-permission.js';
import { resolvePermissionCollection } from '../permission-collection.js';
import { readonlySetOf } from '../readonly-collections';
import { ObjectRegistry } from '../registry';
import type { SettledRequestPrincipal } from '../request-actor';
import { tenantOwnershipFields } from '../tenant-read-scope';
import { getApiPublicAccess } from '../vite-plugin/route-policy';

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
  /** What hooks receive: the request's one principal snapshot. */
  readonly principal: RequestPrincipal;
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

/**
 * The one principal a request acts for, read once from the host's answer
 * (#5195). Frozen, with no prototype: every reader of the request sees this
 * object, and nothing the request runs can change it. An anonymous caller is
 * a principal that is not signed in, never `null`.
 */
export interface RequestPrincipal {
  /** Tenant the caller acts in; `null` for a caller with no tenant. */
  readonly tenantId: string | null;
  /** The signed-in user, or `null`. */
  readonly userId: string | null;
  /** The caller is signed in. */
  readonly authenticated: boolean;
  /** What kind of caller this is (a user, an agent, a service), or `null`. */
  readonly callerKind: string | null;
  /** The caller is explicitly cross-tenant (an operator). */
  readonly allowCrossTenant: boolean;
  /** The host verified a super-admin bypass. */
  readonly superAdminBypass: boolean;
  /**
   * The request runs inside a transaction its host opened for this principal
   * (`APIConfig.requestScope`).
   */
  readonly requestScoped: boolean;
  /** Permission slugs held; empty when the host supplied none. Read-only. */
  readonly permissions: ReadonlySet<string>;
}

/** Longest tenant or user id a principal may carry. */
const MAX_ID_LENGTH = 256;
/** Longest caller kind a principal may carry. */
const MAX_CALLER_KIND_LENGTH = 64;
/** Most permission slugs a principal may carry. */
const MAX_PERMISSIONS = 4096;
/** One permission slug: no whitespace or control characters, bounded. */
const SLUG_PATTERN = /^[A-Za-z0-9_*][A-Za-z0-9_.:*/@-]{0,255}$/u;

/**
 * The value of one own property of the host's answer, read exactly once: a
 * data property's value, or an accessor's getter called once. Inherited
 * properties are never read.
 */
function readOwn(source: object, key: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return undefined;
  if ('value' in descriptor) return descriptor.value;
  return descriptor.get ? descriptor.get.call(source) : undefined;
}

function idField(key: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`principal.${key} must be a non-empty string or null`);
  }
  if (value.length > MAX_ID_LENGTH) {
    throw new TypeError(`principal.${key} is too long`);
  }
  return value;
}

function flagField(key: string, value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new TypeError(`principal.${key} must be a boolean`);
  }
  return value;
}

function permissionsField(value: unknown): ReadonlySet<string> {
  if (value === undefined || value === null) return readonlySetOf<string>([]);
  const iterator = (value as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (typeof value === 'string' || typeof iterator !== 'function') {
    throw new TypeError('principal.permissions must be an iterable of slugs');
  }
  const slugs: string[] = [];
  for (const slug of value as Iterable<unknown>) {
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
      throw new TypeError('principal.permissions must hold permission slugs');
    }
    slugs.push(slug);
    if (slugs.length > MAX_PERMISSIONS) {
      throw new TypeError('principal.permissions holds too many slugs');
    }
  }
  return readonlySetOf(slugs);
}

/**
 * Read what a host's `resolvePrincipal` returned into the request's
 * {@link RequestPrincipal}. `null` or `undefined` is an anonymous caller.
 *
 * Each own field is read exactly once, in a fixed order, so an accessor or a
 * proxy trap runs once and its first value is the one used; inherited
 * properties are never read and unknown fields are ignored. A value of the
 * wrong shape (an empty or oversized id, a flag that is not a boolean,
 * permissions that are not a bounded list of slugs, an own `__proto__` key)
 * is a host defect and throws `TypeError`, which the server answers with a
 * 500 before any hook runs.
 */
export function normalizeRequestPrincipal(value: unknown): RequestPrincipal {
  if (value === null || value === undefined) {
    return snapshotOf({
      tenantId: null,
      userId: null,
      authenticated: false,
      callerKind: null,
      allowCrossTenant: false,
      superAdminBypass: false,
      permissions: readonlySetOf<string>([]),
    });
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('resolvePrincipal must return an object or null');
  }
  if (Reflect.getOwnPropertyDescriptor(value, '__proto__')) {
    throw new TypeError('principal must not carry a __proto__ key');
  }
  const tenantId = idField('tenantId', readOwn(value, 'tenantId'));
  const userId = idField('userId', readOwn(value, 'userId'));
  const authenticated = flagField(
    'authenticated',
    readOwn(value, 'authenticated'),
  );
  const rawKind = readOwn(value, 'callerKind');
  if (
    rawKind !== undefined &&
    rawKind !== null &&
    (typeof rawKind !== 'string' ||
      rawKind.length === 0 ||
      rawKind.length > MAX_CALLER_KIND_LENGTH)
  ) {
    throw new TypeError('principal.callerKind must be a short string');
  }
  const allowCrossTenant = flagField(
    'allowCrossTenant',
    readOwn(value, 'allowCrossTenant'),
  );
  const superAdminBypass = flagField(
    'superAdminBypass',
    readOwn(value, 'superAdminBypass'),
  );
  const permissions = permissionsField(readOwn(value, 'permissions'));
  // A guest (#5196) is an unauthenticated caller of one tenant with no user:
  // an inconsistent one (a user, a sign-in, a grant, a bypass, no tenant) is
  // a host defect, never silently narrowed.
  if (rawKind === GUEST_CALLER_KIND) {
    if (
      userId !== null ||
      authenticated ||
      allowCrossTenant ||
      superAdminBypass ||
      tenantId === null
    ) {
      throw new TypeError(
        'a guest principal has a tenant and no user, sign-in, grant or bypass',
      );
    }
  }
  return snapshotOf({
    tenantId,
    userId,
    authenticated,
    callerKind: typeof rawKind === 'string' ? rawKind : null,
    allowCrossTenant,
    superAdminBypass,
    permissions,
  });
}

/** The frozen, prototype-free snapshot object. */
function snapshotOf(
  fields: Omit<RequestPrincipal, 'requestScoped'> & {
    requestScoped?: boolean;
  },
): RequestPrincipal {
  const snapshot = Object.create(null) as Record<string, unknown>;
  snapshot.tenantId = fields.tenantId;
  snapshot.userId = fields.userId;
  snapshot.authenticated = fields.authenticated;
  snapshot.callerKind = fields.callerKind;
  snapshot.allowCrossTenant = fields.allowCrossTenant;
  snapshot.superAdminBypass = fields.superAdminBypass;
  snapshot.requestScoped = fields.requestScoped === true;
  snapshot.permissions = fields.permissions;
  return Object.freeze(snapshot) as unknown as RequestPrincipal;
}

/**
 * The fixed principal of a server without `resolvePrincipal`: its
 * `APIContext` tenant, user and permissions.
 */
export function fixedRequestPrincipal(fields: {
  tenantId: string | null;
  userId: string | null;
  authenticated: boolean;
  allowCrossTenant: boolean;
  permissions: Iterable<string> | undefined;
}): RequestPrincipal {
  return snapshotOf({
    ...fields,
    callerKind: null,
    superAdminBypass: false,
    permissions: readonlySetOf(fields.permissions ?? []),
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
    callerKind: principal.principal.callerKind,
    superAdminBypass: principal.superAdminBypass,
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
 * What the shared decision (`route-authz.ts`) is told about `model`: its
 * `api.public` posture, the `<collection>` of its permission slugs, the
 * super-admin opt-in and the columns that record its tenant. Read from the
 * live registry, so the runtime REST handler and the generated routes decide a
 * write under the model it lands in (an STI subtype selected through its base,
 * or the subtype a loaded row belongs to) by one rule (#5195).
 */
export function modelRoutePolicy(model: string): {
  publicAccess: boolean | 'read';
  permissionCollection: string;
  allowSuperAdminBypass: boolean;
  tenantColumns: ReadonlySet<string>;
} {
  return {
    publicAccess: getApiPublicAccess(ObjectRegistry.getConfig(model)?.api),
    // `<collection>.<action>` minus its action: the collection the generated
    // routes and the permission catalog use.
    permissionCollection: operationPermissionOf(model, '_').slice(0, -2),
    allowSuperAdminBypass:
      ObjectRegistry.getTenantScopedConfig(model)?.allowSuperAdminBypass ===
      true,
    tenantColumns: new Set(tenantOwnershipFields(model).values()),
  };
}
