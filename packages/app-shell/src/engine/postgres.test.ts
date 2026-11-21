// PostgreSQL behaviour of the engine (#5186), always on PGlite regardless of
// SMRT_APP_SHELL_DB: tenancy (one schema per app, transaction-local
// search_path, unqualified names), the loud failures, and the schema scope.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGliteClient } from './db/index.ts';
import { PASS_THROUGH, SCOPED_MEMBERS, scopeDatabase } from './db/postgres.ts';
import { AppHost, EngineError, MemoryVersionStore } from './index.ts';
import {
  exportUserApp,
  importUserApp,
  inspectUserApp,
  verifyUserApp,
} from './portable-export.ts';

type Client = PGliteClient;
let pg: Client;
const dirs: string[] = [];
const hosts: AppHost[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'engine-pg-'));
  dirs.push(d);
  return d;
};
const tablesIn = async (schema: string) =>
  (
    await pg.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
      [schema],
    )
  ).rows.map((r: { table_name: string }) => r.table_name);
const open = async (schema: string, dir = tmp()) => {
  const host = await AppHost.open(dir, {
    store: new MemoryVersionStore(),
    database: { kind: 'pglite', schema, client: pg },
  });
  hosts.push(host);
  return host;
};

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  pg = (await PGlite.create()) as Client;
  for (const s of ['app_a', 'app_b']) await pg.exec(`CREATE SCHEMA ${s}`);
});
afterAll(async () => {
  for (const h of hosts) await h.close().catch(() => {});
  await pg.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('one schema per app (tenancy)', () => {
  it('two apps with the same model name never see each other', async () => {
    const a = await open('app_a');
    const b = await open('app_b');
    for (const [host, who] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      await host.execute(
        {
          type: 'defineModel',
          name: 'Note',
          fields: { title: { type: 'text' } },
        },
        { author: 't' },
      );
      await host.create('Note', { title: `only ${who}` });
    }
    // Only A has this model at all.
    await a.execute(
      {
        type: 'defineModel',
        name: 'Secret',
        fields: { code: { type: 'text' } },
      },
      { author: 't' },
    );
    await a.create('Secret', { code: 'a-secret' });

    const titles = async (h: AppHost) =>
      ((await h.list('Note')) as any[]).map((r) => r.title);
    expect(await titles(a)).toEqual(['only a']);
    expect(await titles(b)).toEqual(['only b']);
    // B cannot reach A's table by any engine route.
    await expect(b.list('Secret')).rejects.toBeInstanceOf(EngineError);
    const rest = await b.rest({ method: 'GET', url: '/api/secrets' });
    expect(rest.status).toBe(404);
    expect(
      ((await b.appTools()) as { name: string }[]).some((t) =>
        t.name.includes('secret'),
      ),
    ).toBe(false);
    // The REST list of the shared name is each app's own rows.
    const restNotes = async (h: AppHost) =>
      JSON.stringify((await h.rest({ method: 'GET', url: '/api/notes' })).body);
    expect(await restNotes(a)).toContain('only a');
    expect(await restNotes(a)).not.toContain('only b');
    expect(await restNotes(b)).toContain('only b');
    expect(await restNotes(b)).not.toContain('only a');

    // The data is physically apart, and nothing landed in public.
    const inA = await tablesIn('app_a');
    const inB = await tablesIn('app_b');
    expect(inA).toContain('u_secrets');
    expect(inA).toContain('u_notes');
    expect(inB).toContain('u_notes');
    expect(inB).not.toContain('u_secrets');
    expect(await tablesIn('public')).toEqual([]);
  });

  it('the search_path is transaction-local: nothing sticks to the connection', async () => {
    expect(
      (await pg.query('SHOW search_path')).rows[0].search_path,
    ).not.toContain('app_');
    const db = scopeDatabase(
      await getDatabase({ type: 'pglite', client: pg } as any),
      'app_a',
    );
    await db.query('CREATE TABLE scoped_probe (id TEXT)');
    expect(await tablesIn('app_a')).toContain('scoped_probe');
    expect(await tablesIn('app_b')).not.toContain('scoped_probe');
    // (The vitest setup may make core's system tables in `public` when a test
    // opens a database in this process; the engine's workers never do.)
    expect(await tablesIn('public')).not.toContain('scoped_probe');
    expect(await (db as any).tableExists('scoped_probe')).toBe(true);
    const other = scopeDatabase(
      await getDatabase({ type: 'pglite', client: pg } as any),
      'app_b',
    );
    expect(await (other as any).tableExists('scoped_probe')).toBe(false);
    expect(
      (await pg.query('SHOW search_path')).rows[0].search_path,
    ).not.toContain('app_');
  });

  it("a temporary table left on the session never stands in for the app's own", async () => {
    const raw: any = await getDatabase({ type: 'pglite', client: pg } as any);
    const db: any = scopeDatabase(raw, 'app_a');
    await db.query('CREATE TABLE temp_probe (who TEXT)');
    await db.query(`INSERT INTO temp_probe VALUES ('app')`);
    // One session, reused: an unscoped temporary table of the same name.
    await pg.exec(
      `CREATE TEMP TABLE temp_probe (who TEXT); INSERT INTO pg_temp.temp_probe VALUES ('temp')`,
    );
    try {
      expect(
        (
          await db.query(
            `SELECT n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('temp_probe')`,
          )
        ).rows[0].s,
      ).toBe('app_a');
      expect(
        (await db.query('SELECT who FROM temp_probe')).rows.map(
          (r: { who: string }) => r.who,
        ),
      ).toEqual(['app']);
      expect((await db.query('SELECT current_schema() AS s')).rows[0].s).toBe(
        'app_a',
      );
    } finally {
      await pg.exec('DROP TABLE IF EXISTS pg_temp.temp_probe');
    }
  });

  it('fails closed: no member of the raw handle reaches it unscoped', async () => {
    const raw: any = await getDatabase({ type: 'pglite', client: pg } as any);
    const db: any = scopeDatabase(raw, 'app_a');
    expect(() => db.table('x')).toThrow(/schema-scoped/);
    // Every member of the adapter, own or inherited: a scoped operation, a
    // table-free one, or a plain value. Never a function or object that would
    // run on the default search_path.
    const keys = new Set<string>();
    for (let o = raw; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
      for (const k of Object.getOwnPropertyNames(o)) keys.add(k);
    expect(keys.size).toBeGreaterThan(10);
    const open: string[] = [];
    for (const k of keys) {
      const v = db[k];
      if (typeof v === 'function') {
        if (!SCOPED_MEMBERS.has(k) && !PASS_THROUGH.has(k)) open.push(k);
      } else if (v !== null && typeof v === 'object' && k !== 'client')
        open.push(k);
    }
    expect(open).toEqual([]);
    // Core keys state on `client` and tells the adapter by its `query`/`exec`:
    // the stand-in has those and nothing else, and they run scoped.
    expect(Object.keys(db.client).sort()).toEqual(
      ['constructor', 'exec', 'query'].sort(),
    );
    await db.client.query('CREATE TABLE client_probe (id int)');
    expect(await tablesIn('app_a')).toContain('client_probe');
    expect(await tablesIn('app_b')).not.toContain('client_probe');
    for (const k of [
      'acquireSession',
      'syncSchema',
      'alterTable',
      'vector',
      'reopenOptions',
    ])
      expect(db[k], k).toBeUndefined();
  });
});

describe('no schema, no start', () => {
  it('an app with no schema configured fails loudly and creates nothing in public', async () => {
    const before = await tablesIn('public');
    for (const database of [
      { kind: 'pglite', client: pg },
      { kind: 'pglite', schema: '', client: pg },
      { kind: 'pglite', schema: 'public', client: pg },
      { kind: 'pglite', schema: 'pg_catalog', client: pg },
      { kind: 'pglite', schema: 'App A', client: pg },
    ] as any[]) {
      const err = await AppHost.open(tmp(), {
        store: new MemoryVersionStore(),
        database,
      }).then(
        () => null,
        (e) => e,
      );
      expect(err, JSON.stringify(database.schema)).toBeInstanceOf(EngineError);
      expect((err as EngineError).code).toBe('refused');
    }
    expect(await tablesIn('public')).toEqual(before);
  });

  it('a schema the host never created is refused, not created', async () => {
    const err = await open('app_missing').then(
      () => null,
      (e) => e,
    );
    expect(String(err?.message)).toMatch(/does not exist/);
    expect(
      (
        await pg.query(
          `SELECT 1 FROM pg_namespace WHERE nspname = 'app_missing'`,
        )
      ).rows,
    ).toEqual([]);
  });
});

describe('what needs SQLite stays SQLite', () => {
  it('opening an app on PostgreSQL has nothing to warn about: it has the undo points SQLite has', async () => {
    const host = await open('app_a');
    expect(host.notices).toEqual([]);
    const lite = await AppHost.open(tmp(), {
      store: new MemoryVersionStore(),
      database: { kind: 'sqlite' },
    });
    hosts.push(lite);
    expect(lite.notices).toEqual([]);
  });

  it('portable export and import need the host to name a schema', async () => {
    const database = { kind: 'pglite' as const } as never;
    await expect(
      exportUserApp({ dataDir: tmp(), versions: [], database }),
    ).rejects.toThrow(/needs a schema/);
    await expect(
      importUserApp({ dataDir: tmp(), bundle: {} as never, database }),
    ).rejects.toThrow();
    await expect(inspectUserApp({ dataDir: tmp(), database })).rejects.toThrow(
      /needs a schema/,
    );
    await expect(
      verifyUserApp({ dataDir: tmp(), bundle: {} as never, database }),
    ).rejects.toThrow(/needs a schema/);
  });
});

// A stand-in for the server side of one shared connection: transaction-local
// settings live until the transaction ends (commit or rollback), a statement
// that outlasts `statement_timeout` is cancelled (SQLSTATE 57014). PGlite runs
// in one thread and cannot cancel a statement, so the real server is covered by
// postgres-server.test.ts on the CI lane.
function fakeConnection() {
  const local = new Map<string, string>();
  const log: string[] = [];
  const state = { rollbacks: 0, open: 0 };
  const query = async (sql: string, params: unknown[] = []) => {
    log.push(sql);
    if (sql.includes('set_config')) {
      if (sql.includes("'statement_timeout'"))
        local.set('statement_timeout', String(params[1]));
      return { rows: [] };
    }
    if (sql.includes('pg_sleep')) {
      if (local.has('statement_timeout'))
        throw Object.assign(
          new Error('canceling statement due to statement timeout'),
          { code: '57014' },
        );
      return { rows: [{ slept: true }] };
    }
    if (sql === 'SHOW statement_timeout')
      return {
        rows: [{ statement_timeout: local.get('statement_timeout') ?? '0' }],
      };
    return { rows: [{ one: 1 }] };
  };
  const tx = { query, engine: 'postgres' };
  const handle = {
    engine: 'postgres',
    query: (sql: string, params?: unknown[]) =>
      handle.transaction((t: any) => t.query(sql, params)),
    async transaction<R>(cb: (t: typeof tx) => Promise<R>): Promise<R> {
      state.open++;
      try {
        return await cb(tx);
      } catch (e) {
        state.rollbacks++;
        throw e;
      } finally {
        local.clear(); // the transaction ended: nothing stays on the connection
        state.open--;
      }
    },
    async beginTransaction() {
      state.open++;
      return {
        ...tx,
        commit: async () => {
          local.clear();
          state.open--;
        },
        rollback: async () => {
          state.rollbacks++;
          local.clear();
          state.open--;
        },
      };
    },
  };
  return { handle, local, log, state };
}

describe('per-operation statement timeout (#5192)', () => {
  const CANCELLED = /statement timeout/;

  it('cancels a runaway statement on every path, leaving no setting and no open transaction on the connection', async () => {
    const conn = fakeConnection();
    const limited = scopeDatabase(conn.handle, 'app_a', {
      statementTimeoutMs: 100,
    }) as any;
    await expect(limited.query('SELECT pg_sleep(600)')).rejects.toThrow(
      CANCELLED,
    );
    await expect(
      limited.transaction(async (tx: any) => {
        await tx.query('SELECT pg_sleep(600)');
      }),
    ).rejects.toThrow(CANCELLED);
    const manual = await limited.beginTransaction();
    await expect(manual.query('SELECT pg_sleep(600)')).rejects.toThrow(
      CANCELLED,
    );
    await manual.rollback();
    // Set as the first statement of each transaction, transaction-locally.
    expect(
      conn.log.filter((q) => q.includes("'statement_timeout', ?, true")),
    ).toHaveLength(3);
    // Released: the transactions are over and the setting went with them.
    expect(conn.state.open).toBe(0);
    expect(conn.state.rollbacks).toBe(3);
    expect(conn.local.size).toBe(0);
    // The connection is usable straight after.
    expect((await limited.query('SELECT 1 AS one')).rows[0].one).toBe(1);
  });

  it('does not reach another app on the same connection', async () => {
    const conn = fakeConnection();
    const limited = scopeDatabase(conn.handle, 'app_a', {
      statementTimeoutMs: 100,
    }) as any;
    const other = scopeDatabase(conn.handle, 'app_b') as any;
    await expect(limited.query('SELECT pg_sleep(600)')).rejects.toThrow(
      CANCELLED,
    );
    // The other app's long statement runs to the end, and sees no limit.
    expect((await other.query('SELECT pg_sleep(600)')).rows[0].slept).toBe(
      true,
    );
    expect(
      (await other.query('SHOW statement_timeout')).rows[0].statement_timeout,
    ).toBe('0');
  });

  it('is off when not configured, and refuses nonsense', async () => {
    const conn = fakeConnection();
    const free = scopeDatabase(conn.handle, 'app_a') as any;
    expect((await free.query('SELECT pg_sleep(600)')).rows[0].slept).toBe(true);
    expect(conn.log.some((q) => q.includes('statement_timeout'))).toBe(false);
    for (const bad of [0, -5, 1.5])
      expect(() =>
        scopeDatabase(conn.handle, 'app_a', { statementTimeoutMs: bad }),
      ).toThrow(RangeError);
  });
});
