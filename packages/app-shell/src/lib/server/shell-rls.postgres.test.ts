// The shell's own tables under `required` tenancy and forced row-level
// security (#5191): the registered `test:postgres` suite. It runs on an
// in-process PGlite (its twin) and ALSO on a real server when
// `SMRT_TEST_POSTGRES_URL` is set (CI's "Registered PostgreSQL Suites" lane).
//
// The shell's login here is a NOSUPERUSER NOBYPASSRLS role that OWNS the
// tables (the single-login profile: only FORCE keeps the policies on an
// owner). Two owners share the database. The assertions go AROUND the
// application layer on purpose (raw SQL names the other owner's row id,
// which the tenancy interceptor never sees), so they fail when the policies
// are removed: the last test shows what the same read returns without them.

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { postgresPrincipalSettings } from '@happyvertical/smrt-users/postgres-settings';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The generated item route reads through the runtime's REQUEST database. The
// stand-in below is set per call to one that carries the session's own settings
// (tenant and permissions, never the store marker), as the runtime's RLS
// request transaction does.
const request = vi.hoisted(() => ({
  collection: null as null | ((name: string) => Promise<unknown>),
}));
vi.mock('$lib/server/smrt', () => ({
  // The legacy exports a generated route probes for first.
  getCollection: undefined,
  getSmrtConfig: undefined,
  runtime: {
    getCollection: (name: string) => {
      if (!request.collection) throw new Error('no request in flight');
      return request.collection(name);
    },
    classOptions: () => ({}),
  },
}));

import type { DatabaseConfig } from '../../engine/db/index.ts';
import * as decideRoute from '../../routes/api/approvals/[id]/decide/+server.ts';
import { App } from '../objects/App.ts';
import { ApprovalCollection } from '../objects/Approval.ts';
import { applyOwnBatch } from './approvals.ts';
import { changesState, flushChecks } from './changes.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { getShellDb } from './host.ts';
import { runAs } from './owner.ts';
import {
  ALLOW_RLS_BYPASS_ENV,
  applyShellRls,
  bindShellScope,
  protectShellTables,
  SHELL_TENANT_MODELS,
  shellRlsState,
} from './shell-tenancy.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;

type Db = Awaited<ReturnType<typeof getDatabase>>;
const rowsOf = (r: unknown): Array<Record<string, any>> =>
  ((Array.isArray(r) ? r : (r as { rows?: unknown[] })?.rows) ?? []) as Array<
    Record<string, any>
  >;

describe.each(backends)('shell tables, forced RLS (%s)', (backend) => {
  const tag = Math.random().toString(36).slice(2, 8);
  const role = `shell_rls_${tag}`;
  const schema = `shell_rls_${tag}`;
  const password = randomUUID();
  let admin: Db;
  let db: Db;
  let pglite: any;
  // PGlite has one connection, so the apps get an instance of their own (the
  // hosted claim and the shell's handle are different connections on a server).
  let appsPglite: any;
  let h: CloudHarness;
  let problems: string[] = [];

  /** The role's URL, its default schema the test schema (where the shell's tables are). */
  const roleUrl = (): string => {
    const url = new URL(serverUrl as string);
    url.username = role;
    url.password = password;
    url.searchParams.set('options', `-c search_path=${schema}`);
    return url.toString();
  };
  /** The role's own handle, pinned to the test schema. */
  const roleDb = async (): Promise<Db> => {
    if (backend === 'postgres') {
      return getDatabase({
        type: 'postgres',
        url: roleUrl(),
        max: 4,
        cache: false,
      } as never);
    }
    await pglite.exec(`SET ROLE "${role}"; SET search_path TO "${schema}"`);
    return getDatabase({ type: 'pglite', client: pglite } as never);
  };

  beforeAll(async () => {
    if (backend === 'postgres') {
      admin = await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
        cache: false,
      } as never);
    } else {
      const { PGlite } = await importPGlite();
      pglite = await PGlite.create();
      appsPglite = await PGlite.create();
      admin = await getDatabase({ type: 'pglite', client: pglite } as never);
    }
    await admin.query(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`,
    );
    if (backend === 'postgres') {
      // A non-superuser CI login that made the role holds only ADMIN OPTION on it
      // (16+); `CREATE SCHEMA ... AUTHORIZATION` and the test's cleanup need SET.
      const major = Math.floor(
        Number(
          rowsOf(await admin.query('SHOW server_version_num'))[0]
            ?.server_version_num,
        ) / 10000,
      );
      await admin.query(
        major >= 16
          ? `GRANT "${role}" TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`
          : `GRANT "${role}" TO CURRENT_USER`,
      );
    }
    await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${role}"`);
    // The deployment's login owns everything it makes, as a single-login
    // deployment's does.
    db = await roleDb();
    h = await openCloudShell(
      {
        // The apps live on the same server, so a publish runs inside the hosted
        // claim's own transaction with the shell's rows (store-in-swap): that
        // transaction is one the shell's handle did not open.
        appDatabase: {
          config: (appSchema): DatabaseConfig =>
            backend === 'postgres'
              ? {
                  kind: 'postgres',
                  schema: appSchema,
                  connection: { url: roleUrl(), max: 2 },
                }
              : { kind: 'pglite', schema: appSchema, client: appsPglite },
          provision: async (appSchema) => {
            if (backend === 'postgres')
              await admin.query(
                `CREATE SCHEMA IF NOT EXISTS "${appSchema}" AUTHORIZATION "${role}"`,
              );
            else
              await appsPglite.exec(
                `CREATE SCHEMA IF NOT EXISTS "${appSchema}"`,
              );
          },
        },
      },
      {
        db,
        afterOwners: async (handle) => {
          problems = await applyShellRls(handle as never);
        },
      },
    );
  });
  afterAll(async () => {
    await h?.close();
    if (backend === 'postgres') {
      await db?.close?.();
      for (const s of (
        rowsOf(
          await admin.query(
            `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%' AND nspowner = (SELECT oid FROM pg_roles WHERE rolname = '${role}')`,
          ),
        ) as Array<{ nspname: string }>
      ).map((r) => r.nspname))
        await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.close?.();
    } else {
      await pglite.exec('RESET ROLE');
      await pglite.close();
      await appsPglite.close();
    }
    rmSync(h?.dir ?? '', { recursive: true, force: true });
  });

  /** A raw read of `table` as `who`, through the shell's own tenant-bound handle. */
  const rawAs = (who: CloudHarness['a'], sql: string, params: unknown[] = []) =>
    runAs(who, async () =>
      rowsOf(await (await getShellDb()).query(sql, params)),
    );
  /**
   * The same read with no tenant in the way: a transaction that carries the
   * engine's system context (no production code path does this; it counts
   * every owner's rows).
   */
  const everything = (sql: string, params: unknown[] = []) =>
    (db as Required<Pick<Db, 'transaction'>>).transaction(async (tx) => {
      await bindShellScope(tx as never, { tenantId: null, system: true });
      return rowsOf(await tx.query(sql, params));
    });

  it('changes nothing on a start that finds the policies current (no DDL under live traffic)', async () => {
    const statements: string[] = [];
    const spy = {
      engine: 'pglite',
      query: (sql: string, ...params: unknown[]) => {
        statements.push(sql);
        return db.query(sql, ...params);
      },
      transaction: undefined,
    };
    await applyShellRls(spy as never);
    expect(
      statements.filter((q) => /\b(CREATE|DROP|ALTER)\b/i.test(q)),
    ).toEqual([]);
  });

  it('refuses to start on a login that bypasses row-level security, unless told loudly', async () => {
    // The shell's real login, except that the catalog says it bypasses (what a
    // superuser or BYPASSRLS role reports); everything else is the real database.
    const seen: Array<Record<string, unknown>> = [];
    const asSuper = {
      engine: 'pglite',
      query: async (sql: string, ...params: unknown[]) =>
        /pg_roles/.test(sql)
          ? { rows: [{ bypass: true }] }
          : db.query(sql, ...params),
    };
    await expect(
      protectShellTables(asSuper, { env: {}, warn: (e) => seen.push(e) }),
    ).rejects.toThrow(/bypasses row-level security/);
    expect(seen[0]).toMatchObject({ event: 'app-shell.database.rls-bypass' });
    seen.length = 0;
    await expect(
      protectShellTables(asSuper, {
        env: { [ALLOW_RLS_BYPASS_ENV]: '1' },
        warn: (e) => seen.push(e),
      }),
    ).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({
      event: 'app-shell.database.rls-bypass-allowed',
    });
  });

  /** Run the generated decide route as `who`, its collections on a request database that carries `permissions`. */
  const decideAs = async (
    who: CloudHarness['a'],
    id: string,
    permissions: string[],
  ) => {
    const settings = postgresPrincipalSettings({
      tenantId: who.tenantId,
      userId: who.id,
      session: null,
      sessionId: null,
      permissions,
      superAdminBypass: false,
      systemContext: false,
    });
    const methods = new Set([
      'get',
      'list',
      'query',
      'insert',
      'update',
      'upsert',
      'delete',
      'count',
    ]);
    const requestDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && methods.has(prop))
          return (...args: unknown[]) =>
            (target as Required<Pick<Db, 'transaction'>>).transaction(
              async (tx) => {
                for (const [k, v] of settings)
                  await tx.query('SELECT set_config(?, ?, true)', [k, v]);
                return (
                  tx as never as Record<string, (...a: unknown[]) => unknown>
                )[prop](...args);
              },
            );
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    request.collection = async () =>
      ApprovalCollection.create({ db: requestDb as never });
    try {
      return await runAs(who, async () =>
        decideRoute.POST({
          locals: {
            user: { id: who.id, tenantId: who.tenantId },
            tenantContext: {
              tenantId: who.tenantId,
              permissions: new Set(permissions),
            },
            permissions,
          },
          params: { id },
          request: new Request('http://localhost/x', {
            method: 'POST',
            body: JSON.stringify({ approve: false }),
          }),
        } as never),
      );
    } catch (error) {
      return error as { status?: number };
    } finally {
      request.collection = null;
    }
  };

  it('lets an owner decide their own approval through the generated route, and nobody else’s', async () => {
    const pending: Record<string, string> = {};
    for (const owner of [h.a, h.b])
      pending[owner.tenantId] = await runAs(owner, async () => {
        const row = await (
          await ApprovalCollection.create({ db: await getShellDb() })
        ).create({
          status: 'pending',
          summary: 'x',
          actionKey: randomUUID(),
          requestedBy: owner.id,
          command: '{}',
          createdAt: new Date().toISOString(),
        });
        await row.save();
        return row.id as string;
      });
    const owned = ['approvals.read', 'approvals.update'];
    // Another owner's id: the policy hides the row, so the route says 404.
    const other = (await decideAs(h.b, pending[h.a.tenantId], owned)) as {
      status?: number;
    };
    expect(other.status).toBe(404);
    // A session without the read permission sees nothing either.
    const noRead = (await decideAs(h.a, pending[h.a.tenantId], [
      'approvals.update',
    ])) as { status?: number };
    expect(noRead.status).toBe(404);
    // The owner's own: loaded through their request database, decided by the shell.
    const mine = (await decideAs(
      h.a,
      pending[h.a.tenantId],
      owned,
    )) as Response;
    expect(mine.status).toBe(200);
    expect(await mine.json()).toMatchObject({
      action: 'decide',
      result: { id: pending[h.a.tenantId], status: 'denied' },
    });
    // And bob's own is still his to decide.
    expect(
      ((await decideAs(h.b, pending[h.b.tenantId], owned)) as Response).status,
    ).toBe(200);
  });

  it('puts every shell table under forced row-level security and finds the login subject to it', async () => {
    expect(problems).toEqual([]);
    const state = await shellRlsState(db as never);
    expect(state.map((s) => s.table).sort()).toHaveLength(
      SHELL_TENANT_MODELS.length,
    );
    for (const s of state)
      expect(s, s.table).toMatchObject({
        rls: true,
        forced: true,
        policies: 4,
      });
  });

  it('keeps each owner’s app, versions, approvals and drafts from the other, below the application layer', async () => {
    // ann builds something and starts changes waiting; bob does the same.
    await runAs(h.a, () =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    );
    await runAs(h.b, () =>
      App.defineModel('Invoice', { number: { type: 'text' } }),
    );
    for (const owner of [h.a, h.b]) await runAs(owner, () => changesState());
    await flushChecks();
    await runAs(h.a, async () => applyOwnBatch((await changesState()).digest));
    await runAs(h.b, async () => applyOwnBatch((await changesState()).digest));

    // Each owner's rows exist (the system path counts every owner's)...
    const tables = ['apps', 'app_versions', 'approvals', 'app_drafts'];
    for (const table of tables) {
      const all = await everything(`SELECT id, tenant_id FROM ${table}`);
      const tenants = new Set(all.map((r) => String(r.tenant_id)));
      expect(tenants, table).toEqual(new Set([h.a.tenantId, h.b.tenantId]));
    }
    // ...and each owner reads only their own, even asking for the other's
    // row by id with raw SQL (the interceptor never sees raw SQL).
    for (const table of tables) {
      const theirs = (
        await everything(`SELECT id FROM ${table} WHERE tenant_id = ?`, [
          h.a.tenantId,
        ])
      ).map((r) => r.id);
      expect(theirs.length, table).toBeGreaterThan(0);
      const asBob = await rawAs(
        h.b,
        `SELECT id, tenant_id FROM ${table} WHERE id IN (${theirs.map(() => '?').join(', ')})`,
        theirs,
      );
      expect(asBob, `${table} as bob`).toEqual([]);
      const own = await rawAs(h.b, `SELECT tenant_id FROM ${table}`);
      expect(own.length, `${table} own`).toBeGreaterThan(0);
      for (const r of own) expect(String(r.tenant_id)).toBe(h.b.tenantId);
    }
  });

  it('refuses another owner’s write: nothing changes, nothing can be planted in their name', async () => {
    const appRow = (
      await everything('SELECT id, name FROM apps WHERE tenant_id = ?', [
        h.a.tenantId,
      ])
    )[0];
    // UPDATE and DELETE of ann's row by id, as bob: no row is visible to touch.
    const updated = await rawAs(
      h.b,
      'UPDATE apps SET name = ? WHERE id = ? RETURNING id',
      ['pwned', appRow.id],
    );
    expect(updated).toEqual([]);
    const deleted = await rawAs(
      h.b,
      'DELETE FROM apps WHERE id = ? RETURNING id',
      [appRow.id],
    );
    expect(deleted).toEqual([]);
    expect(
      (await everything('SELECT name FROM apps WHERE id = ?', [appRow.id]))[0]
        ?.name,
    ).toBe(appRow.name);
    // INSERT as bob into ann's tenant is refused by the policy itself.
    await expect(
      rawAs(
        h.b,
        'INSERT INTO app_drafts (id, tenant_id, status) VALUES (?, ?, ?)',
        [randomUUID(), h.a.tenantId, 'open'],
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('shows nothing to a connection that carries no tenant, owner or not', async () => {
    // The role owns the tables; with FORCE it is still subject to the
    // policies. A raw statement on the base handle (no settings) sees no rows
    // although rows exist.
    const exists = await everything('SELECT count(*) AS n FROM apps');
    expect(Number(exists[0].n)).toBeGreaterThan(0);
    const bare = await runAs(h.a, async () => {
      const handle = db as unknown as {
        query(sql: string): Promise<unknown>;
      };
      return rowsOf(await handle.query('SELECT id FROM apps'));
    });
    expect(bare).toEqual([]);
  });

  it('refuses a store call that has no tenant context at all', async () => {
    await expect(getShellDb()).rejects.toThrow();
    // A store holds its handle for its whole life: the tenant is read when
    // the operation runs, so a call made after the request ended is refused.
    const held = await runAs(h.a, () => getShellDb());
    await expect(held.query('SELECT id FROM apps')).rejects.toThrow(
      /no tenant context/,
    );
  });

  it('would show the other owner’s rows if the policy were not there (the test bites)', async () => {
    const tables = ['apps'];
    for (const table of tables)
      await admin.query(
        `ALTER TABLE "${schema}"."${table}" NO FORCE ROW LEVEL SECURITY`,
      );
    for (const table of tables)
      await admin.query(
        `ALTER TABLE "${schema}"."${table}" DISABLE ROW LEVEL SECURITY`,
      );
    try {
      const theirs = (
        await everything('SELECT id FROM apps WHERE tenant_id = ?', [
          h.a.tenantId,
        ])
      ).map((r) => r.id);
      const asBob = await rawAs(h.b, 'SELECT id FROM apps WHERE id = ?', [
        theirs[0],
      ]);
      expect(asBob.map((r) => r.id)).toEqual([theirs[0]]);
    } finally {
      await applyShellRls(db as never);
    }
    expect(
      await rawAs(h.b, 'SELECT id FROM apps WHERE tenant_id = ?', [
        h.a.tenantId,
      ]),
    ).toEqual([]);
  });
});
