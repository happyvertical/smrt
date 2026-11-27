/**
 * Guest creates on PostgreSQL semantics (#5196, slice H).
 *
 * One suite, two backends:
 * - in-process PGlite: `pnpm --filter @happyvertical/smrt-users test:pglite`
 *   (sets SMRT_TEST_PGLITE=1), runnable anywhere;
 * - real PostgreSQL: gated on DATABASE_URL (`isPostgresAvailable()`) and run
 *   by `test:postgres` and the on-demand validation workflow.
 * Without either it skips cleanly.
 *
 * The audit table is protected by the DEFAULT setup path: the app configures
 * guest creates, `generatePostgresPermissionSql` installs ENABLEd and FORCEd
 * RLS, the guest INSERT policy and the non-guest arm, and these tests run the
 * generated statements as the deployment would. Proves, as a NOSUPERUSER role:
 * - a guest create writes the row AND its guest audit row (typed guest actor,
 *   null profile) in one transaction, with no RETURNING and no SELECT policy;
 * - a failing audit write rolls the create back;
 * - the guest cannot read, update or delete audit rows, nor write a
 *   non-guest audit row or one for another tenant;
 * - signed-in, system and background audit writers keep working under FORCEd
 *   RLS (the non-guest arm);
 * - one connection serving a guest create and then a signed-in request leaks
 *   nothing between them.
 */

import { randomUUID } from 'node:crypto';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  createGuestRequestPrincipal,
  createGuestRuntime,
  field,
  getTestDatabase,
  guestCreateAdmission,
  handleGuestCreate,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { createAuditWriter } from '@happyvertical/smrt-profiles';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { postgresPrincipalSettings } from '../postgres-settings.js';
import {
  GUEST_AUDIT_TABLE_DEFAULTS,
  generatePostgresPermissionSql,
  guestAuditPolicyName,
} from '../services/index.js';
import { resetPostgresPermissionPolicies } from './helpers/postgres-rls-reset.js';

@smrt({
  packageName: '@test/gcp5196',
  tenantScoped: { field: 'tenantId', mode: 'required' },
  collection: 'gcp5196_messages',
  tableName: 'gcp5196_messages',
})
class GcpMessage5196 extends SmrtObject {
  tenantId: string = '';
  @field() name = '';
  @field() email = '';
  @field() message = '';
}

const COLLECTION = 'gcp5196_messages';
const MODEL = 'GcpMessage5196';
const QUALIFIED = '@test/gcp5196:GcpMessage5196';

const usePglite = process.env.SMRT_TEST_PGLITE === '1';
const describeBackend =
  usePglite || isPostgresAvailable() ? describe : describe.skip;
const backendName = usePglite ? 'PGlite' : 'PostgreSQL';

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []).map(
    (row) => ({ ...row }),
  );
}

describeBackend(`guest creates on ${backendName} (#5196)`, () => {
  let db: DatabaseInterface;
  let isolated: IsolatedTestDbResult | undefined;
  let roleName = '';
  let table = '';
  let tenantA = '';
  let tenantB = '';
  const writer = createAuditWriter();

  type Tx = DatabaseInterface;

  /** Run as the non-superuser role with the given principal settings. */
  async function asPrincipal<T>(
    input: {
      tenantId: string | null;
      userId?: string | null;
      permissions?: string[];
      systemContext?: boolean;
    },
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return db.transaction(async (tx) => {
      if (roleName) await tx.query(`SET LOCAL ROLE "${roleName}"`);
      for (const [name, value] of postgresPrincipalSettings({
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        session: null,
        sessionId: null,
        permissions: input.permissions ?? [],
        superAdminBypass: false,
        systemContext: input.systemContext ?? false,
      })) {
        await tx.query('SELECT set_config($1, $2, true)', name, value);
      }
      return fn(tx as Tx);
    });
  }

  const asGuest = <T>(
    tenantId: string,
    permissions: string[],
    fn: (tx: Tx) => Promise<T>,
  ) => asPrincipal({ tenantId, permissions }, fn);

  async function systemRows(sql: string, ...values: unknown[]) {
    return asPrincipal({ tenantId: null, systemContext: true }, async (tx) =>
      rowsOf(await tx.query(sql, ...values)),
    );
  }

  function guestRequest(l: {
    tenantId: string;
    permissions: string[];
    auditWriter?: typeof writer;
  }) {
    const runtime = createGuestRuntime({
      createFields: {
        [COLLECTION]: { allowedFields: ['name', 'email', 'message'] },
      },
      auditWriter: l.auditWriter ?? writer,
    });
    return {
      tenantId: l.tenantId,
      permissions: l.permissions,
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: l.tenantId,
        permissions: l.permissions,
        runtime,
        slugModels: l.permissions.map((slug) => [slug, QUALIFIED] as const),
      }),
    };
  }

  async function guestCreate(
    tx: Tx,
    l: ReturnType<typeof guestRequest>,
    body: Record<string, unknown>,
  ) {
    const admission = guestCreateAdmission(
      l,
      MODEL,
      COLLECTION,
      false,
      QUALIFIED,
    );
    if (!admission) throw new Error('not admitted');
    return handleGuestCreate({
      admission,
      request: new Request('http://t.test/', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      db: tx as never,
      tableName: table,
      getClientAddress: () => '9.9.9.9',
    });
  }

  beforeEach(async () => {
    setConfig({
      packages: {
        users: {
          permissions: {
            guest: {
              collections: [COLLECTION],
              createCollections: [COLLECTION],
              createFields: {
                [COLLECTION]: { allowedFields: ['name', 'email', 'message'] },
              },
            },
          },
        },
      },
    });
    if (usePglite) {
      db = await getTestDatabase({
        type: 'pglite',
        url: ':memory:',
        classes: [MODEL, 'AuditLog'],
      });
    } else {
      isolated = await createIsolatedTestDbFromManifest();
      if (isolated.config.type !== 'postgres') {
        throw new Error('Expected a Postgres test database.');
      }
      db = await getDatabase({ type: 'postgres', url: isolated.config.url });
    }
    table = (new GcpMessage5196({ db }) as unknown as { tableName: string })
      .tableName;
    tenantA = randomUUID();
    tenantB = randomUUID();

    // The deployment's own setup: the generated statements, default path
    // (the app configured guest creates; nothing opts in per caller). Only
    // the statements of the tables this suite owns are applied, since the
    // shared database holds the others.
    const generated = generatePostgresPermissionSql({});
    const mine = generated.statements.filter(
      (statement) =>
        statement.includes('CREATE OR REPLACE FUNCTION') ||
        statement.includes(`"${table}"`) ||
        statement.includes(`"${GUEST_AUDIT_TABLE_DEFAULTS.tableName}"`),
    );
    for (const statement of mine) await db.query(statement);

    // A superuser or BYPASSRLS connection would not be subject to the
    // policies: run as a dedicated NOSUPERUSER/NOBYPASSRLS role. Otherwise the
    // connection role (the CI lane's) is already the one under test.
    const current = rowsOf(
      await db.query(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      ),
    )[0];
    roleName = '';
    if (current?.rolsuper === true || current?.rolbypassrls === true) {
      roleName = `smrt_gc_${randomUUID().replaceAll('-', '_')}`;
      await db.query(
        `CREATE ROLE "${roleName}" NOLOGIN NOSUPERUSER NOBYPASSRLS`,
      );
      await db.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
      await db.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`,
      );
    }
  });

  afterEach(async () => {
    if (roleName) {
      try {
        await db.query(`DROP OWNED BY "${roleName}"`);
        await db.query(`DROP ROLE IF EXISTS "${roleName}"`);
      } catch {
        // best-effort cleanup against a shared test database
      }
    }
    if (!usePglite) await resetPostgresPermissionPolicies(db);
    roleName = '';
    clearCache();
    if (isolated) {
      await isolated.cleanup();
      isolated = undefined;
    }
    const closable = db as unknown as { close?: () => Promise<void> };
    if (closable.close) await closable.close();
  });

  it('installs FORCEd RLS, the guest policy and the non-guest arm by default', async () => {
    const [audit] = rowsOf(
      await db.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relname = '${GUEST_AUDIT_TABLE_DEFAULTS.tableName}'`,
      ),
    );
    expect(audit).toMatchObject({
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
    const policies = rowsOf(
      await db.query(
        `SELECT polname, polcmd FROM pg_policy
          WHERE polrelid = '${GUEST_AUDIT_TABLE_DEFAULTS.tableName}'::regclass`,
      ),
    );
    expect(policies).toContainEqual({
      polname: guestAuditPolicyName(),
      polcmd: 'a',
    });
    expect(policies.some((p) => String(p.polname).includes('_nonguest_'))).toBe(
      true,
    );
  });

  it('creates the row and its guest audit row together, with no read-back', async () => {
    const l = guestRequest({
      tenantId: tenantA,
      permissions: [`${COLLECTION}.create`],
    });
    const res = await asGuest(tenantA, l.permissions, async (tx) => {
      const response = await guestCreate(tx, l, {
        name: 'Ada',
        email: 'ada@x.test',
        message: 'hi',
      });
      // The guest has no SELECT policy: it cannot see what it just created,
      // nor the audit row written for it.
      expect(rowsOf(await tx.query(`SELECT id FROM ${table}`))).toHaveLength(0);
      expect(
        rowsOf(
          await tx.query(
            `SELECT id FROM ${GUEST_AUDIT_TABLE_DEFAULTS.tableName}`,
          ),
        ),
      ).toHaveLength(0);
      return response;
    });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('');
    const [row] = await systemRows(`SELECT * FROM ${table}`);
    expect(row).toMatchObject({ name: 'Ada', tenant_id: tenantA });
    const [audit] = await systemRows(
      `SELECT * FROM ${GUEST_AUDIT_TABLE_DEFAULTS.tableName}`,
    );
    expect(audit).toMatchObject({
      actor_kind: 'guest',
      profile_id: null,
      tenant_id: tenantA,
      resource_id: row.id,
      action: 'create',
    });
  });

  it('a failing audit write rolls the create back under RLS', async () => {
    const l = guestRequest({
      tenantId: tenantA,
      permissions: [`${COLLECTION}.create`],
      auditWriter: async (entry, handle) => {
        await writer(entry, handle);
        throw new Error('sink down');
      },
    });
    await expect(
      asGuest(tenantA, l.permissions, (tx) =>
        guestCreate(tx, l, { name: 'A', email: 'a@x.test' }).catch(
          (error: unknown) => {
            // Swallow like a route that turns the failure into a 500: the
            // request transaction must still not keep the insert.
            expect((error as Error).message).toBe('sink down');
            return null;
          },
        ),
      ),
    ).resolves.toBeNull();
    expect(await systemRows(`SELECT id FROM ${table}`)).toHaveLength(0);
    expect(
      await systemRows(
        `SELECT id FROM ${GUEST_AUDIT_TABLE_DEFAULTS.tableName}`,
      ),
    ).toHaveLength(0);
  });

  it('refuses a guest create without the create grant', async () => {
    const l = guestRequest({
      tenantId: tenantA,
      permissions: [`${COLLECTION}.create`],
    });
    // The database refuses it too, even if the route check were skipped.
    await expect(
      asGuest(tenantA, [], async (tx) => {
        const admission = guestCreateAdmission(
          l,
          MODEL,
          COLLECTION,
          false,
          QUALIFIED,
        )!;
        return handleGuestCreate({
          admission,
          request: new Request('http://t.test/', {
            method: 'POST',
            body: JSON.stringify({ name: 'A' }),
          }),
          db: tx as never,
          tableName: table,
          getClientAddress: () => '1.1.1.1',
        });
      }),
    ).rejects.toThrow(/row-level security/i);
    expect(await systemRows(`SELECT id FROM ${table}`)).toHaveLength(0);
  });

  describe('the audit table under FORCEd RLS', () => {
    const insertAudit = (
      tx: Tx,
      tenantId: string,
      actorKind: string,
      id: string = randomUUID(),
    ) =>
      tx.query(
        `INSERT INTO ${GUEST_AUDIT_TABLE_DEFAULTS.tableName}
           (id, slug, context, tenant_id, actor_kind, action, resource_type, resource_id)
         VALUES ($1::uuid, $1::text, '', $2, $3, 'create', 'T', 'r')`,
        id,
        tenantId,
        actorKind,
      );

    it('a guest can only INSERT a guest row for its own tenant', async () => {
      await asGuest(tenantA, [], async (tx) => {
        await expect(insertAudit(tx, tenantA, 'guest')).resolves.toBeDefined();
      });
      await expect(
        asGuest(tenantA, [], (tx) => insertAudit(tx, tenantA, 'user')),
      ).rejects.toThrow(/row-level security/i);
      await expect(
        asGuest(tenantA, [], (tx) => insertAudit(tx, tenantB, 'guest')),
      ).rejects.toThrow(/row-level security/i);
    });

    it('a guest cannot read, update or delete audit rows', async () => {
      const id = randomUUID();
      await asPrincipal({ tenantId: null, systemContext: true }, (tx) =>
        insertAudit(tx, tenantA, 'guest', id),
      );
      await asGuest(tenantA, ['gcp5196_messages.read'], async (tx) => {
        const name = GUEST_AUDIT_TABLE_DEFAULTS.tableName;
        expect(rowsOf(await tx.query(`SELECT id FROM ${name}`))).toHaveLength(
          0,
        );
        const updated = await tx.query(
          `UPDATE ${name} SET action = 'x' WHERE id = $1`,
          id,
        );
        expect((updated as { rowCount?: number }).rowCount ?? 0).toBe(0);
        const deleted = await tx.query(`DELETE FROM ${name} WHERE id = $1`, id);
        expect((deleted as { rowCount?: number }).rowCount ?? 0).toBe(0);
      });
      expect(
        await systemRows(
          `SELECT id FROM ${GUEST_AUDIT_TABLE_DEFAULTS.tableName}`,
        ),
      ).toHaveLength(1);
    });

    it('signed-in, system and background writers keep working', async () => {
      const userId = randomUUID();
      await asPrincipal({ tenantId: tenantA, userId, permissions: [] }, (tx) =>
        insertAudit(tx, tenantA, 'user'),
      );
      await asPrincipal({ tenantId: null, systemContext: true }, (tx) =>
        insertAudit(tx, tenantB, 'user'),
      );
      // A background job that published no principal at all.
      await db.transaction(async (tx) => {
        if (roleName) await tx.query(`SET LOCAL ROLE "${roleName}"`);
        await insertAudit(tx as Tx, tenantA, 'user');
      });
      expect(
        await systemRows(
          `SELECT id FROM ${GUEST_AUDIT_TABLE_DEFAULTS.tableName}`,
        ),
      ).toHaveLength(3);
    });
  });

  it('one connection serving a guest create then a signed-in request leaks nothing', async () => {
    const pidOf = async (tx: Tx) =>
      rowsOf(await tx.query('SELECT pg_backend_pid() AS pid'))[0]?.pid;
    const l = guestRequest({
      tenantId: tenantA,
      permissions: [`${COLLECTION}.create`],
    });
    const guestPid = await asGuest(tenantA, l.permissions, async (tx) => {
      await guestCreate(tx, l, { name: 'A', email: 'a@x.test' });
      return pidOf(tx);
    });
    const next = await db.transaction(async (tx) => {
      const settings = rowsOf(
        await tx.query(
          `SELECT current_setting('smrt.tenant_id', true) AS tenant,
                  current_setting('smrt.permissions', true) AS permissions,
                  current_setting('smrt.system_context', true) AS system,
                  current_user AS role`,
        ),
      )[0];
      return { settings, pid: await pidOf(tx as Tx) };
    });
    // The same connection served both, so this would have leaked if it could.
    expect(next.pid).toBe(guestPid);
    expect(next.settings.tenant ?? '').toBe('');
    expect(next.settings.permissions ?? '').toBe('');
    expect(next.settings.system ?? '').not.toBe('true');
    expect(next.settings.role).not.toBe(roleName);
  });
});
