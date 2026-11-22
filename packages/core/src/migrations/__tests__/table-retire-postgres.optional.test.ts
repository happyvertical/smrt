/**
 * The retire step on a real PostgreSQL server (#5005). Counterpart of
 * table-retire.test.ts, which runs the same scenarios in process on SQLite,
 * DuckDB and PGlite. No external service is started: set
 * SMRT_TEST_POSTGRES_URL (and SMRT_TEST_POSTGRES_ADMIN_URL when that role
 * cannot create databases) to run it. Each run migrates a database of its
 * own and drops it afterwards.
 *
 * What only a server proves: a failed DROP rolls back the rest of its batch;
 * materialized views and PL/pgSQL trigger functions are named; a concurrent
 * writer cannot get a row in between the in-batch count and the drop; the
 * drop stays in the atomic part in concurrent-index mode; two runs on
 * separate connections both end cleanly; and a non-public search_path reads,
 * counts and drops the public table.
 */
import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { dropScratchDatabase } from '../../__tests__/fixtures/postgres-scratch-database.js';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { type RetiredTable, registerRetiredTables } from '../retired-tables.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const adminUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL;
const PKG = '@retire5005/pg';

const retired = (
  table: string,
  extra: Partial<RetiredTable> = {},
): RetiredTable => ({
  table,
  lastOwner: `${PKG}:Gone`,
  since: '1.0.0',
  reason: 'Moved onto the order.',
  rows: 'discard',
  definitions: [
    {
      release: '0.9.0',
      columns: { id: { type: 'TEXT' }, v: { type: 'TEXT' } },
    },
  ],
  packageName: PKG,
  ...extra,
});

/**
 * Calls `after` once, right after the first query whose SQL matches, on the
 * handle and inside every transaction it opens.
 */
function hookAfter(
  db: DatabaseInterface,
  matches: (sql: string) => boolean,
  after: () => Promise<void>,
): DatabaseInterface & { fired: () => boolean; dropped: () => string[] } {
  const state = { fired: false, dropped: [] as string[] };
  // The migration lock only locks handles whose maker claims their
  // connection (#5435). This wrapper forwards every member to the handle it
  // wraps, so it claims what that handle claims, for itself; and it wraps
  // the pinned session database the lock runs the migration on.
  const AFFINITY = Symbol.for('@happyvertical/sql/connection-affinity');
  // (A Proxy cannot: the adapter's claim is a non-configurable property, so
  // a proxy must report the target's claim, which names the target.)
  const wrap = (handle: DatabaseInterface): DatabaseInterface => {
    const target = handle as unknown as Record<string | symbol, any>;
    const wrapper: Record<string | symbol, unknown> = {
      ...target,
      fired: () => state.fired,
      dropped: () => [...state.dropped],
      query: async (sql: string, ...args: unknown[]) => {
        if (/^\s*DROP TABLE/i.test(String(sql)))
          state.dropped.push(String(sql).trim());
        const result = await target.query(sql, ...args);
        if (!state.fired && matches(sql)) {
          state.fired = true;
          await after();
        }
        return result;
      },
    };
    if (typeof target.execute === 'function')
      wrapper.execute = (sql: unknown, ...args: unknown[]) => {
        if (/^\s*DROP TABLE/i.test(String(sql)))
          state.dropped.push(String(sql).trim());
        return target.execute(sql, ...args);
      };
    if (typeof target.transaction === 'function')
      wrapper.transaction = <T>(work: (tx: DatabaseInterface) => Promise<T>) =>
        target.transaction((tx: DatabaseInterface) => work(wrap(tx)));
    if (typeof target.acquireSession === 'function')
      wrapper.acquireSession = async () => {
        const session = await target.acquireSession();
        const inner = session.database?.();
        const database = inner ? wrap(inner) : undefined;
        return {
          query: (sql: string, ...args: unknown[]) =>
            session.query(sql, ...args),
          isActive: () => session.isActive(),
          release: () => session.release(),
          ...(session.destroy ? { destroy: () => session.destroy() } : {}),
          ...(database ? { database: () => database } : {}),
        };
      };
    const claim = target[AFFINITY] as { kind: string } | undefined;
    if (claim)
      Object.defineProperty(wrapper, AFFINITY, {
        value: Object.freeze({ kind: claim.kind, handle: wrapper }),
      });
    return wrapper as unknown as DatabaseInterface;
  };
  return wrap(db) as DatabaseInterface & {
    fired: () => boolean;
    dropped: () => string[];
  };
}

/** The SQLSTATE of a PostgreSQL error, through any adapter wrapping. */
function pgErrorCode(error: unknown): string | undefined {
  for (let at = error, depth = 0; at && depth < 5; depth++) {
    const code = (at as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    at = (at as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!pgUrl)('retire step on real PostgreSQL (#5005)', () => {
  let admin: DatabaseInterface;
  let databaseName: string;
  let url: string;
  let db: DatabaseInterface;
  let restore: () => void;
  const handles: DatabaseInterface[] = [];
  let runs = 0;

  const connect = async () => {
    const handle = await getDatabase({
      type: 'postgres',
      url,
      dbid: `retire5005-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);
    handles.push(handle);
    return handle;
  };
  const migrate = (
    on: DatabaseInterface,
    extra: Record<string, unknown> = {},
  ) =>
    migrateSmrtSchemas({
      db: on,
      packageName: '@retire5005/app',
      name: `retire_pg_${++runs}`,
      engineHint: 'postgres',
      atomic: true,
      postgresSafe: false,
      useConcurrentIndexes: false,
      ...extra,
    });
  const exists = async (table: string, schema = 'public') =>
    (
      await db.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      )
    ).rows.length > 0;
  const make = async (table: string, rows = 0) => {
    await db.query(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY, v TEXT)`);
    for (let i = 0; i < rows; i++)
      await db.query(`INSERT INTO "${table}" VALUES ('${i}', 'x')`);
  };
  const registerFresh = (tableName: string) => {
    class Fresh extends SmrtObject {
      code = '';
    }
    field({ type: 'text', unique: true })(Fresh.prototype, 'code');
    ObjectRegistry.register(Fresh, {
      packageName: '@retire5005/other',
      tableName,
    });
  };

  beforeAll(async () => {
    admin = await getDatabase({ type: 'postgres', url: adminUrl as string });
    databaseName = `smrt_r5005_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const parsed = new URL(pgUrl as string);
    const owner = `"${decodeURIComponent(parsed.username).replace(/"/g, '""')}"`;
    await admin.query(`CREATE DATABASE ${databaseName} OWNER ${owner}`);
    parsed.pathname = `/${databaseName}`;
    url = String(parsed);
    db = await connect();
  });
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore?.());
  afterAll(async () => {
    for (const handle of handles) await handle.close?.();
    if (databaseName) await dropScratchDatabase(admin, databaseName);
    await admin?.close?.();
  });

  it('drops a declared table with its rows, under the public schema name', async () => {
    await make('r5005_pg_rows', 2);
    registerRetiredTables(PKG, [retired('r5005_pg_rows')]);
    const result = await migrate(db);
    expect(result).toMatchObject({ refused: false, applied: true });
    expect(result.statements).toEqual([
      'DROP TABLE IF EXISTS "public"."r5005_pg_rows"',
    ]);
    expect(await exists('r5005_pg_rows')).toBe(false);
  });

  it('a failed DROP rolls back every other change of its batch', async () => {
    registerFresh('r5005_pg_fresh_a');
    await make('r5005_pg_dropfail', 0);
    registerRetiredTables(PKG, [retired('r5005_pg_dropfail')]);
    // A dependent appears after the plan's last dependents read (the
    // function-body scan follows the row count and the catalog read), so
    // the plan drops and PostgreSQL refuses the DROP.
    const hooked = hookAfter(
      db,
      (sql) => /p\.prosrc AS src FROM pg_proc/.test(sql),
      async () => {
        await db.query(
          'CREATE VIEW "r5005_pg_late_view" AS SELECT id FROM "r5005_pg_dropfail"',
        );
      },
    );
    // PostgreSQL's own refusal of the DROP (dependent_objects_still_exist,
    // 2BP01), not the plan's: a refusing plan resolves with `refused` and
    // never issues the DROP.
    const failure = await migrate(hooked).then(
      (result) => result,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(hooked.fired()).toBe(true);
    expect(hooked.dropped()).toEqual([
      'DROP TABLE IF EXISTS "public"."r5005_pg_dropfail"',
    ]);
    expect(pgErrorCode(failure)).toBe('2BP01');
    expect(String((failure as Error).message)).toMatch(
      /cannot drop table "?(public\.)?r5005_pg_dropfail"? because other objects depend on it/,
    );
    expect(await exists('r5005_pg_dropfail')).toBe(true);
    expect(await exists('r5005_pg_fresh_a')).toBe(false);
    await db.query('DROP VIEW "r5005_pg_late_view"');
  });

  it('names a materialized view and a PL/pgSQL trigger function that depend on the table', async () => {
    await make('r5005_pg_parent', 0);
    await db.query(
      'CREATE MATERIALIZED VIEW "r5005_pg_mat" AS SELECT id FROM "r5005_pg_parent"',
    );
    await db.query('CREATE TABLE "r5005_pg_audited" (id TEXT PRIMARY KEY)');
    await db.query(
      `CREATE FUNCTION "r5005_pg_fn"() RETURNS trigger AS $$ BEGIN INSERT INTO r5005_pg_parent(id) VALUES (NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await db.query(
      'CREATE TRIGGER "r5005_pg_trg" AFTER INSERT ON "r5005_pg_audited" FOR EACH ROW EXECUTE FUNCTION "r5005_pg_fn"()',
    );
    registerRetiredTables(PKG, [retired('r5005_pg_parent')]);
    const result = await migrate(db);
    expect(result.refused).toBe(true);
    const messages = result.stops.map((stop) => stop.message).join('\n');
    expect(messages).toContain('materialized view r5005_pg_mat');
    expect(messages).toContain('trigger r5005_pg_trg on r5005_pg_audited');
    expect(new Set(result.stops.map((stop) => stop.kind))).toEqual(
      new Set(['table.retire-dependent']),
    );
    expect(await exists('r5005_pg_parent')).toBe(true);
  });

  it('a concurrent writer cannot get a row in between the count and the drop', async () => {
    await make('r5005_pg_locked', 0);
    registerRetiredTables(PKG, [
      retired('r5005_pg_locked', { rows: undefined }),
    ]);
    const writer = await connect();
    let writerError: unknown;
    // Once the batch holds its lock, a second connection tries to write.
    const hooked = hookAfter(
      db,
      (sql) => sql.includes('LOCK TABLE "public"."r5005_pg_locked"'),
      async () => {
        try {
          await writer.transaction?.(async (tx) => {
            await tx.query(`SET LOCAL lock_timeout = '300ms'`);
            await tx.query(`INSERT INTO r5005_pg_locked VALUES ('late', 'x')`);
          });
        } catch (error) {
          writerError = error;
        }
      },
    );
    const result = await migrate(hooked);
    expect(hooked.fired()).toBe(true);
    expect(String(writerError)).toMatch(/lock timeout|canceling statement/i);
    expect(result).toMatchObject({ refused: false, applied: true });
    expect(await exists('r5005_pg_locked')).toBe(false);
  });

  it('two migrate runs on separate connections both end cleanly: the second finds the table gone (T2)', async () => {
    await make('r5005_pg_twice', 0);
    registerRetiredTables(PKG, [
      retired('r5005_pg_twice', { rows: undefined }),
    ]);
    const other = await connect();
    const [first, second] = await Promise.all([migrate(db), migrate(other)]);
    for (const result of [first, second]) {
      expect(result.refused).toBe(false);
      expect(result.stops).toEqual([]);
    }
    expect(await exists('r5005_pg_twice')).toBe(false);
  });

  it('rows written after the plan stop the run, in concurrent-index mode too: the drop is in the atomic part', async () => {
    registerFresh('r5005_pg_fresh_b');
    await make('r5005_pg_safe', 0);
    registerRetiredTables(PKG, [retired('r5005_pg_safe', { rows: undefined })]);
    const hooked = hookAfter(
      db,
      (sql) =>
        /COUNT\(\*\) AS n FROM/.test(sql) && sql.includes('r5005_pg_safe'),
      async () => {
        await db.query(`INSERT INTO r5005_pg_safe VALUES ('late', 'x')`);
      },
    );
    const result = await migrate(hooked, {
      postgresSafe: true,
      useConcurrentIndexes: true,
    });
    expect(hooked.fired()).toBe(true);
    expect(result.refused).toBe(true);
    expect(result.stops.map((stop) => stop.kind)).toEqual([
      'table.retire-rows',
    ]);
    expect(await exists('r5005_pg_safe')).toBe(true);
    // The table (and so its concurrent index) of the same run never landed.
    expect(await exists('r5005_pg_fresh_b')).toBe(false);
  });

  it('reads, counts and drops the public table under a non-public search_path', async () => {
    await make('r5005_pg_sp', 0);
    await db.query('CREATE SCHEMA IF NOT EXISTS "r5005_other"');
    await db.query(
      `CREATE TABLE "r5005_other"."r5005_pg_sp" (id TEXT PRIMARY KEY, v TEXT)`,
    );
    await db.query(
      `INSERT INTO "r5005_other"."r5005_pg_sp" VALUES ('keep', 'x')`,
    );
    registerRetiredTables(PKG, [retired('r5005_pg_sp', { rows: undefined })]);
    const pinned = await connect();
    // Every connection of this handle starts with the other schema first.
    await pinned.query(
      `ALTER DATABASE ${databaseName} SET search_path TO "r5005_other", public`,
    );
    const scoped = await connect();
    try {
      const path = await scoped.query('SHOW search_path');
      expect(String(Object.values(path.rows[0])[0])).toContain('r5005_other');
      const result = await migrate(scoped);
      expect(result).toMatchObject({ refused: false, applied: true });
      expect(result.statements).toContain(
        'DROP TABLE IF EXISTS "public"."r5005_pg_sp"',
      );
    } finally {
      await pinned.query(`ALTER DATABASE ${databaseName} RESET search_path`);
    }
    expect(await exists('r5005_pg_sp')).toBe(false);
    expect(await exists('r5005_pg_sp', 'r5005_other')).toBe(true);
  });
});
