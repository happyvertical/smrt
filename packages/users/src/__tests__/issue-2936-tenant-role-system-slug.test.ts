/**
 * Regression for #2936: a tenant-scoped Role created with a system role's slug
 * used to upsert onto the system row (conflict key `slug` alone), so
 * `findSystemRoleBySlug('owner')` returned null and owner bootstrap failed.
 * Tenant-led natural keys (#3313) made the key `(tenant_id, slug, context)`.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { DEFAULT_ROLES } from '../types/index.js';

describe('tenant Role sharing a system slug (#2936)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it('inserts a sibling row and leaves the system role intact', async () => {
    const roles = await RoleCollection.create({ db });
    const expected = DEFAULT_ROLES.map(({ id }) => id);
    expect((await roles.seedSystemRoles()).map(({ id }) => id)).toEqual(
      expected,
    );
    expect((await roles.seedSystemRoles()).map(({ id }) => id)).toEqual(
      expected,
    );
    const system = await roles.findSystemRoleBySlug('owner');
    expect(system?.isSystem).toBe(true);

    const tenant = await (await TenantCollection.create({ db })).create({
      name: 'Shop',
    });
    const tenantId = String(tenant.id);
    const shopOwner = await roles.create({
      slug: 'owner',
      name: 'Owner',
      tenantId,
      isSystem: false,
    });
    await shopOwner.save();

    const after = await roles.findSystemRoleBySlug('owner');
    expect(after?.id).toBe(system?.id);
    expect(after?.isSystem).toBe(true);
    expect(after?.tenantId ?? null).toBeNull();
    expect(shopOwner.id).not.toBe(system?.id);
    expect((await roles.findBySlug('owner', tenantId))?.id).toBe(shopOwner.id);
  });
  it('rolls back seeding when a reserved UUID belongs to a tenant role', async () => {
    const roles = await RoleCollection.create({ db });
    const tenant = await (await TenantCollection.create({ db })).create({
      name: 'Unrelated',
    });
    const tenantRole = await roles.create({
      id: DEFAULT_ROLES[1].id,
      slug: 'owner',
      name: 'Unrelated role',
      tenantId: String(tenant.id),
      isSystem: false,
    });
    await expect(roles.seedSystemRoles()).rejects.toThrow();
    expect(await roles.findSystemRoleBySlug('owner')).toBeNull();
    expect((await roles.get(DEFAULT_ROLES[1].id))?.id).toBe(tenantRole.id);
    expect((await roles.get(DEFAULT_ROLES[1].id))?.isSystem).toBe(false);
  });
});
