/**
 * Regression guard for issue #3050.
 *
 * `SmrtCollection.create()` forwards `defaultListLimit`/`maxListLimit` from any
 * options bag (#2367). Framework-internal full reads that were created from a
 * caller's (possibly bounded) bag silently truncated: role-permission seeding
 * (destructive with `prune`), the permission catalog sync, and the mobile
 * tenant listing. These run over SQLite with `maxListLimit: 1`.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { MobileAuthService } from '../services/MobileAuthService.js';
import { syncPermissionCatalog } from '../services/PermissionCatalogService.js';
import { MembershipStatus } from '../types/index.js';

const BOUNDS = { defaultListLimit: 1, maxListLimit: 1 } as const;

describe('issue #3050: bootstrap reads ignore caller list bounds', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smrt-3050-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
  });

  afterEach(() => {
    clearCache();
    setConfig({});
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('seedRolePermissions with prune keeps the right rows on a bounded collection', async () => {
    await syncPermissionCatalog({ db });
    await (await RoleCollection.create({ db })).seedSystemRoles();
    const full = await RolePermissionCollection.create({ db });
    await full.seedRolePermissions(undefined, { syncCatalog: false });
    const rowsBefore = await (
      await RolePermissionCollection.create({ db })
    ).list({});
    expect(rowsBefore.length).toBeGreaterThan(1);

    const bounded = await RolePermissionCollection.create({
      db,
      ...BOUNDS,
    });
    const result = await bounded.seedRolePermissions(undefined, {
      syncCatalog: false,
      prune: true,
    });

    expect(Object.values(result.removed).flat()).toEqual([]);
    expect(Object.values(result.added).flat()).toEqual([]);
    expect(Object.values(result.missingPermissions).flat()).toEqual([]);
    const rowsAfter = await (
      await RolePermissionCollection.create({ db })
    ).list({});
    expect(rowsAfter.length).toBe(rowsBefore.length);
  });

  it('syncPermissionCatalog creates no duplicates under a bounded bag', async () => {
    const first = await syncPermissionCatalog({ db });
    expect(first.created.length).toBeGreaterThan(1);

    const again = await syncPermissionCatalog({ db, ...BOUNDS });
    expect(again.created).toEqual([]);

    const permissions = await (await PermissionCollection.create({ db })).list(
      {},
    );
    expect(permissions.length).toBe(first.created.length);
  });

  it('MobileAuthService membership listing returns all memberships', async () => {
    const users = await UserCollection.create({ db });
    const tenants = await TenantCollection.create({ db });
    const roles = await RoleCollection.create({ db });
    const memberships = await MembershipCollection.create({ db });

    const user = await users.create({ email: 'bounded@example.com' });
    await user.save();
    const role = await roles.create({ slug: 'viewer', name: 'Viewer' });
    await role.save();
    const tenantIds: string[] = [];
    for (const slug of ['one', 'two', 'three']) {
      const tenant = await tenants.create({ name: slug, slug });
      await tenant.save();
      tenantIds.push(tenant.id as string);
      const membership = await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
        status: MembershipStatus.ACTIVE,
      });
      await membership.save();
    }

    const bounded = await MobileAuthService.create({
      db,
      providers: {},
      ...BOUNDS,
    });
    const options = await bounded.listTenantOptions(user.id as string);
    expect(options.map((option) => option.id).sort()).toEqual(
      [...tenantIds].sort(),
    );
  });
});
