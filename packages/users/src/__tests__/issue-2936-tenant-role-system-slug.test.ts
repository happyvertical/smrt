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
  it('refuses a global role at an unreserved UUID without granting authority', async () => {
    const roles = await RoleCollection.create({ db });
    const oldId = crypto.randomUUID();
    await roles.create({
      id: oldId,
      slug: 'owner',
      name: 'Legacy owner',
      tenantId: null,
      isSystem: true,
    });

    await expect(
      roles.seedSystemRoles({ inheritsToDescendants: ['owner'] }),
    ).rejects.toThrow("System role identity collision for 'owner'");
    expect((await roles.list()).map(({ id }) => id)).toEqual([oldId]);
    expect(await roles.findSystemRoleBySlug('owner')).toBeNull();
    expect(await roles.get(oldId)).toMatchObject({
      name: 'Legacy owner',
      inheritsToDescendants: false,
    });
  });

  it('refuses a reserved UUID impostor even when the legitimate role has an older ID', async () => {
    const roles = await RoleCollection.create({ db });
    const legacy = await roles.create({
      slug: 'owner',
      name: 'Legacy owner',
      tenantId: null,
      isSystem: true,
    });
    await roles.create({
      id: DEFAULT_ROLES[0].id,
      slug: 'impostor',
      name: 'Impostor',
      tenantId: null,
      isSystem: false,
    });

    await expect(roles.seedSystemRoles()).rejects.toThrow(
      "System role identity collision for 'owner'",
    );
    expect(await roles.findSystemRoleBySlug('owner')).toBeNull();
    expect(await roles.get(String(legacy.id))).toMatchObject({ slug: 'owner' });
    expect(await roles.get(DEFAULT_ROLES[0].id)).toMatchObject({
      slug: 'impostor',
      isSystem: false,
    });
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

describe('system role seeding in a caller-owned DuckDB transaction', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Role'],
      // DuckDB cannot create users' ON UPDATE CASCADE relationships.
      omitForeignKeyConstraints: true,
    });
  });

  afterEach(async () => {
    await db?.close?.();
  });

  it.each([
    'global slug',
    'tenant primary key',
  ] as const)('leaves no partial roles when the caller catches a %s collision', async (collision) => {
    const roles = await RoleCollection.create({ db });
    const impostor = await roles.create({
      ...(collision === 'global slug'
        ? { slug: 'admin', tenantId: null }
        : {
            id: DEFAULT_ROLES[1].id,
            slug: 'tenant-admin',
            tenantId: crypto.randomUUID(),
          }),
      name: 'Impostor',
      isSystem: false,
      _insertOnly: true,
    });
    if (!db.transaction) throw new Error('DuckDB transaction is required');
    await db.transaction(async (tx) => {
      const bound = await RoleCollection.create({ db: tx });
      await expect(bound.seedSystemRoles()).rejects.toThrow();
    });
    expect((await roles.list()).map(({ id }) => id)).toEqual([impostor.id]);
  });

  it('commits a successful seed through the joined transaction', async () => {
    if (!db.transaction) throw new Error('DuckDB transaction is required');
    await db.transaction(async (tx) => {
      const roles = await RoleCollection.create({ db: tx });
      const seeded = await roles.seedSystemRoles();
      expect(seeded.map(({ id }) => id)).toEqual(
        DEFAULT_ROLES.map(({ id }) => id),
      );
      seeded[0].name = 'Caller-owned owner';
      await seeded[0].save();
    });
    const roles = await RoleCollection.create({ db });
    expect(await roles.findSystemRoleBySlug('owner')).toMatchObject({
      id: DEFAULT_ROLES[0].id,
      name: 'Caller-owned owner',
    });
  });
});
