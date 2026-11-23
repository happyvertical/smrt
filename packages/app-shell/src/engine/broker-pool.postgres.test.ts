// The shared pool and the split credentials on a real PostgreSQL server
// (#5188): the `test:postgres` lane, gated on SMRT_TEST_POSTGRES_URL exactly
// like broker-roles.postgres.test.ts (set by CI's "Registered PostgreSQL
// Suites" lane and by `gh workflow run on-demand-validation.yml`; skipped
// everywhere else, never started by a test). The URL's role must be allowed to
// create roles and own schemas. It plays the deployment's ADMIN; the runtime
// login is a separate, unprivileged one made here.
//
// What only a server shows: the 42501 of a login that holds nothing, the
// owner lane running on the admin's session, the connection count the server
// sees under load, a deadline cancelling a real statement, and the caps lock
// serialising two connections.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import { AppCaps, AppLimitError } from './app-limits.ts';
import { Broker, pooledBackend } from './db/broker.ts';
import { takeCapsLock } from './db/index.ts';
import { BrokerPool, postgresPoolDriver } from './db/pool.ts';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import { DatabaseBusyError } from './errors.ts';
import {
  AppHost,
  appPermissionSlugs,
  enginePrincipal,
  MemoryVersionStore,
} from './index.ts';
import { slugFor } from './permissions.ts';
import { sqlstate, sqlstateOf, urlAs } from './pg-test-support.ts';
import { mintSystemPrincipal } from './principal.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!serverUrl)('the shared pool on a PostgreSQL server', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  // A UUID: an app's rows carry their tenant in a UUID column (#5189).
  const TENANT = '33333333-3333-4333-8333-333333333333';
  const schemaA = `app_bp_a_${suffix}`;
  const schemaB = `app_bp_b_${suffix}`;
  const login = `bp_login_${suffix}`;
  const password = `pw_${suffix}`;
  const rolesA = appRoles(schemaA);
  const dirs: string[] = [];
  const pools: BrokerPool[] = [];
  let admin: any;
  let adminLogin = '';
  let runtimeUrl = '';
  let bare: any;

  const user = (userId: string, permissions: string[] = []) =>
    enginePrincipal({ kind: 'user', tenantId: TENANT, userId, permissions });
  const code = sqlstate;
  /** A broker on a fresh pool of `max` slots, owner lane on the admin credentials. */
  const open = (
    poolOptions: Partial<ConstructorParameters<typeof BrokerPool>[1]> = {},
    binding: { opDeadlineMs?: number; schema?: string } = {},
  ) => {
    const max = poolOptions.max ?? 3;
    const pool = new BrokerPool(
      postgresPoolDriver(
        { connection: { url: runtimeUrl }, admin: { url: serverUrl } },
        max,
      ),
      {
        max,
        perApp: 2,
        maxQueued: 4,
        acquireTimeoutMs: 5000,
        ...poolOptions,
      },
    );
    pools.push(pool);
    const schema = binding.schema ?? schemaA;
    const broker = new Broker(pooledBackend(pool, TENANT), {
      tenantId: TENANT,
      schema,
      roles: appRoles(schema),
      ...(binding.opDeadlineMs ? { opDeadlineMs: binding.opDeadlineMs } : {}),
    });
    return { pool, broker };
  };

  const priorAutoSchema = process.env.SMRT_VITEST_AUTO_SCHEMA;
  beforeAll(async () => {
    // The pool driver opens its connections through getDatabase; the vitest
    // setup would sync every SMRT table into `public` on each, as the login.
    process.env.SMRT_VITEST_AUTO_SCHEMA = '0';
    admin = await getDatabase({
      type: 'postgres',
      url: serverUrl,
      max: 1,
      cache: false,
      // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
      __smrtSkipVitestSchemaPreparation: true,
    } as any);
    adminLogin = (await admin.query('SELECT current_user AS u')).rows[0].u;
    await admin.query(
      `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
    );
    for (const s of [schemaA, schemaB]) {
      await admin.query(`CREATE SCHEMA "${s}"`);
      await admin.query(`CREATE TABLE "${s}"._app_meta (key text, value text)`);
      await admin.query(
        `CREATE TABLE "${s}".item (id int PRIMARY KEY, label text)`,
      );
      // The deployment's split: the owner role goes to the admin, not the login.
      await provisionAppRoles(admin, s, login, undefined, {
        ownerLogin: adminLogin,
      });
    }
    runtimeUrl = urlAs(serverUrl as string, login, password);
    bare = await getDatabase({
      type: 'postgres',
      url: runtimeUrl,
      max: 1,
      cache: false,
      // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
      __smrtSkipVitestSchemaPreparation: true,
    } as any);
  });
  afterAll(async () => {
    if (priorAutoSchema === undefined)
      delete process.env.SMRT_VITEST_AUTO_SCHEMA;
    else process.env.SMRT_VITEST_AUTO_SCHEMA = priorAutoSchema;
    for (const p of pools) await p.close().catch(() => {});
    await bare?.close?.();
    for (const s of [schemaA, schemaB])
      await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    for (const s of [schemaA, schemaB]) {
      const r = appRoles(s);
      await admin.query(`DROP ROLE IF EXISTS "${r.app}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${r.owner}"`).catch(() => {});
    }
    await admin.query(`DROP ROLE IF EXISTS "${login}"`).catch(() => {});
    await admin.close?.();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("the bare login gets 42501 on both apps' tables and cannot switch to an owner role", async () => {
    for (const s of [schemaA, schemaB])
      expect(await code(() => bare.query(`SELECT * FROM "${s}".item`))).toBe(
        '42501',
      );
    // Split credentials: the login is a member of the runtime roles only.
    expect(await code(() => bare.query(`SET ROLE "${rolesA.owner}"`))).toBe(
      '42501',
    );
    expect(
      await code(() => bare.query(`SET ROLE "${appRoles(schemaB).owner}"`)),
    ).toBe('42501');
  });

  it("a data op runs as the app's runtime role on the login, an owner op as the owner role on the admin's session", async () => {
    const { pool, broker } = open();
    broker.register(1, { principal: user('u1'), lane: 'data' });
    broker.register(2, {
      principal: mintSystemPrincipal(TENANT),
      lane: 'owner',
    });
    const data = (
      await broker.query(1, 'SELECT current_user AS u, session_user AS s')
    ).rows[0];
    const owner = (
      await broker.query(2, 'SELECT current_user AS u, session_user AS s')
    ).rows[0];
    expect(data).toEqual({ u: rolesA.app, s: login });
    expect(owner).toEqual({ u: rolesA.owner, s: adminLogin });
    // both counted in the one pool
    expect(pool.stats.inUse).toBe(2);
    await broker.end(1, true);
    await broker.end(2, true);
    expect(pool.stats.inUse).toBe(0);
  });

  it("role A gets 42501 on app B's tables through the broker", async () => {
    const { broker } = open();
    broker.register(1, { principal: user('u'), lane: 'data' });
    expect(
      await code(() => broker.query(1, `SELECT * FROM "${schemaB}".item`)),
    ).toBe('42501');
    await broker.end(1, false);
  });

  it('two principals interleaved on two connections each see their own settings (acceptance 2)', async () => {
    const { pool, broker } = open();
    broker.register(1, { principal: user('p1', ['item.list']), lane: 'data' });
    broker.register(2, {
      principal: user('p2', ['item.list', 'item.create']),
      lane: 'data',
    });
    const who = (id: number) =>
      broker
        .query(
          id,
          `SELECT current_setting('smrt.user_id') AS uid, current_setting('smrt.permissions') AS perms, pg_backend_pid() AS pid`,
        )
        .then((r) => r.rows[0]);
    const first = await Promise.all([who(1), who(2)]);
    expect(pool.stats.inUse).toBe(2);
    const second = await Promise.all([who(2), who(1)]);
    expect(first[0].uid).toBe('p1');
    expect(first[1].uid).toBe('p2');
    expect(second[0].uid).toBe('p2');
    expect(second[1].uid).toBe('p1');
    expect(first[0].perms).toBe('["item.list"]');
    expect(first[0].pid).not.toBe(first[1].pid);
    // each stays on its own backend for the whole operation
    expect(second[1].pid).toBe(first[0].pid);
    expect(second[0].pid).toBe(first[1].pid);
    await broker.end(1, true);
    await broker.end(2, true);
  });

  it('never has more transactions on the server than the pool allows, however many are asked', async () => {
    const max = 2;
    const { pool, broker } = open({ max, perApp: 2, maxQueued: 16 });
    let peak = 0;
    let sampling = true;
    const sample = (async () => {
      while (sampling) {
        const n = (
          await bare.query(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE usename = current_user AND pid <> pg_backend_pid()
                AND state IN ('active', 'idle in transaction')`,
          )
        ).rows[0].n;
        peak = Math.max(peak, n);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    await Promise.all(
      Array.from({ length: 8 }, async (_, i) => {
        const id = 100 + i;
        broker.register(id, { principal: user(`u${i}`), lane: 'data' });
        await broker.query(id, 'SELECT pg_sleep(0.15)');
        await broker.end(id, true);
      }),
    );
    sampling = false;
    await sample;
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(max);
    expect(pool.stats).toMatchObject({ inUse: 0, queued: 0 });
  });

  it('a full pool refuses the next operation at once with a 503-style error', async () => {
    const { pool, broker } = open({ max: 1, perApp: 1, maxQueued: 0 });
    broker.register(1, { principal: user('a'), lane: 'data' });
    broker.register(2, { principal: user('b'), lane: 'data' });
    await broker.query(1, 'SELECT 1');
    const err = await broker.query(2, 'SELECT 1').catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseBusyError);
    expect(await broker.end(2, false).catch((e) => e.code)).toBe('unavailable');
    await broker.end(1, true);
    expect(pool.stats.inUse).toBe(0);
  });

  it('a deadline cancels a running statement on the server and frees the slot', async () => {
    const { pool, broker } = open({ max: 1 }, { opDeadlineMs: 300 });
    broker.register(1, { principal: user('slow'), lane: 'data' });
    const started = Date.now();
    const err = await broker.query(1, 'SELECT pg_sleep(30)').catch((e) => e);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sqlstateOf(err)).toBe('57014'); // query_canceled
    await expect(broker.end(1, true)).rejects.toThrow(/deadline/);
    await new Promise((r) => setTimeout(r, 100));
    expect(pool.stats.inUse).toBe(0);
    broker.register(2, { principal: user('next'), lane: 'data' });
    expect((await broker.query(2, 'SELECT 1 AS one')).rows[0].one).toBe(1);
    await broker.end(2, true);
  }, 30_000);

  it("one operation's settings, role and session state never reach the next, on a pool of one", async () => {
    const { broker } = open({ max: 1, perApp: 1 });
    broker.register(1, { principal: user('alice', ['x.get']), lane: 'data' });
    await broker.query(1, `SELECT set_config('smrt.leak', 'A', false)`);
    // Temp tables are not allowed (TEMP is revoked); the refusal aborts the
    // transaction, which rolls back, and nothing of it may survive.
    expect(
      await code(() => broker.query(1, 'CREATE TEMP TABLE leftover (x int)')),
    ).toBe('42501');
    await broker.end(1, false);
    broker.register(2, { principal: user('bob'), lane: 'data' });
    const seen = (
      await broker.query(
        2,
        `SELECT current_user AS u, current_setting('smrt.user_id') AS uid,
                current_setting('smrt.leak', true) AS leak,
                to_regclass('pg_temp.leftover') AS temp`,
      )
    ).rows[0];
    await broker.end(2, true);
    expect(seen.u).toBe(rolesA.app);
    expect(seen.uid).toBe('bob');
    expect(seen.leak ?? '').toBe('');
    expect(seen.temp).toBeNull();
  });

  it('the caps lock holds a second connection back until the first commits, so two creates never both fit one slot', async () => {
    const { broker } = open({ max: 2, perApp: 2 });
    await admin.query(`DELETE FROM "${schemaA}".item`);
    const handle = (id: number) => ({
      query: (sql: string) => broker.query(id, sql),
    });
    const caps = () =>
      new AppCaps(
        { maxRows: 1 },
        () => [{ model: 'Item', label: 'Item', table: 'item' }],
        async (table, h) =>
          Number(
            (
              await (h as ReturnType<typeof handle>).query(
                `SELECT count(*)::int AS n FROM "${table}"`,
              )
            ).rows[0].n,
          ),
        undefined,
        (h) => takeCapsLock(h as ReturnType<typeof handle>, schemaA),
      );
    const create = (id: number, row: number) => {
      const h = handle(id);
      const c = caps();
      return c.withWriteLock(async () => {
        await c.checkAdd({ Item: 1 }, h);
        await h.query(`INSERT INTO item (id, label) VALUES (${row}, 'x')`);
      }, h);
    };
    broker.register(1, { principal: user('a'), lane: 'data' });
    broker.register(2, { principal: user('b'), lane: 'data' });
    const first = create(1, 1);
    await first;
    let secondSettled = false;
    const second = create(2, 2).then(
      () => 'ok',
      (e) => e,
    );
    void second.then(() => {
      secondSettled = true;
    });
    // The first has written but not committed: the second waits on the lock
    // instead of counting zero rows and inserting too.
    await new Promise((r) => setTimeout(r, 400));
    expect(secondSettled).toBe(false);
    await broker.end(1, true);
    const outcome = await second;
    expect(outcome).toBeInstanceOf(AppLimitError);
    await broker.end(2, false);
    const n = (
      await admin.query(`SELECT count(*)::int AS n FROM "${schemaA}".item`)
    ).rows[0].n;
    expect(n).toBe(1);
  }, 30_000);

  it('an AppHost on split credentials boots as the owner role and serves two principals (acceptance 2)', async () => {
    const schema = `app_bp_h_${suffix}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await provisionAppRoles(admin, schema, login, undefined, {
      ownerLogin: adminLogin,
    });
    const dir = mkdtempSync(join(tmpdir(), 'broker-pool-pg-'));
    dirs.push(dir);
    const pool = new BrokerPool(
      postgresPoolDriver(
        { connection: { url: runtimeUrl }, admin: { url: serverUrl } },
        4,
      ),
      { max: 4, perApp: 3, maxQueued: 8, acquireTimeoutMs: 5000 },
    );
    pools.push(pool);
    const roles = appRoles(schema);
    const host = await AppHost.open(dir, {
      store: new MemoryVersionStore(),
      allowUnfencedStore: true,
      tenantId: TENANT,
      workerLimits: {
        opDeadlineMs: 20_000,
        connections: { poolSize: 2, take: () => () => {}, pool: () => pool },
      },
      database: {
        kind: 'postgres',
        schema,
        connection: { url: runtimeUrl },
        admin: { url: serverUrl as string },
        roles,
      },
    });
    try {
      await host.execute(
        {
          type: 'defineModel',
          name: 'Chore',
          fields: { title: { type: 'text' } },
        },
        { author: 't', approved: true },
      );
      const p1 = enginePrincipal({
        kind: 'user',
        tenantId: TENANT,
        userId: 'p1',
        permissions: [
          slugFor(host.def, 'Chore', 'list'),
          slugFor(host.def, 'Chore', 'get'),
        ],
      });
      const p2 = hostOwner(host, 'p2');
      const results = await Promise.allSettled([
        host.create(p2, 'Chore', { title: 'p2-a' }),
        host.list(p1, 'Chore'),
        host.create(p1, 'Chore', { title: 'p1-denied' }),
        host.create(p2, 'Chore', { title: 'p2-b' }),
        host.list(p2, 'Chore'),
      ]);
      expect(results.map((r) => r.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
      ]);
      const titles = (await host.list(p2, 'Chore')).map((r: any) => r.title);
      expect(titles.sort()).toEqual(['p2-a', 'p2-b']);
      expect(appPermissionSlugs(host.def).length).toBeGreaterThan(0);
      // The tables are the owner role's, never the runtime login's.
      const owners = (
        await admin.query(
          `SELECT DISTINCT pg_get_userbyid(c.relowner) AS o FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = '${schema}' AND c.relkind = 'r' AND c.relname NOT IN ('_app_meta')`,
        )
      ).rows.map((r: any) => r.o);
      expect(owners).toEqual([roles.owner]);
    } finally {
      await host.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${roles.app}"`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS "${roles.owner}"`).catch(() => {});
    }
  }, 60_000);
});
