// Cloud profile accounts: sign-up and sign-in resolve to ONE tenant per
// account, with the account as its owner.
//
// The tenant's app row (the tenant-to-app mapping, `version-store.ts`) is made
// on the tenant's first request, inside its own session, not here: a sign-up
// runs before any tenant context exists.
//
// Identity comes from the hosted identity provider (OIDC, `packages/users`):
// the callback route (`routes/auth/[provider]/callback`) lets `smrt-users`
// verify the claims and create the user, then asks `ownerTenantFor` which
// tenant the new session belongs to. The first sign-in creates the tenant and
// the owner membership; every later sign-in finds them. A session is always
// minted fresh by `smrt-users` for that tenant (the presented cookie is never
// adopted), so a session cannot be carried from one tenant to another.
//
// Tenant and membership ids are derived from the user id and inserted
// insert-only, so two concurrent first sign-ins of the same account cannot
// create two tenants: the second insert collides and the retry finds the
// first. Nothing here reads a tenant from the request.
import { createHash } from 'node:crypto';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  TenantCollection,
  TenantService,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';

/** A UUID derived from the user id and a purpose label (stable, not secret). */
export function derivedId(userId: string, purpose: string): string {
  const h = createHash('sha256').update(`${purpose}\0${userId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5 layout
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export class AccountError extends Error {
  readonly code: 'ambiguous_tenant' | 'no_owner_role';
  constructor(code: AccountError['code'], message: string) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
  }
}

/** The tenant an account owns, or null when it has none yet. */
async function ownedTenantId(
  db: DatabaseInterface,
  userId: string,
): Promise<string | null> {
  const roles = await RoleCollection.create({ db });
  const ownerRole = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  if (!ownerRole?.id) return null;
  const memberships = await (
    await MembershipCollection.create({ db })
  ).findActiveByUser(userId);
  const owned = memberships.filter(
    (m) => m.roleId === ownerRole.id && m.status === MembershipStatus.ACTIVE,
  );
  // One tenant per account for now. More than one is a data problem the
  // sign-in must not guess its way through.
  if (owned.length > 1)
    throw new AccountError(
      'ambiguous_tenant',
      'this account owns more than one workspace',
    );
  return (owned[0]?.tenantId as string | undefined) ?? null;
}

const inFlight = new Map<string, Promise<string>>();

/**
 * The tenant a sign-in belongs to: the account's own workspace, created with
 * its owner membership and its app mapping on the first call. Idempotent.
 * Only trusted code that has just verified the identity may call this.
 */
export function ownerTenantFor(
  db: DatabaseInterface,
  user: { id: string; name?: string | null; email?: string | null },
): Promise<string> {
  const running = inFlight.get(user.id);
  if (running) return running;
  const work = provision(db, user).finally(() => inFlight.delete(user.id));
  inFlight.set(user.id, work);
  return work;
}

async function provision(
  db: DatabaseInterface,
  user: { id: string; name?: string | null; email?: string | null },
): Promise<string> {
  const existing = await ownedTenantId(db, user.id);
  if (existing) return existing;
  const tenantId = derivedId(user.id, 'shell-tenant');
  const membershipId = derivedId(user.id, 'shell-membership');
  const slug = `ws-${tenantId}`;
  const run = async (tx: DatabaseInterface): Promise<string> => {
    // `Tenant` upserts on its slug: look it up first so a collision is a
    // refusal, never an overwrite of someone else's tenant.
    const tenants = await TenantCollection.create({ db: tx });
    if (await tenants.findBySlug(slug)) {
      const raced = await ownedTenantId(tx, user.id);
      if (raced) return raced;
      throw new AccountError(
        'ambiguous_tenant',
        'the workspace for this account already exists',
      );
    }
    const service = await TenantService.create(
      { db: tx },
      {
        mode: 'required',
        maxTenants: 1,
        defaultName: 'My workspace',
      },
    );
    const name = user.name?.trim()
      ? `${user.name.trim()}'s workspace`
      : 'My workspace';
    const { tenant } = await service.createTenantWithOwnership(user.id, name, {
      slug,
      reservedIdentity: { tenantId, membershipId },
    });
    return tenant.id as string;
  };
  try {
    return typeof db.transaction === 'function'
      ? await db.transaction(async (tx) =>
          run(tx as unknown as DatabaseInterface),
        )
      : await run(db);
  } catch (error) {
    // A concurrent first sign-in won the insert: its tenant is the answer.
    const winner = await ownedTenantId(db, user.id).catch(() => null);
    if (winner) return winner;
    throw error;
  }
}
