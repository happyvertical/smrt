import { getTestDatabase } from '@happyvertical/smrt-core';
import { expect, it } from 'vitest';
import '../models/index.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { TenantService } from '../services/TenantService.js';
import { DEFAULT_ROLES, MembershipStatus } from '../types/index.js';

it('applies tenant quotas and preserves ownership on reserved identity collisions', async () => {
  const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  try {
    const transaction = db.transaction?.bind(db);
    if (!transaction) throw new Error('SQLite transaction is required');
    const users = await UserCollection.create({ db });
    const owner = await users.create({ email: 'owner@example.com' });
    const other = await users.create({ email: 'other@example.com' });
    const ownerId = String(owner.id);
    const otherId = String(other.id);
    const tenantId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const policy = {
      mode: 'flexible',
      maxTenants: 1,
      defaultName: 'Workspace',
    } as const;
    const create = (
      userId: string,
      slug: string,
      reservedIdentity: {
        tenantId: string;
        membershipId: string;
      },
    ) =>
      transaction(async (tx) => {
        const service = await TenantService.create({ db: tx }, policy);
        return service.createTenantWithOwnership(userId, 'Workspace', {
          slug,
          reservedIdentity,
        });
      });
    const { tenant, membership } = await create(ownerId, 'workspace', {
      tenantId,
      membershipId,
    });
    expect(tenant).toMatchObject({ id: tenantId, slug: 'workspace' });
    expect(membership).toMatchObject({
      id: membershipId,
      userId: ownerId,
      tenantId,
      roleId: DEFAULT_ROLES[0].id,
      status: MembershipStatus.ACTIVE,
    });

    await expect(
      create(ownerId, 'extra', {
        tenantId: crypto.randomUUID(),
        membershipId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/maximum tenant limit/);
    await expect(
      create(otherId, 'occupied-tenant-id', {
        tenantId,
        membershipId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();
    await expect(
      create(otherId, 'occupied-membership-id', {
        tenantId: crypto.randomUUID(),
        membershipId,
      }),
    ).rejects.toThrow();

    const tenants = await TenantCollection.create({ db });
    const memberships = await MembershipCollection.create({ db });
    expect((await tenants.list()).map(({ id }) => id)).toEqual([tenantId]);
    expect(await memberships.list()).toMatchObject([
      { id: membershipId, userId: ownerId, tenantId },
    ]);
  } finally {
    await db.close?.();
  }
});
