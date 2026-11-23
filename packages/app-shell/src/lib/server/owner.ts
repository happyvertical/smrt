// Who may do what, in one place. The shell has exactly one person: the owner.
// Every builder operation, approval decision and route requires the owner's
// session; the engine's `approved` flag is reachable only from
// `Approval.decide` and the owner's own review-page Publish (`publishOwnDraft`;
// see approvals.ts).
//
// Owner = an ACTIVE membership holding the built-in system `owner` role in the
// principal's tenant, looked up in shell.db on every check (no claim in a
// token, header or request body is trusted).
import {
  getCurrentTenant,
  type TenantContextData,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
} from '@happyvertical/smrt-users';
import {
  type AppDefinition,
  appPermissionSlugs,
  type EnginePrincipal,
  enginePrincipal,
} from '../../engine/index.ts';
import { getShellDb } from './host.ts';

export interface Principal {
  id: string;
  tenantId: string;
  scopes?: readonly string[];
}

export class PolicyError extends Error {
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.status = status;
  }
}

export type OwnerCheck = (principal: Principal) => Promise<boolean>;

async function ownerFromDatabase(principal: Principal): Promise<boolean> {
  const db = await getShellDb();
  const roles = await RoleCollection.create({ db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  if (!ownerRole?.id) return false;
  const memberships = await MembershipCollection.create({ db });
  const membership = await memberships.findByUserAndTenant(
    principal.id,
    principal.tenantId,
  );
  return (
    !!membership &&
    membership.status === MembershipStatus.ACTIVE &&
    membership.roleId === ownerRole.id
  );
}

let override: OwnerCheck | null = null;

/** Tests only: replace the database lookup. Pass null to restore it. */
export function setOwnerCheck(check: OwnerCheck | null): void {
  override = check;
}

export async function isOwner(
  principal: Principal | null | undefined,
): Promise<boolean> {
  if (!principal?.id || !principal.tenantId) return false;
  try {
    // Inside the principal's own tenant: the hosted app hands out its
    // database only within a tenant's context (see `getShellDb`).
    return await (override ?? ((p) => runAs(p, () => ownerFromDatabase(p))))(
      principal,
    );
  } catch {
    return false; // fail closed
  }
}

/** The principal, or a 401 (nobody) / 403 (somebody who is not the owner). */
export async function requireOwner(
  principal: Principal | null | undefined,
): Promise<Principal> {
  if (!principal?.id || !principal.tenantId)
    throw new PolicyError(401, 'sign in first');
  if (!(await isOwner(principal)))
    throw new PolicyError(403, 'only the owner can do this');
  return principal;
}

/** The principal of a SvelteKit request, from the verified session only. */
export function principalFromLocals(locals: {
  user?: { id?: unknown } | null;
  tenantId?: unknown;
  permissions?: unknown;
}): Principal | null {
  const id = locals.user?.id;
  if (typeof id !== 'string' || !id) return null;
  if (typeof locals.tenantId !== 'string' || !locals.tenantId) return null;
  return {
    id,
    tenantId: locals.tenantId,
    scopes: Array.isArray(locals.permissions)
      ? (locals.permissions as string[])
      : [],
  };
}

/** The principal of the running async scope (the session's tenant context). */
export function currentPrincipal(): Principal | null {
  const ctx: TenantContextData | undefined = getCurrentTenant();
  if (!ctx?.userId || !ctx.tenantId) return null;
  return { id: ctx.userId, tenantId: ctx.tenantId };
}

/** For model methods: the owner of the current scope, or a refusal. */
export function assertOwner(): Promise<Principal> {
  return requireOwner(currentPrincipal());
}

/**
 * Run `fn` inside the verified principal's tenant context, so the owner check
 * in model methods (`assertOwner`) sees exactly the principal a route
 * verified, whatever async context the route runs in.
 */
export function runAs<T>(
  principal: Principal,
  fn: () => Promise<T>,
): Promise<T> {
  return withTenant(
    {
      tenantId: principal.tenantId,
      userId: principal.id,
      permissions: new Set(principal.scopes ?? []),
    },
    fn,
  );
}

/**
 * The engine principal of a VERIFIED owner (#5188): their tenant and user, and
 * every permission of the app's definition (the owner holds all of them). Built
 * only from a `Principal` that `requireOwner` or `ownerOf` returned; nothing in
 * a request body or header reaches it. Guests are not built here (no RLS yet).
 */
export function principalFor(
  owner: Principal,
  def: AppDefinition,
): EnginePrincipal {
  return enginePrincipal({
    kind: 'user',
    tenantId: owner.tenantId,
    userId: owner.id,
    permissions: appPermissionSlugs(def),
  });
}

/** `principalFor` for the owner of the running async scope, against `host`'s current definition. */
export async function callerFor(host: {
  def: AppDefinition;
}): Promise<EnginePrincipal> {
  return principalFor(await assertOwner(), host.def);
}

/**
 * The engine principal of an owner already verified upstream, named by user
 * id (the `author` of a builder call): the app's own tenant, the owner's
 * slugs. For callers that hold the verified owner's id but no async scope.
 */
export function authorCaller(
  host: { def: AppDefinition; tenantId: string },
  author: string,
): EnginePrincipal {
  return principalFor({ id: author, tenantId: host.tenantId }, host.def);
}
