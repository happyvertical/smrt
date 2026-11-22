// The database broker on PGlite (#5188 threats 3 and 4, role and settings,
// rollback, deadline). In-process only: a PGlite owned by the test, the broker
// serving a MessageChannel, the worker's `BrokeredDatabase` on the other end.

import { MessageChannel } from 'node:worker_threads';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Broker, packError, pgliteBackend } from './db/broker.ts';
import {
  BrokeredDatabase,
  brokerClient,
  createTransport,
  rebuildError,
} from './db/broker-client.ts';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import type { PGliteClient } from './db/types.ts';
import { OperationEndedError } from './errors.ts';
import { sqlstate, sqlstateOf } from './pg-test-support.ts';
import { enginePrincipal, mintSystemPrincipal } from './principal.ts';

const TENANT = 'tenant-a';
const SCHEMA = 'app_broker';
const roles = appRoles(SCHEMA);
let client: PGliteClient;
let statements: string[] = [];

/** Every statement the broker sends to PGlite, in order. */
const recording = (real: PGliteClient): PGliteClient => ({
  query: (sql, params) => {
    statements.push(sql);
    return real.query(sql, params);
  },
  exec: (sql) => {
    statements.push(sql);
    return real.exec(sql);
  },
  transaction: (cb) =>
    real.transaction((tx) =>
      cb({
        query: (sql: string, params?: unknown[]) => {
          statements.push(sql);
          return tx.query(sql, params);
        },
        exec: (sql: string) => {
          statements.push(sql);
          return tx.exec(sql);
        },
        rollback: () => tx.rollback(),
        get closed() {
          return tx.closed;
        },
      }),
    ),
  close: () => real.close(),
});

const user = (userId: string, permissions: string[] = []) =>
  enginePrincipal({ kind: 'user', tenantId: TENANT, userId, permissions });

function setup(options: { opDeadlineMs?: number; useRoles?: boolean } = {}) {
  const broker = new Broker(pgliteBackend(recording(client)), {
    tenantId: TENANT,
    schema: SCHEMA,
    ...(options.useRoles === false ? {} : { roles }),
    ...(options.opDeadlineMs ? { opDeadlineMs: options.opDeadlineMs } : {}),
  });
  const { port1, port2 } = new MessageChannel();
  const stop = broker.serve(port1);
  return { broker, port: port2, stop };
}

async function worker(port: import('node:worker_threads').MessagePort) {
  const transport = await createTransport(port);
  const base = {
    query: (sql: string, params?: unknown[]) =>
      brokerClient(transport).query(sql, params),
    transaction: (cb: (tx: any) => Promise<unknown>) =>
      brokerClient(transport).transaction(cb),
  };
  return { transport, db: new BrokeredDatabase(transport, base) };
}

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  client = (await PGlite.create()) as PGliteClient;
  await client.exec(`CREATE SCHEMA "${SCHEMA}"`);
  await client.exec(
    `CREATE TABLE "${SCHEMA}"._app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );
  await provisionAppRoles(client, SCHEMA, 'postgres');
  await client.exec(
    `CREATE TABLE "${SCHEMA}".item (id int PRIMARY KEY, label text)`,
  );
  await client.exec(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON "${SCHEMA}".item TO "${roles.app}", "${roles.owner}"`,
  );
});
afterAll(async () => {
  await client.close();
});

describe('broker: the role and the settings are present inside the operation', () => {
  it('a data op runs as <schema>_r with the six settings of its principal', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(1, {
      principal: user('u-1', ['item.list']),
      lane: 'data',
    });
    const rows = await w.db.run(1, 'data', async () => {
      const r = await w.db.current().query(
        `SELECT current_user AS who, current_setting('smrt.tenant_id') AS tenant,
                  current_setting('smrt.user_id') AS uid, current_setting('smrt.permissions') AS perms,
                  current_setting('smrt.super_admin_bypass') AS bypass,
                  current_setting('smrt.system_context') AS sys,
                  current_setting('search_path') AS path`,
      );
      return r.rows[0];
    });
    expect(rows).toMatchObject({
      who: roles.app,
      tenant: TENANT,
      uid: 'u-1',
      perms: '["item.list"]',
      bypass: 'false',
      sys: 'false',
    });
    expect(rows.path).toContain(SCHEMA);
    await broker.end(1, true);
    await stop();
  });

  it('the owner lane runs as <schema>_o and the system principal sets system_context', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(2, {
      principal: mintSystemPrincipal(TENANT),
      lane: 'owner',
    });
    const r = await w.db.run(
      2,
      'owner',
      async () =>
        (
          await w.db
            .current()
            .query(
              `SELECT current_user AS who, current_setting('smrt.system_context') AS sys`,
            )
        ).rows[0],
    );
    expect(r).toEqual({ who: roles.owner, sys: 'true' });
    await broker.end(2, true);
    await stop();
  });

  it('the runtime role cannot do owner work (no CREATE on the schema)', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(3, { principal: user('u'), lane: 'data' });
    await expect(
      w.db.run(3, 'data', () =>
        w.db.current().query(`CREATE TABLE "${SCHEMA}".sneaky (x int)`),
      ),
    ).rejects.toThrow(/permission denied/);
    await broker.end(3, false);
    await stop();
  });
});

describe('threat 3: a handle reused after its operation ends', () => {
  it('a handle kept from an operation throws once the operation is over', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(10, { principal: user('u'), lane: 'data' });
    let kept: any;
    await w.db.run(10, 'data', async () => {
      kept = w.db.current();
      await kept.query('SELECT 1');
    });
    await broker.end(10, true);
    await expect(kept.query('SELECT 1')).rejects.toBeInstanceOf(
      OperationEndedError,
    );
    // and the broker side: the opId is gone
    await expect(broker.query(10, 'SELECT 1')).rejects.toBeInstanceOf(
      OperationEndedError,
    );
    await stop();
  });

  it('the handle is refused outside an operation, and a handle from op A does not run on op B', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    expect(() => w.db.current()).toThrow(OperationEndedError);
    broker.register(11, { principal: user('a'), lane: 'data' });
    broker.register(12, { principal: user('b'), lane: 'data' });
    let kept: any;
    await w.db.run(11, 'data', async () => {
      kept = w.db.current();
    });
    await broker.end(11, true);
    await w.db.run(12, 'data', async () => {
      await expect(kept.query('SELECT 1')).rejects.toBeInstanceOf(
        OperationEndedError,
      );
      const who = await w.db
        .current()
        .query(`SELECT current_setting('smrt.user_id') AS uid`);
      expect(who.rows[0].uid).toBe('b');
    });
    await broker.end(12, true);
    await stop();
  });

  it('a late port message for an ended operation is refused', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(13, { principal: user('u'), lane: 'data' });
    await w.db.run(13, 'data', async () => {
      await w.db.current().query('SELECT 1');
    });
    await broker.end(13, true);
    await expect(
      w.transport.call({ kind: 'q', opId: 13, sql: 'SELECT 1' }),
    ).rejects.toThrow(/not open|ended/);
    await expect(
      w.transport.call({ kind: 'q', opId: 99, sql: 'SELECT 1' }),
    ).rejects.toThrow(/not open|ended|registered/);
    await stop();
  });
});

describe('threat 4: nothing leaks between operations on one connection', () => {
  it("op A's settings are not visible in op B", async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(20, { principal: user('alice', ['x.get']), lane: 'data' });
    await w.db.run(20, 'data', async () => {
      // even a session-level setting a statement tries to leave behind
      await w.db.current().query(`SELECT set_config('smrt.leak', 'A', false)`);
    });
    await broker.end(20, true);
    broker.register(21, { principal: user('bob'), lane: 'data' });
    const seen = await w.db.run(21, 'data', async () => {
      const r = await w.db
        .current()
        .query(
          `SELECT current_setting('smrt.user_id') AS uid, current_setting('smrt.permissions') AS perms, current_setting('smrt.leak', true) AS leak`,
        );
      return r.rows[0];
    });
    await broker.end(21, true);
    expect(seen.uid).toBe('bob');
    expect(seen.perms).toBe('[]');
    expect(seen.leak ?? '').toBe('');
    await stop();
  });

  it('DISCARD ALL leaves no temp objects and no advisory locks', async () => {
    const { broker, port, stop } = setup({ useRoles: false });
    const w = await worker(port);
    broker.register(22, { principal: user('u'), lane: 'data' });
    await w.db.run(22, 'data', async () => {
      const db = w.db.current();
      await db.query('CREATE TEMP TABLE leftover (x int)');
      await db.query('SELECT pg_advisory_lock(424242)');
    });
    await broker.end(22, true);
    broker.register(23, { principal: user('u'), lane: 'data' });
    const seen = await w.db.run(23, 'data', async () => {
      const db = w.db.current();
      const t = await db.query(`SELECT to_regclass('pg_temp.leftover') AS t`);
      const l = await db.query(
        `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      return { temp: t.rows[0].t, locks: l.rows[0].n };
    });
    await broker.end(23, true);
    expect(seen).toEqual({ temp: null, locks: 0 });
    // DISCARD ALL ran as its own statement, never inside the transaction
    expect(
      statements.filter((s) => s === 'DISCARD ALL').length,
    ).toBeGreaterThan(1);
    await stop();
  });
});

describe('handles are per operation', () => {
  it("each operation gets its own handle, so collections bound to one are never another operation's", async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    const seen: unknown[] = [];
    for (const id of [50, 51]) {
      broker.register(id, { principal: user('u'), lane: 'data' });
      await w.db.run(id, 'data', async () => {
        seen.push(w.db.current());
        // the same handle for the whole of one operation
        expect(w.db.current()).toBe(seen.at(-1));
      });
      await broker.end(id, true);
    }
    expect(seen[0]).not.toBe(seen[1]);
    await stop();
  });
});

describe('rollback', () => {
  const countItems = async () =>
    Number(
      (await client.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".item`))
        .rows[0].n,
    );

  it('the call is durable only after end(): an ok end commits, a failed one rolls back', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    const before = await countItems();
    broker.register(30, { principal: user('u'), lane: 'data' });
    await w.db.run(30, 'data', () =>
      w.db.current().query(`INSERT INTO item (id, label) VALUES (1, 'kept')`),
    );
    await broker.end(30, true);
    expect(await countItems()).toBe(before + 1);
    broker.register(31, { principal: user('u'), lane: 'data' });
    await w.db.run(31, 'data', () =>
      w.db.current().query(`INSERT INTO item (id, label) VALUES (2, 'gone')`),
    );
    await broker.end(31, false);
    expect(await countItems()).toBe(before + 1);
    await stop();
  });

  it('a worker that dies mid-transaction is rolled back', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    const before = await countItems();
    broker.register(32, { principal: user('u'), lane: 'data' });
    await w.db.run(32, 'data', () =>
      w.db.current().query(`INSERT INTO item (id, label) VALUES (3, 'orphan')`),
    );
    expect(broker.openOps).toBe(1);
    await stop(); // the port closes: the same path as the thread exiting
    expect(broker.openOps).toBe(0);
    expect(await countItems()).toBe(before);
  });

  it('an operation past its deadline is rolled back and revoked', async () => {
    const { broker, port, stop } = setup({ opDeadlineMs: 50 });
    const w = await worker(port);
    const before = await countItems();
    broker.register(33, { principal: user('u'), lane: 'data' });
    await w.db.run(33, 'data', async () => {
      await w.db
        .current()
        .query(`INSERT INTO item (id, label) VALUES (4, 'late')`);
      await new Promise((r) => setTimeout(r, 150));
      await expect(w.db.current().query('SELECT 1')).rejects.toThrow(
        /deadline/,
      );
    });
    // the worker thought it succeeded; the host still fails the call
    await expect(broker.end(33, true)).rejects.toThrow(/deadline/);
    expect(await countItems()).toBe(before);
    await stop();
  });

  it('a nested transaction is a savepoint: a caught failure does not poison the operation', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(34, { principal: user('u'), lane: 'data' });
    await w.db.run(34, 'data', async () => {
      const db = w.db.current();
      await db.transaction(async (tx: any) => {
        await tx.query(`INSERT INTO item (id, label) VALUES (5, 'a')`);
      });
      await expect(
        db.transaction(async (tx: any) => {
          await tx.query(`INSERT INTO item (id, label) VALUES (5, 'dup')`);
        }),
      ).rejects.toThrow();
      const r = await db.query(
        `SELECT count(*)::int AS n FROM item WHERE id = 5`,
      );
      expect(r.rows[0].n).toBe(1);
    });
    await broker.end(34, true);
    await client.exec(`DELETE FROM "${SCHEMA}".item WHERE id = 5`);
    await stop();
  });
});

describe('principal and tenant', () => {
  it('a principal of another tenant is refused before BEGIN', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    statements = [];
    broker.register(40, {
      principal: enginePrincipal({
        kind: 'user',
        tenantId: 'tenant-b',
        userId: 'x',
        permissions: [],
      }),
      lane: 'data',
    });
    await expect(w.db.run(40, 'data', async () => undefined)).rejects.toThrow(
      /another tenant/,
    );
    expect(statements).toEqual([]);
    await broker.end(40, false);
    await stop();
  });

  it('an unregistered operation id issues no statement', async () => {
    const { port, stop } = setup();
    const w = await worker(port);
    statements = [];
    await expect(
      w.transport.call({ kind: 'q', opId: 777, sql: 'SELECT 1' }),
    ).rejects.toThrow();
    expect(statements).toEqual([]);
    await stop();
  });

  it('the none lane never gets a transaction', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    statements = [];
    broker.register(41, { principal: user('u'), lane: 'none' });
    await w.db.run(41, 'none', async () => undefined);
    await broker.end(41, true);
    expect(statements).toEqual([]);
    await stop();
  });
});

describe('a failing commit or discard (fake backend)', () => {
  const fake = (fail: { commit?: boolean; discard?: boolean }) => {
    const finished: boolean[] = [];
    const backend = {
      async open() {
        return {
          query: async (sql: string) => ({
            rows: sql.includes("key = 'fence'") ? [] : [{ x: 1 }],
          }),
          exec: async () => [],
          async commit() {
            if (fail.commit) throw new Error('commit failed');
          },
          async rollback() {},
          async finish(broken: boolean) {
            finished.push(broken);
            if (fail.discard) throw new Error('discard failed');
          },
        };
      },
    };
    return { backend, finished };
  };
  const brokerOf = (backend: ReturnType<typeof fake>['backend']) =>
    new Broker(backend, { tenantId: TENANT, schema: SCHEMA });

  it('a failed COMMIT fails the call and destroys the connection', async () => {
    const { backend, finished } = fake({ commit: true });
    const broker = brokerOf(backend);
    broker.register(60, { principal: user('u'), lane: 'data' });
    await broker.query(60, 'SELECT 1');
    await expect(broker.end(60, true)).rejects.toThrow(/commit failed/);
    expect(finished).toEqual([true]);
    expect(broker.openOps).toBe(0);
  });

  it('a clean commit hands the connection back, a failed DISCARD never fails the call', async () => {
    const ok = fake({});
    const b1 = brokerOf(ok.backend);
    b1.register(61, { principal: user('u'), lane: 'data' });
    await b1.query(61, 'SELECT 1');
    await b1.end(61, true);
    expect(ok.finished).toEqual([false]);
    const bad = fake({ discard: true });
    const b2 = brokerOf(bad.backend);
    b2.register(62, { principal: user('u'), lane: 'data' });
    await b2.query(62, 'SELECT 1');
    await expect(b2.end(62, true)).resolves.toBeUndefined();
    expect(bad.finished).toEqual([false]);
  });
});

describe('broker: the SQLSTATE crosses the port', () => {
  it('a unique violation and a denied statement keep their code and fields', async () => {
    const { broker, port, stop } = setup();
    const w = await worker(port);
    broker.register(70, { principal: user('u-70'), lane: 'data' });
    const dup = await w.db.run(70, 'data', async () => {
      await w.db
        .current()
        .query(`INSERT INTO item (id, label) VALUES (70, 'a')`);
      try {
        await w.db
          .current()
          .query(`INSERT INTO item (id, label) VALUES (70, 'b')`);
      } catch (e) {
        return e as any;
      }
    });
    expect(dup.code).toBe('23505');
    expect(sqlstateOf(dup)).toBe('23505');
    expect(dup.constraint).toBe('item_pkey');
    await broker.end(70, false);
    broker.register(71, { principal: user('u-71'), lane: 'data' });
    const denied = await w.db.run(71, 'data', () =>
      sqlstate(() =>
        w.db.current().query(`CREATE TABLE "${SCHEMA}".nope (id int)`),
      ),
    );
    expect(denied).toBe('42501');
    await broker.end(71, false);
    await stop();
  });

  it('a cause keeps its SQLSTATE through the structured clone', () => {
    const inner = Object.assign(new Error('violates'), {
      code: '23505',
      constraint: 'item_pkey',
      detail: 'Key (id)=(1) exists.',
    });
    const outer = Object.assign(new Error('insert failed'), { cause: inner });
    const cloned = structuredClone(packError(outer));
    const rebuilt = rebuildError(class extends Error {} as any, cloned) as any;
    expect(rebuilt.message).toBe('insert failed');
    expect(rebuilt.cause.code).toBe('23505');
    expect(rebuilt.cause.constraint).toBe('item_pkey');
    expect(sqlstateOf(rebuilt)).toBe('23505');
  });
});
