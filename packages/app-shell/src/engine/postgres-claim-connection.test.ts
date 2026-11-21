// The two facts the store-in-swap design (#5470) rests on, checked on the kind
// of connection `claimApp` (db/postgres.ts) makes: its own pool, `max: 1`,
// never idle-closed, never cached. `claimApp` hands back only a release, so
// this file opens a connection with the same options and takes the lock with
// the same `tryAppLock`.
//
// 1. The shell's tables (default schema, same role, same search_path) are
//    reachable from that connection, and one transaction there writes a shell
//    table and an app schema's table together, or neither.
// 2. A session advisory lock taken on it is still held while a transaction on
//    the same connection runs, after it commits, after it rolls back, and
//    after a COMMIT the server refuses. A dropped session frees it, and the
//    pool then reconnects silently on a NEW session that does not hold it.
//
// Part of the registered `test:postgres` suite. Both run on an in-process
// PGlite too; what needs a second session (who else can take the lock, a
// terminated session) runs only when `SMRT_TEST_POSTGRES_URL` is set (CI's
// "Registered PostgreSQL Suites" lane).
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGliteClient } from './db/index.ts';
import { releaseAppLock, tryAppLock } from './db/postgres-copy.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;

type Handle = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  transaction<T>(cb: (tx: Handle) => Promise<T>): Promise<T>;
  close?: () => Promise<void>;
};

const suffix = () => Math.random().toString(36).slice(2, 8);

/** The options `claimApp` opens its connection with. */
const claimConnection = async (url: string) =>
  (await getDatabase({
    type: 'postgres',
    url,
    max: 1,
    idleTimeoutMillis: 0,
    cache: false,
  } as any)) as unknown as Handle;

describe.each(backends)('the claim connection (%s)', (backend) => {
  // `shell` stands in for the shell's own database handle; `claim` for the
  // connection a live host claims its app on.
  let shell: Handle;
  let claim: Handle;
  let pglite: PGliteClient | undefined;
  const table = `probe_shell_${suffix()}`;
  const app = `app_probe_${suffix()}`;

  beforeAll(async () => {
    if (backend === 'postgres') {
      shell = (await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
        cache: false,
      } as any)) as unknown as Handle;
      claim = await claimConnection(serverUrl as string);
    } else {
      const { PGlite } = await importPGlite();
      pglite = (await PGlite.create()) as PGliteClient;
      shell = (await getDatabase({
        type: 'pglite',
        client: pglite,
      } as any)) as unknown as Handle;
      // One PGlite is one session: the claim connection is the same instance.
      claim = shell;
    }
    // The shell's table goes where the shell's models put theirs: unqualified.
    await shell.query(
      `CREATE TABLE ${table} (id TEXT PRIMARY KEY, v INTEGER NOT NULL)`,
    );
    await shell.query(`INSERT INTO ${table} (id, v) VALUES ('a', 1)`);
    await shell.query(`CREATE SCHEMA "${app}"`);
    await shell.query(
      `CREATE TABLE "${app}"._app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
  });

  afterAll(async () => {
    await shell.query(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await shell.query(`DROP SCHEMA IF EXISTS "${app}" CASCADE`).catch(() => {});
    if (backend === 'postgres') {
      await claim.close?.().catch(() => {});
      await shell.close?.().catch(() => {});
    } else await pglite?.close();
  });

  const identity = async (h: Handle) =>
    (
      await h.query(
        `SELECT current_database() AS db, current_user AS role, current_schema() AS schema, current_setting('search_path') AS path`,
      )
    ).rows[0];
  const value = async () =>
    Number(
      (await shell.query(`SELECT v FROM ${table} WHERE id = 'a'`)).rows[0].v,
    );
  const meta = async (key: string) =>
    (
      await shell.query(`SELECT value FROM "${app}"._app_meta WHERE key = ?`, [
        key,
      ])
    ).rows.map((r) => r.value);

  it('fact 1: reaches the shell tables unqualified, as the same role and search_path', async () => {
    // Read first: on PGlite the shell handle waits for the claim's transaction.
    const want = await identity(shell);
    expect(await identity(claim)).toEqual(want);
    const seen = await claim.transaction(async (tx) => {
      expect(await identity(tx)).toEqual(want);
      return (
        await tx.query(`SELECT to_regclass(?) IS NOT NULL AS found`, [table])
      ).rows[0].found;
    });
    expect(seen === true || seen === 't').toBe(true);
  });

  it('fact 1: one transaction on it writes a shell table and an app schema table together', async () => {
    const before = await value();
    await claim.transaction(async (tx) => {
      await tx.query(`UPDATE ${table} SET v = v + 1 WHERE id = 'a'`);
      await tx.query(
        `INSERT INTO "${app}"._app_meta (key, value) VALUES ('fence', '1')`,
      );
    });
    expect(await value()).toBe(before + 1);
    expect(await meta('fence')).toEqual(['1']);
    // ...or neither: a failure after both writes leaves both untouched.
    await expect(
      claim.transaction(async (tx) => {
        await tx.query(`UPDATE ${table} SET v = v + 1 WHERE id = 'a'`);
        await tx.query(
          `UPDATE "${app}"._app_meta SET value = '2' WHERE key = 'fence'`,
        );
        throw new Error('stop before commit');
      }),
    ).rejects.toThrow('stop before commit');
    expect(await value()).toBe(before + 1);
    expect(await meta('fence')).toEqual(['1']);
  });

  // The in-transaction proof the design adds runs on both: PGlite is one
  // session, so there it shows only that the session keeps the lock across its
  // own transactions. Who ELSE can take it needs a second session: server only.
  it('fact 2: the session advisory lock outlives every transaction on its connection', async () => {
    const key = `app_claim_${suffix()}`;
    const server = backend === 'postgres';
    const other = server ? await claimConnection(serverUrl as string) : null;
    const pidOf = async (h: Handle) =>
      Number((await h.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    const lockMatch = `locktype = 'advisory' AND granted AND objsubid = 2 AND classid::bigint = (hashtext('smrt-app-shell')::bigint & 4294967295) AND objid::bigint = (hashtext(?)::bigint & 4294967295)`;
    // This session holds it: the check each claim transaction would start with.
    const holdsIt = async (h: Handle) => {
      const v = (
        await h.query(
          `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE ${lockMatch} AND pid = pg_backend_pid()) AS held`,
          [key],
        )
      ).rows[0].held;
      return v === true || v === 't';
    };
    // Who holds it, as another session sees it (server only).
    const holders = async () =>
      (
        await (other as Handle).query(
          `SELECT pid FROM pg_locks WHERE ${lockMatch}`,
          [key],
        )
      ).rows.map((r) => Number(r.pid));
    const refusedToOther = async () => {
      const got = await tryAppLock(other as Handle, key);
      if (got) await releaseAppLock(other as Handle, key);
      return !got;
    };
    try {
      expect(await tryAppLock(claim, key)).toBe(true);
      const pid = await pidOf(claim);
      const seenFromOutside = async () => {
        if (!server) return;
        expect(await holders()).toEqual([pid]);
        expect(await refusedToOther()).toBe(true);
      };
      const stillHeld = async () => {
        expect(await holdsIt(claim)).toBe(true);
        expect(await pidOf(claim)).toBe(pid);
        await seenFromOutside();
      };
      await stillHeld();

      // Inside a transaction: on the same session, which the proof sees.
      await claim.transaction(async (tx) => {
        expect(await pidOf(tx)).toBe(pid);
        expect(await holdsIt(tx)).toBe(true);
        await tx.query(`UPDATE ${table} SET v = v + 1 WHERE id = 'a'`);
        await seenFromOutside();
      });
      // After COMMIT.
      await stillHeld();

      // After ROLLBACK.
      await expect(
        claim.transaction(async (tx) => {
          await tx.query(`UPDATE ${table} SET v = v + 1 WHERE id = 'a'`);
          throw new Error('roll back');
        }),
      ).rejects.toThrow('roll back');
      await stillHeld();

      // After a failed statement (the transaction aborts).
      await expect(
        claim.transaction(async (tx) => {
          await tx.query(`SELECT 1 / 0 AS boom`);
        }),
      ).rejects.toThrow();
      await stillHeld();

      // After a COMMIT the server refuses (a deferred unique check): the
      // transaction is gone, the session and its lock are not.
      const deferred = `probe_deferred_${suffix()}`;
      await shell.query(
        `CREATE TABLE ${deferred} (id INTEGER, CONSTRAINT ${deferred}_u UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)`,
      );
      try {
        await expect(
          claim.transaction(async (tx) => {
            await tx.query(`INSERT INTO ${deferred} (id) VALUES (1), (1)`);
          }),
        ).rejects.toThrow();
        await stillHeld();
        expect(
          Number(
            (await shell.query(`SELECT count(*) AS n FROM ${deferred}`)).rows[0]
              .n,
          ),
        ).toBe(0);
      } finally {
        await shell.query(`DROP TABLE IF EXISTS ${deferred}`);
      }

      if (!server) return;
      // The session ends: the lock is freed, and the pool reconnects on a new
      // session that does NOT hold it. Only the in-transaction proof tells the
      // two apart; a commit on the pool alone proves nothing.
      await (other as Handle).query(`SELECT pg_terminate_backend(?)`, [pid]);
      let freed = false;
      for (let i = 0; i < 50 && !freed; i++) {
        freed = (await holders()).length === 0;
        if (!freed) await new Promise((r) => setTimeout(r, 100));
      }
      expect(freed).toBe(true);
      let fresh: number | null = null;
      for (let i = 0; i < 5 && fresh === null; i++)
        fresh = await pidOf(claim).catch(() => null);
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(pid);
      expect(await claim.transaction(async (tx) => holdsIt(tx))).toBe(false);
    } finally {
      await releaseAppLock(claim, key).catch(() => {});
      await other?.close?.().catch(() => {});
    }
  });
});
