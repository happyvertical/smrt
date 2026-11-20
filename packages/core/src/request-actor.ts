/**
 * Who a request acts as: the one rule every request path uses (#5375).
 *
 * Precedence:
 *
 * 1. The request principal a transport settled (the runtime REST server's
 *    `resolveTenant` answer, an in-process MCP context). Until the settled
 *    principal of #5195 is available, this is the transport's own answer.
 * 2. Otherwise the trusted `locals` the host's authentication set (the
 *    emitted SvelteKit routes and the emitted sync route): `tenantId`, then
 *    `user`, `session` and `tenantContext`.
 * 3. An active tenant context must agree with 1 or 2 (a different tenant, or
 *    a different user, is refused with 403). Without either, the active
 *    context is the actor. A cross-tenant grant does not widen an active
 *    tenant context: the request stays in that tenant.
 * 4. A system actor comes only from an active system context, or from a
 *    cross-tenant grant, and then for this operation only: a grant on a read
 *    is a read grant and never authorizes a write.
 * 5. The super-admin bypass only with the tenancy super-admin flag.
 * 6. Otherwise no tenant.
 */

import {
  type FamilyRowOperation,
  familyMembersInScope,
  isCreateOpenOnSurface,
  servedFamilyTypes,
} from './create-target';
import { resolveDispatchTenantId } from './dispatch/tenant-resolver.js';
import { readActionReceivesTenantScope } from './generators/custom-action';
import {
  customActionScope,
  enterResolvedTenancy,
  getTenantPolicySource,
  type RequestActor,
  type RequestTenancy,
  RequestTenancyError,
  readScope,
  resolveRequestTenancy,
  resolveStrictModelKey,
  throwIfRefused,
  withResolvedTenancy,
  writeGate,
} from './request-tenancy';
import { getRequestTenantContext } from './request-tenant-context';
import { SmrtError } from './smrt-error.js';

/** A principal a transport settled for the request. */
export interface SettledRequestPrincipal {
  tenantId?: string | null;
  userId?: string | null;
  permissions?: Iterable<string>;
  /** The principal is explicitly cross-tenant for this request. */
  allowCrossTenant?: boolean;
  /** Signed in (decides 401 or 403 on a refusal). */
  authenticated?: boolean;
}

/** Inputs of {@link resolveRequestActor}. */
export interface RequestActorInput {
  /** The principal the transport settled, when it has one (rule 1). */
  principal?: SettledRequestPrincipal;
  /** Trusted request locals, when the transport has no principal (rule 2). */
  locals?: unknown;
  /** The operation: a cross-tenant grant applies to it only. */
  operation: 'read' | 'write';
  /**
   * Require a complete principal (tenant, user and permissions) in
   * `locals`; refused with 403 otherwise.
   */
  requirePrincipal?: boolean;
}

/** What an actor extractor reads from trusted locals. */
export interface LocalsPrincipal {
  tenantId: string | null;
  userId: string | null;
  permissions: ReadonlySet<string> | undefined;
  authenticated: boolean;
  /** The tenancy middleware marked the request with the bypass flag. */
  bypass: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function permissionSet(value: unknown): ReadonlySet<string> | undefined {
  if (value instanceof Set) {
    return [...value].every((entry) => typeof entry === 'string')
      ? (value as ReadonlySet<string>)
      : undefined;
  }
  if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
  ) {
    return new Set(value as string[]);
  }
  return undefined;
}

/**
 * The principal trusted `locals` carry: the canonical `locals.tenantId` the
 * smrt-users auth hook sets, with `user` / `session` / `tenantContext`
 * fallbacks.
 */
export function principalFromLocals(locals: unknown): LocalsPrincipal {
  const l = record(locals) ?? {};
  const user = record(l.user);
  const session = record(l.session);
  const tenantContext = record(l.tenantContext);
  const userId = nonEmpty(
    l.userId ??
      user?.id ??
      user?.userId ??
      session?.userId ??
      tenantContext?.userId,
  );
  return {
    tenantId: nonEmpty(
      l.tenantId ??
        user?.tenantId ??
        session?.tenantId ??
        tenantContext?.tenantId,
    ),
    userId,
    permissions: permissionSet(
      l.permissions ??
        l.permissionSet ??
        l.smrtPermissions ??
        tenantContext?.permissions,
    ),
    // A resolved, object-shaped principal, or the explicit `smrtAuth` marker
    // (the generated routes' `hasAuthenticatedPrincipal` rule).
    authenticated: !!user || !!session || l.smrtAuth === true,
    bypass: tenantContext?.superAdminBypass === true,
  };
}

/**
 * A request whose principal and active tenant context disagree. Rendered as
 * the plain permission denial every transport gives a tenant isolation
 * refusal: the answer says nothing about the other tenant.
 */
export class RequestTenantConflictError extends SmrtError {
  readonly status = 403;

  constructor(message: string) {
    super(message, 'TENANT_ISOLATION_VIOLATION', 'runtime');
    this.name = 'RequestTenantConflictError';
  }
}

function incomplete(message: string): RequestTenancyError {
  return new RequestTenancyError(403, 'TENANT_CONTEXT_CONFLICT', message);
}

/**
 * Resolve the actor of one request by the precedence above. Throws a 403
 * {@link RequestTenantConflictError} when the request's principal and the
 * active tenant context disagree, and a 403 {@link RequestTenancyError} when
 * a required principal is incomplete.
 */
export function resolveRequestActor(input: RequestActorInput): RequestActor {
  const source = getTenantPolicySource();
  const active = getRequestTenantContext();
  // The tenant context the host entered: the request hooks' answer, else
  // the dispatch resolver's (both are smrt-tenancy's context when it is
  // enabled).
  const activeTenant =
    nonEmpty(active?.tenantId) ?? nonEmpty(resolveDispatchTenantId());
  const activeUser = nonEmpty(active?.userId);

  let tenantId: string | null;
  let userId: string | null;
  let permissions: ReadonlySet<string> | undefined;
  let authenticated: boolean;
  let grant = false;
  let localsBypass = false;

  if (input.principal) {
    tenantId = nonEmpty(input.principal.tenantId);
    userId = nonEmpty(input.principal.userId);
    permissions = input.principal.permissions
      ? new Set(input.principal.permissions)
      : undefined;
    authenticated = input.principal.authenticated !== false;
    grant = input.principal.allowCrossTenant === true;
  } else {
    const fromLocals = principalFromLocals(input.locals);
    tenantId = fromLocals.tenantId;
    userId = fromLocals.userId;
    permissions = fromLocals.permissions;
    authenticated = fromLocals.authenticated;
    localsBypass = fromLocals.bypass;
    if (
      input.requirePrincipal &&
      (!tenantId || !userId || !fromLocals.permissions)
    ) {
      throw incomplete('Authenticated principal context is incomplete');
    }
  }

  // Rule 3: an active tenant context must agree with the principal, grant
  // or no grant.
  if (activeTenant) {
    if (tenantId && tenantId !== activeTenant) {
      throw new RequestTenantConflictError(
        'Tenant context does not match authenticated principal',
      );
    }
    // A complete principal must name the active context's own user.
    if (
      input.requirePrincipal
        ? userId !== activeUser
        : !!userId && !!activeUser && userId !== activeUser
    ) {
      throw new RequestTenantConflictError(
        'Tenant context does not match authenticated principal',
      );
    }
    // The tenant context the host entered is kept: a cross-tenant grant
    // never widens a request the host has already scoped to one tenant.
    grant = false;
    tenantId = activeTenant;
    userId ??= activeUser;
    permissions ??= active?.permissions;
  }

  const systemContext = source?.systemContextActive() === true;
  const system: RequestActor['system'] = systemContext
    ? 'write'
    : grant
      ? input.operation
      : null;
  const bypass =
    !system &&
    !!tenantId &&
    (source?.superAdminBypassActive() === true || localsBypass);

  return Object.freeze({
    tenantId: system ? null : tenantId,
    userId,
    permissions,
    system,
    bypass,
    authenticated: authenticated || !!activeTenant,
  });
}

// ─── One call per request for transports without their own resolver ──────

/** The operation a transport is about to perform on a model. */
export type RequestTenancyOperation =
  | 'list'
  | 'get'
  | 'create'
  | 'update'
  | 'delete'
  | 'action';

/** Inputs of {@link enterRequestTenancy} / {@link runInRequestTenancy}. */
export interface RequestTenancyEntryInput {
  /** The route model's registry key (or a name resolved strictly). */
  model: string;
  operation: RequestTenancyOperation;
  /** Trusted request locals (rule 2), when there is no settled principal. */
  locals?: unknown;
  /** A principal the transport settled (rule 1). */
  principal?: SettledRequestPrincipal;
  /** Require a complete principal in `locals`. */
  requirePrincipal?: boolean;
  /** The surface whose per-model config decides served STI members. */
  surface?: 'api' | 'mcp';
  /**
   * For a custom action: whether it may write, its scanned parameters, and
   * whether it acts on one row the route looks up under the read scope (an
   * item action), which counts as receiving the scope.
   */
  action?: {
    mutating: boolean;
    parameters?: readonly string[];
    itemScoped?: boolean;
  };
}

function servedMembers(
  model: string,
  operation: RequestTenancyOperation,
  mutating: boolean,
  surface: 'api' | 'mcp',
): string[] | undefined {
  const served = (op: FamilyRowOperation) =>
    servedFamilyTypes(model, surface, op);
  if (operation === 'create') {
    const readable = served('get');
    return familyMembersInScope(model, surface, [
      'list',
      'get',
      'update',
      'delete',
    ]).filter(
      (member) =>
        (readable?.includes(member) ?? true) ||
        isCreateOpenOnSurface(member, surface),
    );
  }
  const op: FamilyRowOperation =
    operation === 'list' || operation === 'get'
      ? operation
      : operation === 'delete'
        ? 'delete'
        : operation === 'action'
          ? mutating
            ? 'update'
            : 'list'
          : 'update';
  return served(op);
}

function decide(t: RequestTenancy, input: RequestTenancyEntryInput): void {
  switch (input.operation) {
    case 'list':
    case 'get':
      throwIfRefused(readScope(t));
      return;
    case 'action': {
      const parameters = input.action?.parameters;
      throwIfRefused(
        customActionScope(t, {
          mutating: input.action?.mutating === true,
          receivesScope:
            input.action?.itemScoped === true ||
            (parameters !== undefined &&
              readActionReceivesTenantScope(parameters, t.route.fields)),
        }),
      );
      return;
    }
    default:
      throwIfRefused(writeGate(t));
  }
}

/** Resolve the actor and the tenancy of one request on `input.model`. */
export function resolveTenancyForRequest(
  input: RequestTenancyEntryInput,
): RequestTenancy {
  const mutating =
    input.operation === 'action'
      ? input.action?.mutating === true
      : input.operation !== 'list' && input.operation !== 'get';
  const actor = resolveRequestActor({
    ...(input.principal ? { principal: input.principal } : {}),
    ...(input.locals !== undefined ? { locals: input.locals } : {}),
    operation: mutating ? 'write' : 'read',
    ...(input.requirePrincipal ? { requirePrincipal: true } : {}),
  });
  const key = resolveStrictModelKey(input.model) ?? input.model;
  const served = servedMembers(
    key,
    input.operation,
    mutating,
    input.surface ?? 'api',
  );
  return resolveRequestTenancy({
    model: key,
    ...(served ? { served: served.filter((member) => member !== key) } : {}),
    actor,
  });
}

/**
 * Resolve, decide and bind the tenancy of the rest of this request (the
 * emitted SvelteKit routes): the actor from trusted `locals` (or a settled
 * principal), the model's policy and its served STI members, the decision
 * for `operation` (a refusal throws a typed 401/403), then the actor's
 * tenant context and the bound decision for every collection call after it.
 */
export function enterRequestTenancy(
  input: RequestTenancyEntryInput,
): RequestTenancy {
  const t = resolveTenancyForRequest(input);
  decide(t, input);
  enterResolvedTenancy(t, {
    refreshPrincipal: input.requirePrincipal === true,
  });
  return t;
}

/**
 * {@link enterRequestTenancy} for one operation: `fn` runs inside the
 * resolved tenancy and nothing outlives it (a sync item, an MCP tool call).
 */
export async function runInRequestTenancy<T>(
  input: RequestTenancyEntryInput,
  fn: (t: RequestTenancy) => Promise<T>,
): Promise<T> {
  const t = resolveTenancyForRequest(input);
  decide(t, input);
  return withResolvedTenancy(t, () => fn(t), {
    refreshPrincipal: input.requirePrincipal === true,
  });
}

/**
 * The scope of a read under the request's tenancy: `{ <ownership field>:
 * null }` when it is held to rows without an owner, else `undefined`.
 * Apply it with `applyWhereScope()` so no caller filter on those columns
 * survives.
 */
export function tenancyReadScope(
  t: RequestTenancy,
): Record<string, null> | undefined {
  const decision = readScope(t);
  throwIfRefused(decision);
  return decision.kind === 'global-only' ? decision.scope : undefined;
}

/**
 * Run one tool call inside the request tenancy of its model (both MCP
 * surfaces, #5375). A tool server has no read scope of its own to hand a
 * caller with no tenant, so every tool on a tenant-scoped model needs a
 * tenant, an explicit cross-tenant grant (a read grant for `list` / `get`,
 * a write grant otherwise) or a system context; the bound decision then
 * holds every collection call of the tool, STI membership included.
 */
export function runToolInRequestTenancy<T>(
  input: {
    model: string;
    action: string;
    principal: SettledRequestPrincipal;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const write =
    input.action === 'create' ||
    input.action === 'update' ||
    input.action === 'delete';
  return runInRequestTenancy(
    {
      model: input.model,
      surface: 'mcp',
      principal: input.principal,
      ...(write
        ? { operation: input.action as 'create' | 'update' | 'delete' }
        : {
            operation: 'action' as const,
            action: {
              mutating: input.action !== 'list' && input.action !== 'get',
            },
          }),
    },
    () => fn(),
  );
}
