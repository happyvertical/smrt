import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { Person, ProfileTypeCollection } from '@happyvertical/smrt-profiles';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import {
  generatePostgresPermissionSql,
  getCurrentSessionPermissionContext,
  MembershipCollection,
  MembershipStatus,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  TenantStatus,
  UserCollection,
  withPrincipalPermissionContext,
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
  let restricted: DatabaseInterface | undefined;
  let restrictedRole: string | undefined;
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
    await restricted?.close?.();
    restricted = undefined;
    await db.close?.();
    if (admin && schema)
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (admin && restrictedRole)
      await admin.query(`DROP ROLE IF EXISTS "${restrictedRole}"`);
    restrictedRole = undefined;
    await admin?.close?.();
    admin = undefined;
    schema = undefined;
  });

  it.skipIf(process.env.TEST_DB_ADAPTER !== 'postgres')(
    'fails closed under actual PostgreSQL RLS without changing caller authority',
    async () => {
      if (!admin || !schema || !process.env.DATABASE_URL)
        throw new Error('Missing PostgreSQL fixture');
      await getTestDatabase({
        db,
        classes: [
          ...classes,
          'Permission',
          'RolePermission',
          'MembershipOverride',
          'GroupMember',
          'GroupRole',
          'Group',
          'TenantPermissionOverride',
        ],
      });
      const generated = generatePostgresPermissionSql();
      const target = generated.targets.find(
        (item) => item.tableName === 'education_groups',
      );
      const readPermission = target?.actions.SELECT?.[0];
      if (!readPermission)
        throw new Error('Missing canonical group SELECT policy');
      const applyPolicies = async () => {
        for (const sql of generated.statements) {
          if (sql.startsWith('CREATE OR REPLACE FUNCTION')) await db.query(sql);
          else if (sql.includes('"public"."education_groups"'))
            await db.query(
              sql.replaceAll(
                '"public"."education_groups"',
                `"${schema}"."education_groups"`,
              ),
            );
        }
      };
      await applyPolicies();
      const member = await (
        await MembershipCollection.create({ db })
      ).findByUserAndTenant(userId, groupTenantId);
      if (!member) throw new Error('Missing group actor');
      const permission = await (
        await PermissionCollection.create({ db })
      ).findOrCreate(readPermission);
      await (await RolePermissionCollection.create({ db })).addPermission(
        member.roleId,
        permission.id as string,
      );
      const familyRole = await (await RoleCollection.create({ db })).create({
        tenantId: familyId,
        name: 'Family actor',
        slug: randomUUID(),
      });
      await (await MembershipCollection.create({ db })).create({
        userId,
        tenantId: familyId,
        roleId: familyRole.id as string,
        status: MembershipStatus.ACTIVE,
      });
      restrictedRole = `kind_reader_${randomUUID().replaceAll('-', '')}`;
      await admin.query(
        `CREATE ROLE "${restrictedRole}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`,
      );
      await db.query(
        `GRANT USAGE ON SCHEMA "${schema}" TO "${restrictedRole}"`,
      );
      await db.query(
        `GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${restrictedRole}"`,
      );
      const url = new URL(process.env.DATABASE_URL);
      url.username = restrictedRole;
      url.password = '';
      url.searchParams.set('options', `-c search_path=${schema}`);
      restricted = await getDatabase({
        type: 'postgres',
        url: url.toString(),
        dbid: randomUUID(),
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]);
      expect(
        (
          await restricted.query(
            'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
          )
        ).rows[0],
      ).toEqual({ rolsuper: false, rolbypassrls: false });
      const settings = async (executor: DatabaseInterface) =>
        (
          await executor.query(
            "SELECT current_user, current_setting('smrt.tenant_id', true) AS tenant, current_setting('smrt.user_id', true) AS actor, current_setting('smrt.session_id', true) AS session, current_setting('smrt.permissions', true) AS permissions, current_setting('smrt.system_context', true) AS system, current_setting('smrt.super_admin_bypass', true) AS bypass",
          )
        ).rows;
      // A wrapper may reset initially absent custom GUCs to empty strings after
      // SET LOCAL. Inside its transaction compare raw values without normalization.
      const outsideSettings = async (executor: DatabaseInterface) =>
        (await settings(executor)).map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, value || null]),
          ),
        );
      const run = async (tenantId: string | null, visible: boolean) => {
        await withPrincipalPermissionContext(
          {
            db: restricted,
            userId,
            tenantId,
            postgresRls: true,
            enterTenantContext: true,
          },
          async (context) => {
            const executor = context.database;
            if (!executor) throw new Error('Missing principal executor');
            const before = await settings(executor);
            const tenantContext = getCurrentTenant();
            const permissionContext = getCurrentSessionPermissionContext();
            if (visible)
              expect(await isGroupTenant(executor, groupTenantId)).toBe(true);
            else
              await expect(
                isGroupTenant(executor, groupTenantId),
              ).rejects.toThrow('Tenant kind is unavailable');
            // Even a real family actor cannot prove absence through a filtered table.
            await expect(isGroupTenant(executor, familyId)).rejects.toThrow(
              'Tenant kind is unavailable',
            );
            await expect(isGroupTenant(executor, '')).rejects.toThrow(
              'Tenant kind is unavailable',
            );
            await expect(isGroupTenant(executor, randomUUID())).rejects.toThrow(
              'Tenant kind is unavailable',
            );
            expect(await settings(executor)).toEqual(before);
            expect(getCurrentTenant()).toBe(tenantContext);
            expect(getCurrentSessionPermissionContext()).toBe(
              permissionContext,
            );
          },
        );
      };
      const outside = await outsideSettings(restricted);
      await run(familyId, false);
      await run(groupTenantId, true);
      await run(null, false);
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
      await run(groupTenantId, true);
      member.status = MembershipStatus.INACTIVE;
      await member.save();
      await run(groupTenantId, false);
      await db.query('DELETE FROM memberships WHERE id = ?', member.id);
      await run(groupTenantId, false);
      // The helper never elevates; an already trusted metadata executor can
      // establish absence, while the ordinary principal cannot.
      expect(await isGroupTenant(db, familyId)).toBe(false);
      expect(await isGroupTenant(db, groupTenantId)).toBe(true);
      // SET LOCAL cleanup belongs to the public principal wrapper, not helper.
      const after = await outsideSettings(restricted);
      expect(after).toEqual(outside);
      // Corrupt only this fixture to prove that two RLS-visible rows are
      // rejected as ambiguous, using the same generated policies and actor.
      await db.query(
        'ALTER TABLE education_groups RENAME TO original_education_groups',
      );
      await db.query(
        'CREATE TABLE education_groups AS SELECT * FROM original_education_groups',
      );
      await db.query(
        'INSERT INTO education_groups SELECT * FROM original_education_groups',
      );
      await applyPolicies();
      await db.query(`GRANT SELECT ON education_groups TO "${restrictedRole}"`);
      await (await MembershipCollection.create({ db })).create({
        userId,
        tenantId: groupTenantId,
        roleId: member.roleId,
        status: MembershipStatus.ACTIVE,
      });
      await withPrincipalPermissionContext(
        { db: restricted, userId, tenantId: groupTenantId, postgresRls: true },
        async (context) => {
          if (!context.database) throw new Error('Missing principal executor');
          const before = await settings(context.database);
          expect(
            (
              await context.database.query(
                'SELECT id FROM education_groups WHERE tenant_id = ?',
                groupTenantId,
              )
            ).rows,
          ).toHaveLength(2);
          await expect(
            isGroupTenant(context.database, groupTenantId),
          ).rejects.toThrow('Tenant kind is unavailable');
          expect(await settings(context.database)).toEqual(before);
        },
      );
      expect((await db.query('SELECT id FROM sessions')).rows).toHaveLength(0);
    },
  );
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
