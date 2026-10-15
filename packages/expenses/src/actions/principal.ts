/**
 * The acting principal for the generated service-backed expense actions
 * (#4001).
 *
 * Identity always comes from the ambient request context, never from the
 * request body: the tenancy ALS (`withTenant`, the SvelteKit/Express
 * adapters) first, then the authenticated smrt-users session-permission ALS
 * (`createSessionHandler()` without `enterTenantContext`). This is the
 * smrt-fields / smrt-preferences precedent. Authorization goes through
 * smrt-users' `assertOperationPermission()` against the principal's published
 * permission snapshot, so ceilings, super-admin and catalog presence behave
 * exactly as they do for every other guarded operation.
 */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import {
  assertOperationPermission,
  getCurrentSessionPermissionContext,
  type OperationPermissionCollectionInput,
  OperationPermissionError,
  UserCollection,
} from '@happyvertical/smrt-users';

/** A refused action with a 4xx status the generated transports serialize. */
export class ExpenseActionError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ExpenseActionError';
    this.status = status;
    this.code = code;
    this.publicMessage = message;
  }
}

/** Who is acting, resolved from the ambient context. */
export interface ExpenseActionPrincipal {
  tenantId: string;
  userId: string;
  permissions: ReadonlySet<string>;
  /** smrt-profiles Profile linked to the user; stamped into audit fields. */
  profileId: string;
  /** True when the tenancy ALS already carries this principal. */
  fromTenancy: boolean;
}

interface AmbientPrincipal {
  tenantId: string | null;
  userId: string | null;
  permissions: ReadonlySet<string>;
  profileId: string | null;
  fromTenancy: boolean;
}

function profileIdOf(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const value = (user as { profileId?: unknown }).profileId;
  return typeof value === 'string' && value ? value : null;
}

function ambientPrincipal(): AmbientPrincipal {
  const tenant = getCurrentTenant();
  const session = getCurrentSessionPermissionContext();
  if (tenant?.tenantId) {
    // Generated SvelteKit routes enter `{ tenantId, userId, permissions }`
    // without the user object; the same person's session still carries it.
    const sessionProfile =
      session?.userId && session.userId === tenant.userId
        ? profileIdOf(session.user)
        : null;
    return {
      tenantId: tenant.tenantId,
      userId: tenant.userId ?? null,
      permissions: tenant.permissions,
      profileId: profileIdOf(tenant.user) ?? sessionProfile,
      fromTenancy: true,
    };
  }
  return {
    tenantId: session?.tenantId ?? null,
    userId: session?.userId ?? null,
    permissions: session?.permissionSet ?? new Set<string>(),
    profileId: profileIdOf(session?.user),
    fromTenancy: false,
  };
}

async function loadProfileId(
  userId: string,
  options: SmrtClassOptions,
): Promise<string | null> {
  try {
    const users = await UserCollection.create({
      db: options.db ?? options.persistence,
    } as SmrtClassOptions);
    return profileIdOf(await users.get({ id: userId }));
  } catch {
    return null;
  }
}

/** True when the ambient principal holds `<collection>.<action>`. */
export async function principalHolds(
  collection: OperationPermissionCollectionInput,
  action: string,
  options: SmrtClassOptions,
): Promise<boolean> {
  const ambient = ambientPrincipal();
  try {
    await assertOperationPermission({
      collection,
      action,
      db: options.db ?? options.persistence,
      tenantId: ambient.tenantId,
      userId: ambient.userId,
      permissionSet: ambient.permissions,
      allowSystemContextBypass: false,
      allowSuperAdminBypass: false,
    });
    return true;
  } catch (error) {
    if (error instanceof OperationPermissionError) return false;
    throw error;
  }
}

/**
 * Authorize `<collection>.<action>` for the ambient principal and resolve the
 * profile it acts as. Fails closed (403) without an authenticated,
 * tenant-bound principal, without the permission, or without a linked
 * profile — an action always records who took it.
 *
 * System context never bypasses: trusted server code without a person calls
 * the `Expense` methods directly. `allowSuperAdminBypass: false` is for
 * money and separation-of-duties operations that need an explicit grant.
 */
export async function authorizeExpenseAction(
  collection: OperationPermissionCollectionInput,
  action: string,
  options: SmrtClassOptions,
  guard: { allowSuperAdminBypass: boolean },
): Promise<ExpenseActionPrincipal> {
  const ambient = ambientPrincipal();
  try {
    await assertOperationPermission({
      collection,
      action,
      db: options.db ?? options.persistence,
      tenantId: ambient.tenantId,
      userId: ambient.userId,
      permissionSet: ambient.permissions,
      allowSystemContextBypass: false,
      allowSuperAdminBypass: guard.allowSuperAdminBypass,
    });
  } catch (error) {
    if (error instanceof OperationPermissionError) {
      throw new ExpenseActionError(403, 'permission_denied', error.message);
    }
    throw error;
  }
  if (!ambient.tenantId || !ambient.userId) {
    throw new ExpenseActionError(
      403,
      'permission_denied',
      'Expense actions need an authenticated tenant context.',
    );
  }
  const profileId =
    ambient.profileId ?? (await loadProfileId(ambient.userId, options));
  if (!profileId) {
    throw new ExpenseActionError(
      403,
      'actor_profile_required',
      'Expense actions need a user with a linked profile.',
    );
  }
  return {
    tenantId: ambient.tenantId,
    userId: ambient.userId,
    permissions: ambient.permissions,
    profileId,
    fromTenancy: ambient.fromTenancy,
  };
}

/**
 * Run `fn` with the tenancy ALS carrying `principal`, so the tenancy
 * interceptor scopes every read and write. A session-only principal is
 * entered with the same tenant, user and permissions; nothing is widened.
 */
export async function withActionPrincipal<T>(
  principal: ExpenseActionPrincipal,
  fn: () => Promise<T>,
): Promise<T> {
  if (principal.fromTenancy) return fn();
  return withTenant(
    {
      tenantId: principal.tenantId,
      userId: principal.userId,
      permissions: new Set(principal.permissions),
    },
    fn,
  );
}
