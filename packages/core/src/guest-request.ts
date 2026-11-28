/**
 * The guest caller of a request (#5196): who an UNAUTHENTICATED request acts
 * as in a tenant that grants guests access, and what that caller may run.
 *
 * A guest has `callerKind: 'guest'` and no user (`userId: null`). The host
 * that admits one (the app runtime's session step) publishes a
 * {@link GuestRequestPrincipal} on `locals.guestPrincipal`; generated routes
 * admit it only for the generated read operations (`list`, `get`) of a
 * collection it holds `<collection>.read` for, never through the user/session
 * markers an authenticated caller carries.
 *
 * @packageDocumentation
 */

import type { GuestRuntime } from './guest-runtime.js';
import { resolveOperationPermissionAlias } from './operation-permission.js';
import { readonlySetOf } from './readonly-collections';
import { ObjectRegistry } from './registry';

/** The caller kind of a guest principal. */
export const GUEST_CALLER_KIND = 'guest' as const;

/** The largest page a guest list read may request. */
export const GUEST_MAX_LIST_LIMIT = 100;

/** The only guest permission kinds; everything else never survives. */
export type GuestPermissionKind = 'read' | 'create';

/** Generated CRUD operations each guest kind may authorize. */
export const GUEST_KIND_OPERATIONS: Readonly<
  Record<GuestPermissionKind, readonly string[]>
> = Object.freeze({
  read: Object.freeze(['list', 'get']),
  create: Object.freeze(['create']),
});

/**
 * The guest permission kind an operation is authorized by, or `null`.
 *
 * Decided by the operation itself, never by the slug it would be checked
 * against: only the generated CRUD operations (`list`/`get` for read,
 * `create` for create) map to a guest kind. A custom method, even one aliased
 * onto `read` or `create` through `operationPermissions`, maps to nothing, so
 * a `products.read` grant never opens it.
 */
export function guestOperationKind(
  model: string,
  operation: string,
): GuestPermissionKind | null {
  let aliased = false;
  try {
    aliased =
      resolveOperationPermissionAlias(
        ObjectRegistry.getConfig(model),
        operation,
      ) !== undefined;
  } catch {
    return null;
  }
  if (aliased) return null;
  // A custom method that happens to be NAMED `list`, `get` or `create` is
  // not the generated CRUD operation: only an operation no declared method
  // claims maps to a guest kind.
  try {
    if (ObjectRegistry.getMethods(model)?.has(operation)) return null;
  } catch {
    return null;
  }
  for (const kind of ['read', 'create'] as const) {
    if (GUEST_KIND_OPERATIONS[kind].includes(operation)) return kind;
  }
  return null;
}

/**
 * Whether a guest holding `permissions` may run `operation` on `collection`
 * (the collection slug prefix). Fails closed on custom and aliased methods.
 */
export function isGuestOperationAllowed(
  permissions: ReadonlySet<string>,
  model: string,
  collection: string,
  operation: string,
): boolean {
  const kind = guestOperationKind(model, operation);
  return kind !== null && permissions.has(`${collection}.${kind}`);
}

/** The principal an unauthenticated request acts as in a guest tenant. */
export interface GuestRequestPrincipal {
  readonly callerKind: typeof GUEST_CALLER_KIND;
  /** A guest has no user. */
  readonly userId: null;
  /** The one tenant the guest acts in (bound into the request transaction). */
  readonly tenantId: string;
  /** The guest permission set (ceiling already applied). Read-only. */
  readonly permissions: ReadonlySet<string>;
  /**
   * The process-wide guest runtime (limiters, create field lists, audit
   * writer). Absent means nothing beyond the generated reads: no create, and
   * guest reads are refused rather than admitted unlimited.
   */
  readonly runtime?: GuestRuntime;
  /**
   * For each granted slug, the qualified name of the ONE model the code
   * ceiling admitted it for (a collection name can be shared by several
   * models, and an explicit policy binding can name another table). A route
   * admits a guest only when its own model is the admitted one; absent means
   * no route admits the guest.
   */
  readonly slugModels?: ReadonlyMap<string, string>;
}

/** The route a guest operation is checked for. */
export interface GuestRouteModel {
  /** Registry key the model's config is resolved by. */
  model: string;
  /** The model's qualified name (`package:Class`), when it has one. */
  qualifiedName: string | undefined;
  /** The `<collection>` prefix of its permission slugs. */
  collection: string;
}

/**
 * Whether the guest may run `operation` on THIS route's model: the slug is
 * granted (generated CRUD only), and the ceiling admitted that slug for this
 * exact model, not merely for a model that shares the collection name.
 */
export function isGuestAllowedOnRoute(
  principal: GuestRequestPrincipal,
  route: GuestRouteModel,
  operation: string,
): boolean {
  if (
    !isGuestOperationAllowed(
      principal.permissions,
      route.model,
      route.collection,
      operation,
    )
  ) {
    return false;
  }
  const kind = guestOperationKind(route.model, operation);
  if (kind === null || !route.qualifiedName) return false;
  return (
    principal.slugModels?.get(`${route.collection}.${kind}`) ===
    route.qualifiedName
  );
}

/** Build the frozen principal. Throws on an empty tenant. */
export function createGuestRequestPrincipal(input: {
  tenantId: string;
  permissions: Iterable<string>;
  runtime?: GuestRuntime;
  slugModels?: Iterable<readonly [string, string]>;
}): GuestRequestPrincipal {
  if (typeof input.tenantId !== 'string' || input.tenantId.length === 0) {
    throw new TypeError('A guest principal requires a tenant');
  }
  return Object.freeze({
    callerKind: GUEST_CALLER_KIND,
    userId: null,
    tenantId: input.tenantId,
    permissions: readonlySetOf([...input.permissions]),
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.slugModels
      ? { slugModels: new Map(input.slugModels) as ReadonlyMap<string, string> }
      : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The guest principal on request `locals`, or `null`.
 *
 * Fails closed: the marker must be well-formed, name the same tenant as
 * `locals.tenantId`, and the request must carry no user, session or
 * `smrtAuth` marker (an authenticated caller is never also a guest).
 */
export function guestPrincipalOf(
  locals: unknown,
): GuestRequestPrincipal | null {
  if (!isRecord(locals)) return null;
  if (locals.user || locals.session || locals.smrtAuth === true) return null;
  const guest = locals.guestPrincipal;
  if (!isRecord(guest)) return null;
  if (guest.callerKind !== GUEST_CALLER_KIND || guest.userId !== null) {
    return null;
  }
  const { tenantId, permissions } = guest;
  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  if (locals.tenantId !== tenantId) return null;
  if (typeof (permissions as { has?: unknown } | null)?.has !== 'function') {
    return null;
  }
  return guest as unknown as GuestRequestPrincipal;
}

/** Whether `locals` carry a valid guest principal. */
export function isGuestLocals(locals: unknown): boolean {
  return guestPrincipalOf(locals) !== null;
}
