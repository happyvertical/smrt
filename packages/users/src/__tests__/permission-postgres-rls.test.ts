import { randomUUID } from 'node:crypto';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
  type TransactionHandle,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyPostgresPermissionPolicies } from '../services/index.js';

@smrt({
  api: { include: ['list', 'create', 'update', 'delete'] },
  collection: 'permission_rls_records',
  tableName: 'permission_rls_records',
  tenantScoped: { field: 'tenantId', mode: 'required' },
})
class PostgresPermissionRlsRecord extends SmrtObject {
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

async function setSessionContext(
  tx: TransactionHandle,
  permissions: string[],
  tenantId: string,
  options: { superAdminBypass?: boolean; systemContext?: boolean } = {},
): Promise<void> {
  await tx.query("SELECT set_config('smrt.tenant_id', $1, true)", tenantId);
  await tx.query("SELECT set_config('smrt.user_id', $1, true)", 'user-1');
  await tx.query("SELECT set_config('smrt.session_id', $1, true)", 'session-1');
  await tx.query(
    "SELECT set_config('smrt.permissions', $1, true)",
    JSON.stringify(permissions),
  );
  await tx.query(
    "SELECT set_config('smrt.super_admin_bypass', $1, true)",
    options.superAdminBypass ? 'true' : 'false',
  );
  await tx.query(
    "SELECT set_config('smrt.system_context', $1, true)",
    options.systemContext ? 'true' : 'false',
  );
}

describePostgres('Postgres permission RLS', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let adminDb: DatabaseInterface | undefined;
  let roleName = '';

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest();

    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a Postgres test database.');
    }

    adminDb = await getDatabase({
      type: 'postgres',
      url: isolated.config.url,
    });

    roleName = `smrt_users_rls_${randomUUID().replaceAll('-', '_')}`;

    await adminDb.query('TRUNCATE TABLE public.permission_rls_records');
    await adminDb.query(
      [
        'INSERT INTO public.permission_rls_records',
        '  (id, slug, context, tenant_id, title)',
        'VALUES',
        "  ('row-a', 'row-a', '', 'tenant-a', 'Tenant A'),",
        "  ('row-b', 'row-b', '', 'tenant-b', 'Tenant B')",
      ].join('\n'),
    );

    await applyPostgresPermissionPolicies({
      db: { type: 'postgres', url: isolated.config.url },
    });

    await adminDb.query(
      `CREATE ROLE "${roleName}" LOGIN PASSWORD 'postgres' NOSUPERUSER NOBYPASSRLS`,
    );
    await adminDb.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
    await adminDb.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.permission_rls_records TO "${roleName}"`,
    );
  });

  afterEach(async () => {
    if (adminDb) {
      try {
        await adminDb.query('TRUNCATE TABLE public.permission_rls_records');
      } catch {
        // Best-effort cleanup against a shared test database.
      }

      if (roleName) {
        try {
          await adminDb.query(`DROP ROLE IF EXISTS "${roleName}"`);
        } catch {
          // Best-effort cleanup against a shared test database.
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

  async function withRoleTransaction(
    permissions: string[],
    tenantId: string,
    fn: (tx: TransactionHandle) => Promise<void>,
    options: { superAdminBypass?: boolean; systemContext?: boolean } = {},
  ): Promise<void> {
    const transactionFactory = adminDb as DatabaseInterface & {
      beginTransaction?: () => Promise<TransactionHandle>;
    };

    if (!transactionFactory?.beginTransaction) {
      throw new Error(
        'Role database does not support beginTransaction() for RLS tests.',
      );
    }

    const tx = await transactionFactory.beginTransaction();
    try {
      await tx.query(`SET ROLE "${roleName}"`);
      await setSessionContext(tx, permissions, tenantId, options);
      await fn(tx);
    } finally {
      if (tx.isActive()) {
        await tx.rollback();
      }
    }
  }

  it('enforces read visibility by tenant and permission', async () => {
    await withRoleTransaction(
      ['permission_rls_records.read'],
      'tenant-a',
      async (tx) => {
        const result = await tx.query(
          'SELECT id FROM public.permission_rls_records ORDER BY id',
        );
        expect(rowsOf(result).map((row) => row.id)).toEqual(['row-a']);
      },
    );

    await withRoleTransaction(
      ['permission_rls_records.read'],
      'tenant-c',
      async (tx) => {
        const result = await tx.query(
          'SELECT id FROM public.permission_rls_records ORDER BY id',
        );
        expect(rowsOf(result)).toHaveLength(0);
      },
    );

    await withRoleTransaction([], 'tenant-a', async (tx) => {
      const result = await tx.query(
        'SELECT id FROM public.permission_rls_records ORDER BY id',
      );
      expect(rowsOf(result)).toHaveLength(0);
    });
  });

  it('enforces insert, update, delete, and bypass semantics', async () => {
    await withRoleTransaction(
      ['permission_rls_records.create'],
      'tenant-a',
      async (tx) => {
        const inserted = await tx.query(
          [
            'INSERT INTO public.permission_rls_records',
            '  (id, slug, context, tenant_id, title)',
            "VALUES ('row-c', 'row-c', '', 'tenant-a', 'Tenant C')",
          ].join('\n'),
        );
        expect(rowCountOf(inserted)).toBe(1);

        await expect(
          tx.query(
            [
              'INSERT INTO public.permission_rls_records',
              '  (id, slug, context, tenant_id, title)',
              "VALUES ('row-d', 'row-d', '', 'tenant-b', 'Tenant D')",
            ].join('\n'),
          ),
        ).rejects.toThrow(/row-level security/i);
      },
    );

    await withRoleTransaction(
      ['permission_rls_records.read', 'permission_rls_records.update'],
      'tenant-a',
      async (tx) => {
        const updated = await tx.query(
          [
            'UPDATE public.permission_rls_records',
            "SET title = 'Tenant A Updated'",
            "WHERE id = 'row-a'",
          ].join('\n'),
        );
        expect(rowCountOf(updated)).toBe(1);

        const blocked = await tx.query(
          [
            'UPDATE public.permission_rls_records',
            "SET title = 'Tenant B Updated'",
            "WHERE id = 'row-b'",
          ].join('\n'),
        );
        expect(rowCountOf(blocked)).toBe(0);
      },
    );

    await withRoleTransaction(
      ['permission_rls_records.read', 'permission_rls_records.delete'],
      'tenant-a',
      async (tx) => {
        const deleted = await tx.query(
          [
            'DELETE FROM public.permission_rls_records',
            "WHERE id = 'row-a'",
          ].join('\n'),
        );
        expect(rowCountOf(deleted)).toBe(1);

        const blocked = await tx.query(
          [
            'DELETE FROM public.permission_rls_records',
            "WHERE id = 'row-b'",
          ].join('\n'),
        );
        expect(rowCountOf(blocked)).toBe(0);
      },
    );

    await withRoleTransaction(
      [],
      'tenant-a',
      async (tx) => {
        const result = await tx.query(
          'SELECT id FROM public.permission_rls_records ORDER BY id',
        );
        expect(rowsOf(result).map((row) => row.id)).toEqual(['row-a', 'row-b']);
      },
      {
        superAdminBypass: true,
      },
    );

    await withRoleTransaction(
      [],
      'tenant-a',
      async (tx) => {
        const inserted = await tx.query(
          [
            'INSERT INTO public.permission_rls_records',
            '  (id, slug, context, tenant_id, title)',
            "VALUES ('row-system', 'row-system', '', 'tenant-b', 'System Insert')",
            'RETURNING id',
          ].join('\n'),
        );
        expect(rowsOf(inserted).map((row) => row.id)).toEqual(['row-system']);
      },
      {
        systemContext: true,
      },
    );
  });

  it('supports explicit custom Postgres bindings from app-level permissions', async () => {
    setConfig({
      packages: {
        users: {
          permissions: {
            custom: [
              {
                name: 'Inspect Audit Rows',
                postgres: {
                  bindings: [
                    {
                      action: 'select',
                      tableName: 'permission_rls_records',
                    },
                    {
                      action: 'insert',
                      tableName: 'permission_rls_records',
                    },
                  ],
                },
                slug: 'audits.inspect',
              },
            ],
          },
        },
      },
    });

    await applyPostgresPermissionPolicies({
      db: { type: 'postgres', url: isolated?.config.url },
    });

    await withRoleTransaction(['audits.inspect'], 'tenant-a', async (tx) => {
      const selected = await tx.query(
        'SELECT id FROM public.permission_rls_records ORDER BY id',
      );
      expect(rowsOf(selected).map((row) => row.id)).toEqual(['row-a']);

      const inserted = await tx.query(
        [
          'INSERT INTO public.permission_rls_records',
          '  (id, slug, context, tenant_id, title)',
          "VALUES ('row-audit', 'row-audit', '', 'tenant-a', 'Audit Insert')",
        ].join('\n'),
      );
      expect(rowCountOf(inserted)).toBe(1);

      await expect(
        tx.query(
          [
            'INSERT INTO public.permission_rls_records',
            '  (id, slug, context, tenant_id, title)',
            "VALUES ('row-audit-blocked', 'row-audit-blocked', '', 'tenant-b', 'Blocked Insert')",
          ].join('\n'),
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });
});
