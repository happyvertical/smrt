/**
 * withPrincipalPermissionContext — logic tests on real in-memory SQLite plus a
 * focused mock proving the Postgres session-variable publication.
 *
 * The real-Postgres RLS enforcement proof lives in
 * `principal-permission-context-postgres.test.ts` (gated on DATABASE_URL).
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import {
  getCurrentSessionPermissionContext,
  withPrincipalPermissionContext,
} from '../services/SessionPermissionContext.js';
import { SessionService } from '../services/SessionService.js';

describe('withPrincipalPermissionContext (SQLite logic)', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smrt-principal-ctx-${Date.now()}-${Math.random()}.db`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  async function seed(): Promise<{
    userId: string;
    tenantId: string;
    roleId: string;
    grant: (slug: string) => Promise<void>;
  }> {
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'principal@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Principal Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Reader' });
    await role.save();
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
    });
    await membership.save();

    const grant = async (slug: string): Promise<void> => {
      const permission = await permissions.create({ slug, name: slug });
      await permission.save();
      await rolePermissions.addPermission(
        role.id as string,
        permission.id as string,
      );
    };

    return {
      userId: user.id as string,
      tenantId: tenant.id as string,
      roleId: role.id as string,
      grant,
    };
  }

  it('publishes the bound principal and its live-resolved permissions into the context', async () => {
    const { userId, tenantId, grant } = await seed();
    await grant('articles.read');

    const seenInside = await withPrincipalPermissionContext(
      { db: { type: 'sqlite', url: dbPath }, userId, tenantId },
      async (context) => {
        // The ALS store exposes the same context to any downstream code.
        expect(getCurrentSessionPermissionContext()?.userId).toBe(userId);
        expect(context.userId).toBe(userId);
        expect(context.tenantId).toBe(tenantId);
        expect(context.session).toBeNull();
        expect(context.sessionId).toBeNull();
        // A principal run never bypasses.
        expect(context.superAdminBypass).toBe(false);
        expect(context.systemContext).toBe(false);
        expect(context.permissions).toContain('articles.read');
        expect(context.permissionSet.has('articles.read')).toBe(true);
        return context.permissions;
      },
    );

    expect(seenInside).toEqual(['articles.read']);
  });

  it('re-resolves live so role changes reflect on the next execution', async () => {
    const { userId, tenantId, grant } = await seed();
    await grant('articles.read');

    await withPrincipalPermissionContext(
      { db: { type: 'sqlite', url: dbPath }, userId, tenantId },
      async (context) => {
        expect(context.permissions).toContain('articles.read');
        expect(context.permissions).not.toContain('articles.publish');
      },
    );

    // Grant a new permission to the same role between executions.
    await grant('articles.publish');

    await withPrincipalPermissionContext(
      { db: { type: 'sqlite', url: dbPath }, userId, tenantId },
      async (context) => {
        expect(context.permissions).toContain('articles.read');
        expect(context.permissions).toContain('articles.publish');
      },
    );
  });

  it('honors an explicit pre-resolved permission set without querying the resolver', async () => {
    const { userId, tenantId, grant } = await seed();
    await grant('articles.read');
    const resolveSpy = vi.spyOn(
      PermissionResolver.prototype,
      'resolvePermissions',
    );

    await withPrincipalPermissionContext(
      {
        db: { type: 'sqlite', url: dbPath },
        userId,
        tenantId,
        permissions: ['articles.override'],
      },
      async (context) => {
        expect(context.permissions).toEqual(['articles.override']);
      },
    );

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('honors an explicit EMPTY permission set as zero permissions, not "resolve live"', async () => {
    const { userId, tenantId, grant } = await seed();
    await grant('articles.read');
    const resolveSpy = vi.spyOn(
      PermissionResolver.prototype,
      'resolvePermissions',
    );

    // `[]` is truthy but must be honored as "run with ZERO permissions" (a
    // truthy test would fail open by resolving live).
    await withPrincipalPermissionContext(
      {
        db: { type: 'sqlite', url: dbPath },
        userId,
        tenantId,
        permissions: [],
      },
      async (context) => {
        expect(context.permissions).toEqual([]);
        expect(context.permissionSet.size).toBe(0);
      },
    );

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('fails closed to no permissions when the principal has no tenant', async () => {
    const { userId } = await seed();

    await withPrincipalPermissionContext(
      { db: { type: 'sqlite', url: dbPath }, userId, tenantId: null },
      async (context) => {
        expect(context.permissions).toEqual([]);
        expect(context.tenantId).toBeNull();
      },
    );
  });
});

describe('withPrincipalPermissionContext (Postgres session publication)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the resolved principal onto the DB session, never bypassing', async () => {
    const transaction = {
      commit: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(true),
      query: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      url: 'postgres://transaction-db',
    };
    const baseDb = {
      beginTransaction: vi.fn().mockResolvedValue(transaction),
      query: vi.fn().mockResolvedValue(undefined),
      url: 'postgres://base-db',
    };
    const fakeSessionService = {
      getDatabase: () => baseDb,
    } as unknown as SessionService;
    vi.spyOn(SessionService, 'create').mockResolvedValue(fakeSessionService);

    const resolvePermissions = vi.fn().mockResolvedValue({
      permissions: new Set(['articles.read', 'articles.update']),
    });
    vi.spyOn(PermissionResolver, 'create').mockResolvedValue({
      resolvePermissions,
    } as unknown as PermissionResolver);

    const resolved = await withPrincipalPermissionContext(
      {
        db: { type: 'postgres', url: 'postgres://base-db' },
        postgresRls: true,
        userId: 'user-1',
        tenantId: 'tenant-1',
      },
      async (context) => context.permissions,
    );

    expect(resolved).toEqual(['articles.read', 'articles.update']);
    // Live resolution used the standard cascade for the exact principal.
    expect(resolvePermissions).toHaveBeenCalledWith('user-1', 'tenant-1', {});

    expect(baseDb.beginTransaction).toHaveBeenCalledTimes(1);
    expect(transaction.query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("set_config('smrt.tenant_id'"),
      'tenant-1',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("set_config('smrt.user_id'"),
      'user-1',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("set_config('smrt.session_id'"),
      '',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining("set_config('smrt.permissions'"),
      JSON.stringify(['articles.read', 'articles.update']),
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("set_config('smrt.super_admin_bypass'"),
      'false',
    );
    expect(transaction.query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining("set_config('smrt.system_context'"),
      'false',
    );
    expect(transaction.commit).toHaveBeenCalledTimes(1);
  });
});
