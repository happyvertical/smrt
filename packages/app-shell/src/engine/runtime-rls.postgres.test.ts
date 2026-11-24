// Row-level security on the tables of run-time models (#5189): the registered
// `test:postgres` suite. It runs on an in-process PGlite everywhere (its twin)
// and ALSO on a real PostgreSQL server when `SMRT_TEST_POSTGRES_URL` is set
// (CI's "Registered PostgreSQL Suites" lane).
//
// An app is opened and given models the way a host does, then its tables are
// read as the app's runtime role with the settings the broker writes for a
// principal (`postgresPrincipalSettings`), once per tenant. The cross-tenant
// assertions fail if the policies are removed: with no policy a forced table
// shows nobody anything, so the owner tenant's own read fails too.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresPrincipalSettings } from '@happyvertical/smrt-users/postgres-settings';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import type { DatabaseConfig, PGliteClient } from './db/index.ts';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import { AppHost, type Command, MemoryVersionStore } from './index.ts';
import { asEngine, sqlstate } from './pg-test-support.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

describe.each(backends)('run-time model row-level security (%s)', (backend) => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const login = `rls_login_${suffix}`;
  let admin: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
    close?: () => Promise<void>;
  };
  let pglite: PGliteClient | undefined;
  let adminLogin = '';
  let serverMajor = 0;
  let adminSuper = true;
  const dirs: string[] = [];
  const schemas: string[] = [];
  const hosts: AppHost[] = [];

  // Forced policies hide the tables from a raw owner: arrange and read as the engine.
  const rows = async (sql: string, params: unknown[] = []) =>
    asEngine(admin as any, sql, params);
  const config = (schema: string): DatabaseConfig =>
    backend === 'postgres'
      ? { kind: 'postgres', schema, connection: { url: serverUrl, max: 2 } }
      : { kind: 'pglite', schema, client: pglite as PGliteClient };
  const stores = new Map<string, MemoryVersionStore>();
  const open = async (schema: string, tenantId: string, dir?: string) => {
    const d = dir ?? mkdtempSync(join(tmpdir(), 'engine-rls-'));
    if (!dir) dirs.push(d);
    // A reopened app keeps its version history.
    const store = stores.get(d) ?? new MemoryVersionStore();
    stores.set(d, store);
    const host = await AppHost.open(d, {
      allowUnfencedStore: true,
      store,
      database: config(schema),
      tenantId,
    });
    hosts.push(host);
    return { host, dir: d };
  };
  const run = (host: AppHost, cmd: Command) =>
    host.execute(hostOwner(host), cmd, { author: 'test', approved: true });
  const newSchema = async (label: string) => {
    const schema = `app_rls_${label}_${suffix}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };

  /** Give the runtime role of `schema` its table privileges, now that the tables exist. */
  const provision = async (schema: string) => {
    await provisionAppRoles(admin, schema, login);
    // Switching to the role needs SET on it (a role the admin made gives ADMIN only, 16+).
    if (!adminSuper) {
      const r = appRoles(schema);
      await admin.query(
        serverMajor >= 16
          ? `GRANT "${r.app}" TO "${adminLogin}" WITH SET TRUE, INHERIT FALSE`
          : `GRANT "${r.app}" TO "${adminLogin}"`,
      );
    }
  };

  /**
   * Run `sql` as the runtime role of `schema` in a transaction that carries the
   * settings of a principal, exactly what the broker writes before an operation.
   */
  const asRuntime = async (
    schema: string,
    principal: {
      tenantId: string;
      permissions?: string[];
      systemContext?: boolean;
    },
    sql: string,
  ) =>
    admin.transaction(async (tx: any) => {
      const settings: Array<[string, string]> = [
        ['search_path', `"${schema}"`],
        ...postgresPrincipalSettings({
          tenantId: principal.tenantId,
          userId: 'u',
          session: null,
          sessionId: null,
          permissions: principal.permissions ?? [],
          superAdminBypass: false,
          systemContext: principal.systemContext === true,
        }),
      ];
      for (const [k, v] of settings)
        await tx.query(
          `SELECT set_config('${k}', '${v.replace(/'/g, "''")}', true)`,
        );
      await tx.query(`SET LOCAL ROLE "${appRoles(schema).app}"`);
      return (await tx.query(sql)).rows as Array<Record<string, any>>;
    });
  const sqlstateAsRuntime = (
    schema: string,
    principal: Parameters<typeof asRuntime>[1],
    sql: string,
  ) => sqlstate(() => asRuntime(schema, principal, sql));

  beforeAll(async () => {
    if (backend === 'postgres') {
      admin = (await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
        cache: false,
        __smrtSkipVitestSchemaPreparation: true,
      } as any)) as any;
    } else {
      const { PGlite } = await importPGlite();
      pglite = (await PGlite.create()) as PGliteClient;
      admin = (await getDatabase({
        type: 'pglite',
        client: pglite,
      } as any)) as any;
    }
    adminLogin = (await rows('SELECT current_user AS u'))[0].u;
    serverMajor = Math.floor(
      Number(
        (await rows(`SELECT current_setting('server_version_num') AS v`))[0].v,
      ) / 10000,
    );
    adminSuper =
      (
        await rows('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
      )[0].rolsuper === true;
    await admin.query(
      `CREATE ROLE "${login}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
    );
  });
  afterAll(async () => {
    for (const h of hosts.splice(0)) await h.close().catch(() => {});
    for (const s of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
      const r = appRoles(s);
      await admin.query(`DROP ROLE IF EXISTS "${r.app}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${r.owner}"`).catch(() => {});
    }
    await admin.query(`DROP ROLE IF EXISTS "${login}"`).catch(() => {});
    if (backend === 'postgres') await admin.close?.();
    else await pglite?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const policies = (schema: string, table: string) =>
    rows(
      `SELECT p.polname AS name, p.polcmd AS cmd FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE c.relnamespace = to_regnamespace('${schema}') AND c.relname = '${table}' ORDER BY 2`,
    );
  const flags = async (schema: string, table: string) =>
    (
      await rows(
        `SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE relnamespace = to_regnamespace('${schema}') AND relname = '${table}'`,
      )
    )[0];

  it('registers the models tenant-scoped, enables and forces RLS, and writes one policy per command', async () => {
    const schema = await newSchema('a');
    const { host } = await open(schema, TENANT_A);
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text', required: true } },
    });
    expect(await flags(schema, 'u_chores')).toEqual({
      rls: true,
      forced: true,
    });
    expect(
      (await policies(schema, 'u_chores')).map((p) => p.cmd).sort(),
    ).toEqual(['a', 'd', 'r', 'w']);
    // The app's tables carry the tenant, and the engine stamps it.
    await host.create(hostOwner(host), 'Chore', { title: 'Bins' });
    expect(
      (await rows(`SELECT tenant_id::text AS t FROM "${schema}".u_chores`)).map(
        (r) => r.t,
      ),
    ).toEqual([TENANT_A]);
    // Every table of the app, not only the model's: nothing user-made is left bare.
    const bare = await rows(
      `SELECT c.relname AS n FROM pg_class c WHERE c.relnamespace = to_regnamespace('${schema}') AND c.relkind = 'r' AND c.relname LIKE 'u\\_%' AND NOT c.relforcerowsecurity`,
    );
    expect(bare).toEqual([]);
  });

  it("a second tenant cannot read, change or add to the first tenant's rows", async () => {
    const schema = await newSchema('x');
    const { host } = await open(schema, TENANT_A);
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text', required: true } },
    });
    await host.create(hostOwner(host), 'Chore', { title: 'Bins' });
    await host.create(hostOwner(host), 'Chore', { title: 'Dishes' });
    await provision(schema);
    const slugs = [
      'u_chores.list',
      'u_chores.get',
      'u_chores.create',
      'u_chores.update',
      'u_chores.delete',
    ];
    const count = async (tenantId: string, permissions: string[]) =>
      Number(
        (
          await asRuntime(
            schema,
            { tenantId, permissions },
            'SELECT count(*) AS n FROM u_chores',
          )
        )[0].n,
      );

    // The owner tenant, holding the slugs, sees its rows ...
    expect(await count(TENANT_A, slugs)).toBe(2);
    // ... another tenant sees none, even holding every slug ...
    expect(await count(TENANT_B, slugs)).toBe(0);
    // ... and the owner tenant without the read slug sees none either.
    expect(await count(TENANT_A, ['u_chores.create'])).toBe(0);
    // The engine itself (system context) sees all.
    expect(
      Number(
        (
          await asRuntime(
            schema,
            { tenantId: TENANT_A, systemContext: true },
            'SELECT count(*) AS n FROM u_chores',
          )
        )[0].n,
      ),
    ).toBe(2);

    // Another tenant changes and deletes nothing ...
    const B = { tenantId: TENANT_B, permissions: slugs };
    expect(
      await asRuntime(
        schema,
        B,
        `UPDATE u_chores SET title = 'x' RETURNING id`,
      ),
    ).toEqual([]);
    expect(
      await asRuntime(schema, B, `DELETE FROM u_chores RETURNING id`),
    ).toEqual([]);
    // ... and cannot write a row into the first tenant's name.
    expect(
      await sqlstateAsRuntime(
        schema,
        B,
        `INSERT INTO u_chores (id, slug, context, title, tenant_id) VALUES (gen_random_uuid(), 's', '', 'evil', '${TENANT_A}')`,
      ),
    ).toBe('42501');
    // Its own is fine.
    await asRuntime(
      schema,
      B,
      `INSERT INTO u_chores (id, slug, context, title, tenant_id) VALUES (gen_random_uuid(), 's', '', 'mine', '${TENANT_B}')`,
    );
    expect(await count(TENANT_B, slugs)).toBe(1);
    expect(await count(TENANT_A, slugs)).toBe(2);
    expect(
      (await rows(`SELECT count(*)::int AS n FROM "${schema}".u_chores`))[0].n,
    ).toBe(3);
  });

  it('holds for the table owner too (FORCE)', async () => {
    if (adminSuper) return; // a superuser always bypasses; the server lane's admin is not one
    const schema = await newSchema('f');
    const { host } = await open(schema, TENANT_A);
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'Chore', { title: 'Bins' });
    // The admin owns the table and set no principal: forced policies show it nothing.
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM "${schema}".u_chores`))
        .rows[0].n,
    ).toBe(0);
  });

  it('the same table name in two app schemas gets its own policies, with names that differ', async () => {
    const one = await newSchema('p1');
    const two = await newSchema('p2');
    for (const [schema, tenant] of [
      [one, TENANT_A],
      [two, TENANT_B],
    ] as const) {
      const { host } = await open(schema, tenant);
      await run(host, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
    }
    const a = await policies(one, 'u_chores');
    const b = await policies(two, 'u_chores');
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(new Set([...a, ...b].map((p) => p.name)).size).toBe(8);
    // Helpers are per schema: nothing leaked into public.
    expect(
      await rows(
        `SELECT 1 FROM pg_proc WHERE proname = 'smrt_rls_bypass' AND pronamespace = to_regnamespace('public')`,
      ),
    ).toEqual([]);
  });

  it('every structural change leaves every user table with policies, and a boot repairs a table that lost them', async () => {
    const schema = await newSchema('s');
    const { host, dir } = await open(schema, TENANT_A);
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' } },
    });
    await run(host, {
      type: 'defineModel',
      name: 'Person',
      fields: { name: { type: 'text' } },
    });
    await run(host, {
      type: 'addField',
      model: 'Chore',
      field: 'notes',
      definition: { type: 'text' },
    });
    for (const t of ['u_chores', 'u_persons']) {
      expect(await flags(schema, t)).toEqual({ rls: true, forced: true });
      expect(await policies(schema, t)).toHaveLength(4);
    }
    // A table that a restore, an import or a copy left without them is repaired at the next boot.
    await admin.query(
      `DROP POLICY ${
        (await policies(schema, 'u_persons')).map(
          (p) => `"${p.name}" ON "${schema}".u_persons`,
        )[0]
      }`,
    );
    await admin.query(
      `ALTER TABLE "${schema}".u_persons NO FORCE ROW LEVEL SECURITY`,
    );
    expect(await policies(schema, 'u_persons')).toHaveLength(3);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    await open(schema, TENANT_A, dir);
    expect(await flags(schema, 'u_persons')).toEqual({
      rls: true,
      forced: true,
    });
    expect(await policies(schema, 'u_persons')).toHaveLength(4);
  });

  it("gives rows with no tenant (a nullable tenant column, as the shipped profiles table has) the app's, so the policies do not hide them", async () => {
    const schema = await newSchema('n');
    const { host, dir } = await open(schema, TENANT_A);
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' } },
    });
    await host.create(hostOwner(host), 'Chore', { title: 'Bins' });
    await admin.query(
      `ALTER TABLE "${schema}".u_chores ALTER COLUMN tenant_id DROP NOT NULL`,
    );
    await rows(`UPDATE "${schema}".u_chores SET tenant_id = NULL`);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    const again = await open(schema, TENANT_A, dir);
    expect(
      (await rows(`SELECT tenant_id::text AS t FROM "${schema}".u_chores`)).map(
        (r) => r.t,
      ),
    ).toEqual([TENANT_A]);
    expect(await again.host.list(hostOwner(again.host), 'Chore')).toHaveLength(
      1,
    );
  });

  it("keeps one person type when the shipped profile types predate the tenant (no second type made under the app's)", async () => {
    const schema = await newSchema('r');
    const { host, dir } = await open(schema, TENANT_A);
    await run(host, { type: 'enableRecipe', recipe: 'profiles' });
    await host.create(hostOwner(host), 'Profile', { name: 'Sam' });
    await rows(`UPDATE "${schema}".profile_types SET tenant_id = NULL`);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    const again = await open(schema, TENANT_A, dir);
    await again.host.create(hostOwner(again.host), 'Profile', { name: 'Kim' });
    expect(
      (
        await rows(
          `SELECT count(*)::int AS n FROM "${schema}".profile_types WHERE slug = 'person'`,
        )
      )[0].n,
    ).toBe(1);
  });

  it('an undo puts back a row whose archived image has no tenant', async () => {
    const schema = await newSchema('u');
    const { host } = await open(schema, TENANT_A);
    await run(host, {
      type: 'defineModel',
      name: 'Customer',
      fields: { name: { type: 'text' } },
    });
    const keep = String(
      (await host.create(hostOwner(host), 'Customer', { name: 'Bob' })).id,
    );
    const other = String(
      (await host.create(hostOwner(host), 'Customer', { name: 'B' })).id,
    );
    await run(host, {
      type: 'mergeRecords',
      model: 'Customer',
      keep,
      merge: [other],
      fields: { name: 'keep' },
    });
    expect(await host.list(hostOwner(host), 'Customer')).toHaveLength(1);
    // Images archived before the table carried a tenant, or moved in from SQLite, have none.
    await admin.query(
      `UPDATE "${schema}"._archive SET value = (value::jsonb - 'tenant_id')::text WHERE col = '$row'`,
    );
    await run(host, { type: 'undo' });
    expect(await host.list(hostOwner(host), 'Customer')).toHaveLength(2);
    expect(
      (
        await rows(
          `SELECT DISTINCT tenant_id::text AS t FROM "${schema}".u_customers`,
        )
      ).map((r) => r.t),
    ).toEqual([TENANT_A]);
  });

  it('refuses a PostgreSQL app whose tenant is not a UUID', async () => {
    const schema = await newSchema('t');
    await expect(open(schema, 'not-a-uuid')).rejects.toThrow(/UUID/);
  });
});
