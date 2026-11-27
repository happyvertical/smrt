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
  OWNER_SLUG,
} from '../../engine/index.ts';
import { ModelAccessGrantCollection } from '../objects/ModelAccessGrant.ts';
import { getShellDb } from './host.ts';
import {
  type AccessAction,
  finalStaffSlugs,
  isAccessAction,
  sharedTableModels,
  slugsFor,
} from './model-access.ts';
import { ShellVersionStore } from './version-store.ts';

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
    permissions: [OWNER_SLUG, ...appPermissionSlugs(def)],
  });
}

/** `principalFor` for the owner of the running async scope, against `host`'s current definition. */
export async function callerFor(host: {
  def: AppDefinition;
}): Promise<EnginePrincipal> {
  return principalFor(await assertOwner(), host.def);
}

/**
 * The engine principal of a verified owner, for a caller that holds the
 * verified `Principal` but no async scope (a builder call). The tenant is the
 * principal's own, never the host's: a host of another tenant refuses it.
 */
export function authorCaller(
  owner: Principal,
  host: { def: AppDefinition },
): EnginePrincipal {
  return principalFor(owner, host.def);
}

/**
 * The role slug of a STAFF member (#5197): an ACTIVE member of the principal's
 * tenant who is not the owner (`admin`, `member`, `viewer` or a custom role
 * are all plain staff). Null for the owner, for any membership that is not
 * ACTIVE, for a missing membership or role, and for any failure (fail closed).
 * Looked up in shell.db on every call.
 */
export async function staffRoleOf(
  principal: Principal | null | undefined,
): Promise<string | null> {
  if (!principal?.id || !principal.tenantId) return null;
  try {
    if (await isOwner(principal)) return null;
    return await runAs(principal, async () => {
      const db = await getShellDb();
      const memberships = await MembershipCollection.create({ db });
      const membership = await memberships.findByUserAndTenant(
        principal.id,
        principal.tenantId,
      );
      if (
        !membership ||
        membership.status !== MembershipStatus.ACTIVE ||
        !membership.roleId
      )
        return null;
      const roles = await RoleCollection.create({ db });
      const role = await roles.get(membership.roleId);
      const slug = role?.slug;
      return slug && slug !== DEFAULT_ROLE_SLUGS.OWNER ? slug : null;
    });
  } catch {
    return null;
  }
}

/**
 * The engine principal of a verified STAFF member (#5197): kind `user`, with
 * exactly the slugs the owner's per-model grants allow (`read` is list, get,
 * count; `create`; `update`), for models that still exist with the identity
 * the grant was stamped with, capped to `read` for the `viewer` role. Never
 * `_engine.owner`, never `delete` or a method slug. Empty permissions when the
 * user is the owner (who is not staff), is not an ACTIVE member of `tenant`,
 * or anything fails. Built only from a `Principal` taken from the session.
 */
export async function staffPrincipalFor(
  user: Principal,
  tenant: string,
  def: AppDefinition,
): Promise<EnginePrincipal> {
  const permissions: string[] = [];
  const role = user.tenantId === tenant ? await staffRoleOf(user) : null;
  if (role !== null) {
    try {
      const { rows, stamps } = await runAs(user, async () => {
        const db = await getShellDb();
        return {
          rows: await (await ModelAccessGrantCollection.create({ db })).list({
            limit: 10000,
          }),
          stamps: (await new ShellVersionStore(db, tenant).modelStamps())
            .stamps,
        };
      });
      const shared = sharedTableModels(def);
      const byModel = new Map<string, Set<AccessAction>>();
      for (const row of rows) {
        const model = row.modelName;
        const action = row.action;
        if (
          row.tenantId !== tenant ||
          !isAccessAction(action) ||
          !Object.hasOwn(def.models, model) ||
          shared.has(model) ||
          row.modelStamp !== stamps.get(model) ||
          (role === 'viewer' && action !== 'read')
        )
          continue;
        const set = byModel.get(model) ?? new Set<AccessAction>();
        set.add(action);
        byModel.set(model, set);
      }
      for (const [model, actions] of byModel)
        permissions.push(...slugsFor(def, model, actions));
    } catch {
      permissions.length = 0; // fail closed
    }
  }
  return enginePrincipal({
    kind: 'user',
    tenantId: tenant,
    userId: user.id,
    permissions: finalStaffSlugs(def, permissions),
  });
}
