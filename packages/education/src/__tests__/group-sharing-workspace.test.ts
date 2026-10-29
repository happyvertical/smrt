import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { Person, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  TenantCollection,
  TenantStatus,
  UserCollection,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EducationGroupCollection } from '../group-sharing-models.js';
import { isGroupTenant } from '../group-sharing-workspace.js';

const classes = [
  'Tenant',
  'User',
  'Membership',
  'Role',
  'Profile',
  'ProfileType',
  'Person',
  'Session',
  'EducationGroup',
];
describe('trusted exact workspace-kind metadata', () => {
  let db: DatabaseInterface;
  let admin: DatabaseInterface | undefined;
  let schema: string | undefined;
  let familyId: string;
  let groupId: string;
  let groupTenantId: string;
  let userId: string;
  beforeEach(async () => {
    if (process.env.TEST_DB_ADAPTER === 'postgres') {
      if (!process.env.DATABASE_URL)
        throw new Error('Explicit isolated DATABASE_URL required');
      admin = await getDatabase({
        type: 'postgres',
        url: process.env.DATABASE_URL,
        dbid: randomUUID(),
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]);
      schema = `workspace_kind_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const url = new URL(process.env.DATABASE_URL);
      // Strictly isolate schema lookup: a renamed local table must not fall
      // through to a manager-owned public fixture table with the same name.
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        dbid: randomUUID(),
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]);
      await getTestDatabase({ db, classes });
    } else
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:', classes });
    const tenants = await TenantCollection.create({ db });
    familyId = (await tenants.create({ name: 'Family', slug: randomUUID() }))
      .id as string;
    groupTenantId = (
      await tenants.create({
        name: 'Private group tenant name',
        slug: randomUUID(),
      })
    ).id as string;
    const type = await (await ProfileTypeCollection.create({ db })).create({
      name: 'Person',
      slug: randomUUID(),
    });
    const profile = new Person({
      db,
      name: 'Supervisor',
      typeId: type.id as string,
    });
    await profile.initialize();
    await profile.save();
    const user = await (await UserCollection.create({ db })).create({
      profileId: profile.id as string,
      email: '',
    });
    userId = user.id as string;
    const role = await (await RoleCollection.create({ db })).create({
      tenantId: groupTenantId,
      name: 'Staff',
      slug: randomUUID(),
    });
    await (await MembershipCollection.create({ db })).create({
      userId,
      tenantId: groupTenantId,
      roleId: role.id as string,
      status: MembershipStatus.ACTIVE,
    });
    groupId = await withTenant(
      { tenantId: groupTenantId },
      async () =>
        (
          await (
            await EducationGroupCollection.create({ db })
          ).create({
            tenantId: groupTenantId,
            name: 'Private group name',
            creatorUserId: userId,
            creatorProfileId: profile.id as string,
          })
        ).id as string,
    );
  });
  afterEach(async () => {
    await db.close?.();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close?.();
    admin = undefined;
    schema = undefined;
  });
  it('returns only exact family/group kind without creating a session or context', async () => {
    const context = getCurrentTenant();
    const before = (await db.query('SELECT id FROM sessions')).rows;
    expect(await isGroupTenant(db, familyId)).toBe(false);
    expect(await isGroupTenant(db, groupTenantId)).toBe(true);
    expect(getCurrentTenant()).toBe(context);
    expect((await db.query('SELECT id FROM sessions')).rows).toEqual(before);
    expect(before).toHaveLength(0);
  });
  it('keeps disabled group and inactive Tenant classified as group metadata', async () => {
    await db.query(
      'UPDATE education_groups SET active = ? WHERE id = ?',
      false,
      groupId,
    );
    await db.query(
      'UPDATE tenants SET status = ? WHERE id = ?',
      TenantStatus.SUSPENDED,
      groupTenantId,
    );
    expect(await isGroupTenant(db, groupTenantId)).toBe(true);
  });
  it('does not treat missing or revoked staff membership and role as family', async () => {
    const members = await MembershipCollection.create({ db });
    const member = await members.findByUserAndTenant(userId, groupTenantId);
    if (!member) throw new Error('Missing fixture membership');
    member.status = MembershipStatus.INACTIVE;
    await member.save();
    expect(await isGroupTenant(db, groupTenantId)).toBe(true);
    await db.query('DELETE FROM memberships WHERE id = ?', member.id);
    await db.query('DELETE FROM roles WHERE id = ?', member.roleId);
    expect(await isGroupTenant(db, groupTenantId)).toBe(true);
  });
  it.each([
    undefined,
    null,
    '',
    '  ',
    'not-a-tenant',
    'tenant-id',
    '00000000-0000-0000-0000-000000000000',
  ])('refuses malformed or tenantless scope %s', async (tenant) => {
    await expect(isGroupTenant(db, tenant as string)).rejects.toThrow(
      'Tenant kind is unavailable',
    );
  });
  it('refuses a missing exact Tenant instead of silently assuming family', async () => {
    await expect(isGroupTenant(db, randomUUID())).rejects.toThrow(
      'Tenant kind is unavailable',
    );
    await expect(isGroupTenant(db, ` ${familyId} `)).rejects.toThrow(
      'Tenant kind is unavailable',
    );
  });
  it('fails closed on ambiguous rows even if the owning unique schema is corrupted', async () => {
    // Explicitly corrupt only this isolated fixture's table to test the read
    // boundary independently from the normal unique tenant_id schema arbiter.
    await db.query(
      'ALTER TABLE education_groups RENAME TO original_education_groups',
    );
    await db.query(
      'CREATE TABLE education_groups AS SELECT * FROM original_education_groups',
    );
    await db.query(
      'INSERT INTO education_groups SELECT * FROM original_education_groups',
    );
    await expect(isGroupTenant(db, groupTenantId)).rejects.toThrow(
      'Tenant kind is unavailable',
    );
  });
  it('uses the supplied executor freshly and propagates owning table failures', async () => {
    await db.transaction(async (tx) => {
      expect(await isGroupTenant(tx, familyId)).toBe(false);
      await tx.query(
        'UPDATE education_groups SET tenant_id = ? WHERE id = ?',
        familyId,
        groupId,
      );
      expect(await isGroupTenant(tx, familyId)).toBe(true);
      expect(await isGroupTenant(tx, groupTenantId)).toBe(false);
    });
    await db.query(
      'ALTER TABLE education_groups RENAME TO unavailable_education_groups',
    );
    await expect(isGroupTenant(db, familyId)).rejects.toThrow();
  });
});
