/**
 * Real-Postgres RLS proof for withPrincipalPermissionContext (issue #1888).
 *
 * Gated on DATABASE_URL (`isPostgresAvailable()`), so CI's Postgres shard runs
 * it and it skips cleanly elsewhere. It proves that a principal's LIVE-resolved
 * permissions bound Postgres RLS per-`(table, action)` and per-tenant:
 *
 * - a permitted op succeeds,
 * - an un-permitted op is DENIED by the database,
 * - a cross-tenant read is denied,
 * - a live role change reflects on the next resolve.
 *
 * RLS only bites for a non-superuser, NOBYPASSRLS role, so — exactly like the
 * existing `permission-postgres-rls.test.ts` — enforcement is exercised under
 * `SET ROLE` inside a transaction. The permission set fed onto that session is
 * the real {@link PermissionResolver} output (the same live cascade
 * `withPrincipalPermissionContext` runs), and a companion test proves the
 * wrapper itself publishes that principal onto a real Postgres session.
 */

import { randomUUID } from 'node:crypto';
import { clearCache } from '@happyvertical/smrt-config';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
  type TransactionHandle,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MembershipCollection } from '../collections/MembershipCollection.js';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { TenantCollection } from '../collections/TenantCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import { applyPostgresPermissionPolicies } from '../services/index.js';
import { PermissionResolver } from '../services/PermissionResolver.js';
import {
  getCurrentSessionPermissionContext,
  withPrincipalPermissionContext,
} from '../services/SessionPermissionContext.js';

@smrt({
  api: { include: ['list', 'create', 'update', 'delete'] },
  collection: 'principal_rls_records',
  tableName: 'principal_rls_records',
  tenantScoped: { field: 'tenantId', mode: 'required' },
})
class PrincipalRlsRecord extends SmrtObject {
  tenantId: string = '';
  title: string = '';
}

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(
    (row) => ({ ...row }),
  );
}

function rowCountOf(result: unknown): number {
  return (result as { rowCount?: number }).rowCount ?? 0;
}

async function closeDatabase(database: unknown): Promise<void> {
  if (
    database &&
    typeof (database as { close?: () => Promise<void> }).close === 'function'
  ) {
    await (database as { close: () => Promise<void> }).close();
  }
}

describePostgres('withPrincipalPermissionContext + Postgres RLS', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let adminDb: DatabaseInterface | undefined;
  let url = '';
  let roleName = '';
  let userId = '';
  let tenantAId = '';
  let tenantBId = '';
  let roleId = '';
  let readPermissionId = '';

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest();
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a Postgres test database.');
    }
    url = isolated.config.url;
    const options = { db: { type: 'postgres' as const, url } };

    adminDb = await getDatabase({ type: 'postgres', url });
    await adminDb.query('TRUNCATE TABLE public.principal_rls_records');

    // Seed RBAC via the real collections so column shapes/ids are correct.
    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({
      email: `principal-${randomUUID()}@example.com`,
    });
    await user.save();
    const tenantA = await tenants.create({ name: 'Principal Tenant A' });
    await tenantA.save();
    const tenantB = await tenants.create({ name: 'Principal Tenant B' });
    await tenantB.save();
    const role = await roles.create({ name: 'Principal Reader' });
    await role.save();
    const readPermission = await permissions.create({
      slug: 'principal_rls_records.read',
      name: 'Read Principal Records',
    });
    await readPermission.save();
    await rolePermissions.addPermission(
      role.id as string,
      readPermission.id as string,
    );
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenantA.id,
        roleId: role.id,
      })
    ).save();

    userId = user.id as string;
    tenantAId = tenantA.id as string;
    tenantBId = tenantB.id as string;
    roleId = role.id as string;
    readPermissionId = readPermission.id as string;

    // One record per tenant; the principal is bound to tenant A only.
    await adminDb.query(
      [
        'INSERT INTO public.principal_rls_records',
        '  (id, slug, context, tenant_id, title)',
        'VALUES',
        `  ('row-a', 'row-a', '', '${tenantAId}', 'Tenant A'),`,
        `  ('row-b', 'row-b', '', '${tenantBId}', 'Tenant B')`,
      ].join('\n'),
    );

    await applyPostgresPermissionPolicies(options);

    roleName = `smrt_principal_rls_${randomUUID().replaceAll('-', '_')}`;
    await adminDb.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD 'postgres' NOSUPERUSER NOBYPASSRLS`,
    );
    await adminDb.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await adminDb.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.principal_rls_records TO "${roleName}"`,
    );
  });

  afterEach(async () => {
    if (adminDb) {
      try {
        await adminDb.query('TRUNCATE TABLE public.principal_rls_records');
      } catch {
        // best-effort cleanup against a shared test database
      }
      if (roleName) {
        try {
          await adminDb.query(`DROP ROLE IF EXISTS "${roleName}"`);
        } catch {
          // best-effort cleanup
        }
      }
    }
    roleName = '';
    await closeDatabase(adminDb);
    adminDb = undefined;
    clearCache();
    if (isolated) {
      await isolated.cleanup();
      isolated = undefined;
    }
  });

  /**
   * Resolve the principal's LIVE permissions (exactly as
   * withPrincipalPermissionContext does) and run `fn` under a NOBYPASSRLS role
   * with that resolved set published onto the DB session — so RLS actually
   * bites (the app connection in these tests is a superuser that would
   * otherwise bypass RLS).
   */
  async function underResolvedPrincipal(
    tenantId: string,
    fn: (tx: TransactionHandle) => Promise<void>,
  ): Promise<void> {
    const resolver = await PermissionResolver.create({
      db: { type: 'postgres', url },
    });
    const resolved = await resolver.resolvePermissions(userId, tenantId);
    const permissions = Array.from(resolved.permissions);

    const factory = adminDb as DatabaseInterface & {
      beginTransaction?: () => Promise<TransactionHandle>;
    };
    if (!factory?.beginTransaction) {
      throw new Error('Role database does not support beginTransaction().');
    }
    const tx = await factory.beginTransaction();
    try {
      await tx.query(`SET ROLE "${roleName}"`);
      await tx.query("SELECT set_config('smrt.tenant_id', $1, true)", tenantId);
      await tx.query("SELECT set_config('smrt.user_id', $1, true)", userId);
      await tx.query("SELECT set_config('smrt.session_id', $1, true)", '');
      await tx.query(
        "SELECT set_config('smrt.permissions', $1, true)",
        JSON.stringify(permissions),
      );
      await tx.query(
        "SELECT set_config('smrt.super_admin_bypass', $1, true)",
        'false',
      );
      await tx.query(
        "SELECT set_config('smrt.system_context', $1, true)",
        'false',
      );
      await fn(tx);
    } finally {
      if (tx.isActive()) {
        await tx.rollback();
      }
    }
  }

  it('bounds a permitted read to the principal tenant and denies cross-tenant rows', async () => {
    await underResolvedPrincipal(tenantAId, async (tx) => {
      const result = await tx.query(
        'SELECT id FROM public.principal_rls_records ORDER BY id',
      );
      // row-a (tenant A) is visible; row-b (tenant B) is filtered — cross-tenant
      // denied.
      expect(rowsOf(result).map((row) => row.id)).toEqual(['row-a']);
    });
  });

  it('denies an un-permitted operation at the database', async () => {
    // The principal holds only `principal_rls_records.read`, so INSERT (which
    // requires `.create`) is rejected by the RLS policy.
    await underResolvedPrincipal(tenantAId, async (tx) => {
      await expect(
        tx.query(
          [
            'INSERT INTO public.principal_rls_records',
            '  (id, slug, context, tenant_id, title)',
            `VALUES ('row-c', 'row-c', '', '${tenantAId}', 'Tenant C')`,
          ].join('\n'),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('reflects a live role change on the next resolve', async () => {
    // Before: the principal can read its tenant's row.
    await underResolvedPrincipal(tenantAId, async (tx) => {
      const result = await tx.query(
        'SELECT id FROM public.principal_rls_records ORDER BY id',
      );
      expect(rowsOf(result).map((row) => row.id)).toEqual(['row-a']);
    });

    // Revoke the read permission from the role at the data layer.
    await (adminDb as DatabaseInterface).query(
      'DELETE FROM public.role_permissions WHERE role_id = $1 AND permission_id = $2',
      roleId,
      readPermissionId,
    );

    // After: the next resolve returns an empty set, so RLS filters every row.
    await underResolvedPrincipal(tenantAId, async (tx) => {
      const result = await tx.query(
        'SELECT id FROM public.principal_rls_records ORDER BY id',
      );
      expect(rowsOf(result)).toHaveLength(0);
    });
  });

  it('publishes the live-resolved principal onto the Postgres session', async () => {
    await withPrincipalPermissionContext(
      {
        db: { type: 'postgres', url },
        userId,
        tenantId: tenantAId,
        postgresRls: true,
      },
      async (context) => {
        expect(context.postgresRls).toBe(true);
        expect(context.userId).toBe(userId);
        expect(context.tenantId).toBe(tenantAId);
        expect(context.superAdminBypass).toBe(false);
        expect(context.systemContext).toBe(false);
        expect(context.permissions).toContain('principal_rls_records.read');
        expect(getCurrentSessionPermissionContext()?.userId).toBe(userId);

        // The principal is published onto the actual DB session that RLS reads.
        const publishedPermissions = await context.database.query(
          "SELECT current_setting('smrt.permissions', true) AS value",
        );
        expect(
          JSON.parse(rowsOf(publishedPermissions)[0]?.value as string),
        ).toContain('principal_rls_records.read');

        const publishedUser = await context.database.query(
          "SELECT current_setting('smrt.user_id', true) AS value",
        );
        expect(rowsOf(publishedUser)[0]?.value).toBe(userId);

        const publishedBypass = await context.database.query(
          "SELECT current_setting('smrt.super_admin_bypass', true) AS value",
        );
        expect(rowsOf(publishedBypass)[0]?.value).toBe('false');
      },
    );
  });

  it('publishes an empty permission set for a tenant the principal has no membership in', async () => {
    // Tenant B: no membership, so the resolved set is empty (fail closed).
    await withPrincipalPermissionContext(
      {
        db: { type: 'postgres', url },
        userId,
        tenantId: tenantBId,
        postgresRls: true,
      },
      async (context) => {
        expect(context.permissions).toEqual([]);
        const published = await context.database.query(
          "SELECT current_setting('smrt.permissions', true) AS value",
        );
        expect(rowsOf(published)[0]?.value).toBe('[]');
      },
    );

    // And under RLS that empty set filters every row in tenant B.
    await underResolvedPrincipal(tenantBId, async (tx) => {
      const result = await tx.query(
        'SELECT id FROM public.principal_rls_records ORDER BY id',
      );
      expect(rowsOf(result)).toHaveLength(0);
    });
  });
});
