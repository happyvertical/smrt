/**
 * `seedMessagesRolePermissions()` (#5162): the additive, idempotent
 * system-role matrix for the `messages.*` slugs. Without it a fresh app fails
 * closed on every grant and on `messages.manage-access`, owners included.
 */

import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MESSAGES_ROLE_PERMISSION_MATRIX,
  seedMessagesRolePermissions,
} from '../permissions.js';

describe('seedMessagesRolePermissions (#5162)', () => {
  let db: DatabaseInterface;
  let options: { db: DatabaseInterface };

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    options = { db };
    await (await RoleCollection.create(options)).seedSystemRoles();
  });
  afterEach(async () => db.close?.());

  async function slugsOf(roleSlug: string, tenantId: string | null = null) {
    const roles = await RoleCollection.create(options);
    const role = (await roles.list({ where: { slug: roleSlug, tenantId } }))[0];
    if (!role?.id) return null;
    const grants = await (await RolePermissionCollection.create(options)).list({
      where: { roleId: role.id },
    });
    const permissions = await PermissionCollection.create(options);
    const slugs: string[] = [];
    for (const grant of grants) {
      const permission = await permissions.get({ id: grant.permissionId });
      if (permission?.slug?.startsWith('messages.'))
        slugs.push(permission.slug);
    }
    return slugs.sort();
  }

  it('grants the matrix to the system roles', async () => {
    const result = await seedMessagesRolePermissions(options);
    expect(result.missingRoles).toEqual([]);
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(await slugsOf(role)).toEqual(
        [...MESSAGES_ROLE_PERMISSION_MATRIX[role]].sort(),
      );
    }
    expect(await slugsOf('owner')).toHaveLength(6);
    expect(await slugsOf('member')).toEqual([
      'messages.draft',
      'messages.read',
      'messages.send',
      'messages.triage',
    ]);
    expect(await slugsOf('viewer')).toEqual(['messages.read']);
    // The persona routing slug is not part of the mail matrix.
    expect(await slugsOf('admin')).not.toContain('messages.manage-routes');
  });

  it('is idempotent: a rerun adds nothing', async () => {
    await seedMessagesRolePermissions(options);
    const again = await seedMessagesRolePermissions(options);
    expect(again.added).toEqual({});
    expect(await slugsOf('viewer')).toEqual(['messages.read']);
  });

  it('is additive: never removes a grant an app made, and never touches tenant roles', async () => {
    await seedMessagesRolePermissions(options);
    const roles = await RoleCollection.create(options);
    const viewer = (
      await roles.list({ where: { slug: 'viewer', tenantId: null } })
    )[0];
    const permissions = await PermissionCollection.create(options);
    const extra = await permissions.findBySlug('messages.manage-routes');
    expect(extra?.id).toBeTruthy();
    await (await RolePermissionCollection.create(options)).addPermission(
      viewer.id as string,
      extra?.id as string,
    );
    // A tenant-owned role that shares a system role's slug.
    const tenant = await (await TenantCollection.create(options)).create({
      name: 'Tenant X',
    });
    await tenant.save();
    const tenantId = tenant.id as string;
    const tenantRole = await roles.create({
      name: 'Tenant owner',
      slug: 'owner',
      tenantId,
    });
    await tenantRole.save();
    await seedMessagesRolePermissions(options);
    expect(await slugsOf('viewer')).toEqual([
      'messages.manage-routes',
      'messages.read',
    ]);
    expect(await slugsOf('owner', tenantId)).toEqual([]);
  });

  it('reports missing system roles instead of creating them', async () => {
    const emptyDb = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const result = await seedMessagesRolePermissions({ db: emptyDb });
      expect(result.missingRoles.sort()).toEqual(
        ['admin', 'member', 'owner', 'viewer'].sort(),
      );
      expect(result.added).toEqual({});
    } finally {
      await emptyDb.close?.();
    }
  });
});
