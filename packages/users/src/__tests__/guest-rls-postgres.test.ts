/**
 * Real-Postgres RLS proof for guest callers (#5196, slice F).
 *
 * Gated on DATABASE_URL (`isPostgresAvailable()`); proven in CI by the
 * on-demand-validation workflow and skipped elsewhere. A guest has no user
 * row: its settings are `smrt.user_id = ''`, the guest grant set as
 * `smrt.permissions`, and the tenant bound from the address, all published
 * with transaction-local `set_config(..., true)` and never `system_context`.
 *
 * Proves, under FORCE RLS and a NOSUPERUSER/NOBYPASSRLS role:
 * - no grants: nothing is read or created;
 * - `.read`: only that tenant's rows;
 * - create-only: `INSERT ... ON CONFLICT DO NOTHING` without RETURNING works,
 *   a duplicate is silent and the request transaction still commits, and the
 *   guest cannot read back what it created;
 * - a guest cannot insert for another tenant;
 * - the audit sink accepts `actor_kind = 'guest'` for the guest's tenant and
 *   nothing else;
 * - a pooled connection does not leak guest settings to the next request.
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
import { postgresPrincipalSettings } from '../postgres-settings.js';
import { applyPostgresPermissionPolicies } from '../services/index.js';
import { resetPostgresPermissionPolicies } from './helpers/postgres-rls-reset.js';

@smrt({
  api: { include: ['list', 'create'] },
  collection: 'guest_rls_records',
  tableName: 'guest_rls_records',
  tenantScoped: { field: 'tenantId', mode: 'required' },
})
class GuestRlsRecord extends SmrtObject {
  tenantId: string = '';
  title: string = '';
}

// Stands in for the profiles AuditLog: optional-mode, so no generated policy;
// only the guest audit sink policy (and the test's own system arm) apply.
@smrt({
  api: false,
  collection: 'guest_rls_audits',
  tableName: 'guest_rls_audits',
})
class GuestRlsAudit extends SmrtObject {
  tenantId: string = '';
  actorKind: string = 'user';
  action: string = '';
}

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(
    (row) => ({ ...row }),
  );
}

describePostgres('guest callers under Postgres RLS', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let adminDb: DatabaseInterface | undefined;
  let roleName = '';
  let tenantA = '';
  let tenantB = '';
  let rowA = '';
  let rowB = '';

  type Txn = TransactionHandle;

  async function begin(): Promise<Txn> {
    const factory = adminDb as DatabaseInterface & {
      beginTransaction?: () => Promise<TransactionHandle>;
    };
    if (!factory.beginTransaction) throw new Error('no transactions');
    return factory.beginTransaction();
  }

  async function publish(
    tx: Txn,
    input: {
      tenantId: string | null;
      userId?: string | null;
      permissions: string[];
    },
  ): Promise<void> {
    // LOCAL so the role reverts at commit as well as at rollback.
    if (roleName) await tx.query(`SET LOCAL ROLE "${roleName}"`);
    for (const [name, value] of postgresPrincipalSettings({
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      session: null,
      sessionId: null,
      permissions: input.permissions,
      superAdminBypass: false,
      systemContext: false,
    })) {
      await tx.query('SELECT set_config($1, $2, true)', name, value);
    }
  }

  /** Run `fn` as a guest of `tenantId`; commits when `commit`, else rolls back. */
  async function asGuest<T>(
    tenantId: string | null,
    permissions: string[],
    fn: (tx: Txn) => Promise<T>,
    commit = false,
  ): Promise<T> {
    const tx = await begin();
    try {
      await publish(tx, { tenantId, permissions });
      const out = await fn(tx);
      if (commit) await tx.commit();
      return out;
    } finally {
      if (tx.isActive()) await tx.rollback();
    }
  }

  const insertRecord = (
    tx: Txn,
    tenantId: string,
    id = randomUUID(),
    slug = `s-${id}`,
  ) =>
    tx.query(
      `INSERT INTO public.guest_rls_records (id, slug, context, tenant_id, title)
       VALUES ($1, $2, '', $3, 'hello') ON CONFLICT DO NOTHING`,
      id,
      slug,
      tenantId,
    );

  const countRecords = async (tx: Txn): Promise<number> =>
    rowsOf(await tx.query('SELECT id FROM public.guest_rls_records')).length;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest();
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a Postgres test database.');
    }
    const url = isolated.config.url;
    adminDb = await getDatabase({ type: 'postgres', url });
    await adminDb.query(
      'TRUNCATE TABLE public.guest_rls_records, public.guest_rls_audits',
    );

    tenantA = randomUUID();
    tenantB = randomUUID();
    rowA = randomUUID();
    rowB = randomUUID();
    const seed = await begin();
    try {
      await seed.query(
        "SELECT set_config('smrt.system_context', 'true', true)",
      );
      await seed.query(
        `INSERT INTO public.guest_rls_records (id, slug, context, tenant_id, title)
         VALUES ($1, 'row-a', '', $2, 'A'), ($3, 'row-b', '', $4, 'B')`,
        rowA,
        tenantA,
        rowB,
        tenantB,
      );
      await seed.commit();
    } finally {
      if (seed.isActive()) await seed.rollback();
    }

    await applyPostgresPermissionPolicies(
      { db: { type: 'postgres' as const, url } },
      {
        guestAudit: {
          tableName: 'guest_rls_audits',
          enableRls: true,
        },
      },
    );
    // The signed-in / system writers keep their own arm on the audit table;
    // the guest policy under test has none.
    await adminDb.query(
      `CREATE POLICY guest_rls_audits_system ON public.guest_rls_audits
         FOR ALL USING (smrt_rls_bypass()) WITH CHECK (smrt_rls_bypass())`,
    );

    const current = rowsOf(
      await adminDb.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
    )[0];
    if (current?.rolsuper === true || current?.rolbypassrls === true) {
      roleName = `smrt_guest_rls_${randomUUID().replaceAll('-', '_')}`;
      await adminDb.query(
        `CREATE ROLE "${roleName}" LOGIN PASSWORD 'postgres' NOSUPERUSER NOBYPASSRLS`,
      );
      await adminDb.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await adminDb.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.guest_rls_records, public.guest_rls_audits TO "${roleName}"`,
      );
    }
  });

  afterEach(async () => {
    if (adminDb) {
      try {
        await adminDb.query(
          'TRUNCATE TABLE public.guest_rls_records, public.guest_rls_audits',
        );
      } catch {
        // best-effort cleanup against a shared test database
      }
      await resetPostgresPermissionPolicies(adminDb);
      if (roleName) {
        try {
          await adminDb.query(`DROP ROLE IF EXISTS "${roleName}"`);
        } catch {
          // best-effort cleanup
        }
      }
    }
    roleName = '';
    clearCache();
    if (isolated) {
      await isolated.cleanup();
      isolated = undefined;
    }
    const closable = adminDb as unknown as { close?: () => Promise<void> };
    if (closable?.close) await closable.close();
    adminDb = undefined;
  });

  it('reads and creates nothing without grants', async () => {
    await asGuest(tenantA, [], async (tx) => {
      expect(await countRecords(tx)).toBe(0);
      await expect(insertRecord(tx, tenantA)).rejects.toThrow(
        /row-level security/i,
      );
    });
  });

  it('reads nothing with no tenant bound', async () => {
    await asGuest(null, ['guest_rls_records.read'], async (tx) => {
      expect(await countRecords(tx)).toBe(0);
    });
  });

  it('with .read sees only its own tenant rows', async () => {
    await asGuest(tenantA, ['guest_rls_records.read'], async (tx) => {
      const ids = rowsOf(
        await tx.query('SELECT id FROM public.guest_rls_records'),
      ).map((row) => row.id);
      expect(ids).toEqual([rowA]);
    });
    // .read alone does not allow a write.
    await asGuest(tenantA, ['guest_rls_records.read'], async (tx) => {
      await expect(insertRecord(tx, tenantA)).rejects.toThrow(
        /row-level security/i,
      );
    });
  });

  it('create-only: inserts without RETURNING, hides the row, and has no update/delete', async () => {
    const id = randomUUID();
    await asGuest(
      tenantA,
      ['guest_rls_records.create'],
      async (tx) => {
        await insertRecord(tx, tenantA, id);
        // No SELECT policy matches: the guest cannot see what it created.
        expect(await countRecords(tx)).toBe(0);
        // Nor change or remove existing rows (no policy: zero rows touched).
        const updated = await tx.query(
          "UPDATE public.guest_rls_records SET title = 'x' WHERE id = $1",
          rowA,
        );
        expect((updated as { rowCount?: number }).rowCount ?? 0).toBe(0);
        const deleted = await tx.query(
          'DELETE FROM public.guest_rls_records WHERE id = $1',
          rowA,
        );
        expect((deleted as { rowCount?: number }).rowCount ?? 0).toBe(0);
      },
      true,
    );
    const stored = rowsOf(
      await (adminDb as DatabaseInterface).query(
        'SELECT tenant_id FROM public.guest_rls_records WHERE id = $1',
        id,
      ),
    );
    expect(stored.map((row) => row.tenant_id)).toEqual([tenantA]);
  });

  it('a duplicate create is silent and the request transaction still commits', async () => {
    const id = randomUUID();
    await asGuest(
      tenantA,
      ['guest_rls_records.create'],
      async (tx) => {
        await insertRecord(tx, tenantA, id, `slug-${id}`);
        // Same id and slug again: no error, so the transaction is not aborted.
        await expect(
          insertRecord(tx, tenantA, id, `slug-${id}`),
        ).resolves.toBeDefined();
        // Still usable (an aborted transaction would reject this).
        await expect(tx.query('SELECT 1')).resolves.toBeDefined();
      },
      true,
    );
    const count = rowsOf(
      await (adminDb as DatabaseInterface).query(
        'SELECT count(*)::int AS n FROM public.guest_rls_records WHERE id = $1',
        id,
      ),
    )[0]?.n;
    expect(count).toBe(1);
  });

  it('cannot insert with another tenant id', async () => {
    await asGuest(tenantA, ['guest_rls_records.create'], async (tx) => {
      await expect(insertRecord(tx, tenantB)).rejects.toThrow(
        /row-level security/i,
      );
    });
  });

  describe('audit sink', () => {
    const insertAudit = (tx: Txn, tenantId: string, actorKind: string) =>
      tx.query(
        `INSERT INTO public.guest_rls_audits (id, slug, context, tenant_id, actor_kind, action)
         VALUES ($1, $2, '', $3, $4, 'guest_rls_records.create')`,
        randomUUID(),
        `a-${randomUUID()}`,
        tenantId,
        actorKind,
      );

    it('accepts a guest marker row for the guest tenant without system context', async () => {
      await asGuest(tenantA, ['guest_rls_records.create'], async (tx) => {
        await expect(insertAudit(tx, tenantA, 'guest')).resolves.toBeDefined();
        const bypass = rowsOf(
          await tx.query(
            "SELECT current_setting('smrt.system_context', true) AS v",
          ),
        )[0]?.v;
        expect(bypass).toBe('false');
      });
    });

    it('rejects actor_kind user, another tenant, and any read-back', async () => {
      await asGuest(tenantA, ['guest_rls_records.create'], async (tx) => {
        await expect(insertAudit(tx, tenantA, 'user')).rejects.toThrow(
          /row-level security/i,
        );
      });
      await asGuest(tenantA, ['guest_rls_records.create'], async (tx) => {
        await expect(insertAudit(tx, tenantB, 'guest')).rejects.toThrow(
          /row-level security/i,
        );
      });
      await asGuest(tenantA, ['guest_rls_records.create'], async (tx) => {
        await insertAudit(tx, tenantA, 'guest');
        const rows = rowsOf(
          await tx.query('SELECT id FROM public.guest_rls_audits'),
        );
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('does not leak guest settings to the next transaction on the same connection', async () => {
    const pidOf = async (tx: Txn) =>
      rowsOf(await tx.query('SELECT pg_backend_pid() AS pid'))[0]?.pid;

    let sharedConnection = false;
    for (let attempt = 0; attempt < 5 && !sharedConnection; attempt += 1) {
      const guestPid = await asGuest(
        tenantA,
        ['guest_rls_records.read', 'guest_rls_records.create'],
        async (tx) => {
          await insertRecord(tx, tenantA);
          return pidOf(tx);
        },
        true,
      );

      // A following signed-in-style request: it publishes nothing of its own
      // before the check, so any leftover guest value would show here.
      const next = await begin();
      try {
        const nextPid = await pidOf(next);
        const seen = rowsOf(
          await next.query(`SELECT
            current_setting('smrt.permissions', true) AS permissions,
            current_setting('smrt.tenant_id', true) AS tenant,
            current_setting('smrt.user_id', true) AS usr,
            current_setting('smrt.system_context', true) AS sys,
            current_user AS role`),
        )[0];
        if (nextPid === guestPid) {
          sharedConnection = true;
          expect(seen?.permissions ?? '').toBe('');
          expect(seen?.tenant ?? '').toBe('');
          expect(seen?.usr ?? '').toBe('');
          expect(seen?.sys ?? '').toBe('');
          if (roleName) expect(seen?.role).not.toBe(roleName);
        }
      } finally {
        if (next.isActive()) await next.rollback();
      }
    }
    expect(sharedConnection).toBe(true);
  });

  it('publishes the guest settings transaction-locally', async () => {
    await asGuest(tenantA, ['guest_rls_records.read'], async (tx) => {
      // Rolling back inside the outer scope must clear them; check both sides.
      const during = rowsOf(
        await tx.query("SELECT current_setting('smrt.user_id', true) AS v"),
      )[0]?.v;
      expect(during ?? '').toBe('');
    });
    const after = await begin();
    try {
      const v = rowsOf(
        await after.query(
          "SELECT current_setting('smrt.permissions', true) AS v",
        ),
      )[0]?.v;
      expect(v ?? '').toBe('');
    } finally {
      if (after.isActive()) await after.rollback();
    }
  });
});
