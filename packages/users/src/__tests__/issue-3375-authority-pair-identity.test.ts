/**
 * #3375: MembershipOverride, TenantPermissionOverride and GroupMember are
 * unique on their natural-key pair. Concurrent writes converge on one row,
 * a later write's effect wins, and removal clears the pair.
 *
 * Runs on the configured test database (SQLite by default, PostgreSQL under
 * `test:postgres`), where concurrent first inserts genuinely race.
 */
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupCollection } from '../collections/GroupCollection.js';
import { GroupMemberCollection } from '../collections/GroupMemberCollection.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { MembershipOverrideCollection } from '../collections/MembershipOverrideCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { TenantPermissionOverrideCollection } from '../collections/TenantPermissionOverrideCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { OverrideEffect, TenantPermissionEffect } from '../types/index.js';

describe('authority pair identity (#3375)', () => {
  let isolated: IsolatedTestDbResult | undefined;

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function fixture() {
    isolated = await createIsolatedTestDbFromManifest();
    const db = isolated.db;
    const options = { db };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const memberships = await MembershipCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const groups = await GroupCollection.create(options);
    const user = await users.create({ email: 'pair-3375@example.com' });
    const tenant = await tenants.create({ name: 'Pairs 3375' });
    const role = await roles.create({ name: 'Pairs', slug: 'pairs-3375' });
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    const permission = await permissions.create({ slug: 'documents.read' });
    const other = await permissions.create({ slug: 'documents.update' });
    const group = await groups.create({ name: 'Crew', tenantId: tenant.id });
    return {
      db,
      options,
      userId: user.id as string,
      tenantId: tenant.id as string,
      membershipId: membership.id as string,
      permissionId: permission.id as string,
      otherPermissionId: other.id as string,
      groupId: group.id as string,
    };
  }

  it('membership overrides converge, update in place and remove by pair', async () => {
    const f = await fixture();
    const overrides = await MembershipOverrideCollection.create(f.options);
    const set = () =>
      overrides.setOverride(
        f.membershipId,
        f.permissionId,
        OverrideEffect.GRANT,
      );
    const results = await Promise.all([set(), set(), set(), set()]);
    const rows = await overrides.list({
      where: { membershipId: f.membershipId, permissionId: f.permissionId },
    });
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((row) => row.id))).toEqual(
      new Set([rows[0].id]),
    );

    const denied = await overrides.denyPermission(
      f.membershipId,
      f.permissionId,
    );
    expect(denied.id).toBe(rows[0].id);
    expect(await overrides.getDeniedPermissionIds(f.membershipId)).toEqual([
      f.permissionId,
    ]);
    expect(await overrides.getGrantedPermissionIds(f.membershipId)).toEqual([]);

    await overrides.grantPermission(f.membershipId, f.otherPermissionId);
    expect(await overrides.removeOverride(f.membershipId, f.permissionId)).toBe(
      true,
    );
    expect(await overrides.removeOverride(f.membershipId, f.permissionId)).toBe(
      false,
    );
    const remaining = await overrides.findByMembership(f.membershipId);
    expect(remaining.map((row) => row.permissionId)).toEqual([
      f.otherPermissionId,
    ]);
    // The pair is enforced by the schema, not just by the collection.
    await expect(
      f.db.query(
        `INSERT INTO membership_overrides (id, slug, context, membership_id, permission_id, effect, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, 'grant', ?, ?)`,
        crypto.randomUUID(),
        'duplicate-3375',
        f.membershipId,
        f.otherPermissionId,
        new Date().toISOString(),
        new Date().toISOString(),
      ),
    ).rejects.toThrow();
  });

  it('tenant permission overrides converge and remove by pair', async () => {
    const f = await fixture();
    const overrides = await TenantPermissionOverrideCollection.create(
      f.options,
    );
    await Promise.all([
      overrides.grantPermission(f.tenantId, f.permissionId),
      overrides.grantPermission(f.tenantId, f.permissionId),
      overrides.grantPermission(f.tenantId, f.permissionId),
    ]);
    expect(
      await overrides.list({
        where: { tenantId: f.tenantId, permissionId: f.permissionId },
      }),
    ).toHaveLength(1);
    await overrides.inheritPermission(f.tenantId, f.permissionId);
    const [row] = await overrides.findByTenant(f.tenantId);
    expect(row.effect).toBe(TenantPermissionEffect.INHERIT);
    expect(await overrides.removeOverride(f.tenantId, f.permissionId)).toBe(
      true,
    );
    expect(await overrides.findByTenant(f.tenantId)).toEqual([]);
  });

  it('group membership converges and removes by pair', async () => {
    const f = await fixture();
    const members = await GroupMemberCollection.create(f.options);
    const added = await Promise.all([
      members.addMember(f.groupId, f.userId),
      members.addMember(f.groupId, f.userId),
      members.addMember(f.groupId, f.userId),
    ]);
    const rows = await members.findByGroup(f.groupId);
    expect(rows).toHaveLength(1);
    expect(new Set(added.map((row) => row.id))).toEqual(new Set([rows[0].id]));
    expect(await members.removeMember(f.groupId, f.userId)).toBe(true);
    expect(await members.isMember(f.groupId, f.userId)).toBe(false);
  });
});
