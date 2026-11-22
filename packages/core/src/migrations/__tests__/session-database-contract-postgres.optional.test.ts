/**
 * What the migration lock relies on from `@happyvertical/sql`'s pinned
 * session database (#5435, sdk#1574), pinned against real PostgreSQL:
 * one backend for every member, queued concurrent calls, a root call
 * waiting behind an open transaction and refused from inside it, a COMMIT of
 * an aborted transaction rejecting, `destroy()` returning at once with a
 * statement in flight, and the connection-affinity claim on every handle.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPgSuite,
  createStallProxy,
  gate,
  type PgSuite,
  pgUrl,
  until,
} from './pg-lock-harness.js';

const AFFINITY = Symbol.for('@happyvertical/sql/connection-affinity');
const claimOf = (handle: object) =>
  (handle as Record<symbol, { kind: string; handle: object } | undefined>)[
    AFFINITY
  ];
const pid = async (db: { query: DatabaseInterface['query'] }) =>
  Number((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);

describe.skipIf(!pgUrl)('pinned session database contract', () => {
  let suite: PgSuite;
  let db: DatabaseInterface;
  beforeAll(async () => {
    suite = await createPgSuite('smrt_sessdb');
    db = await suite.pool();
    await db.query('CREATE TABLE sessdb_t (id int PRIMARY KEY)');
  });
  afterAll(async () => {
    await suite?.close();
  });

  it('runs query, transactions and introspection on one backend', async () => {
    const session = await db.acquireSession!();
    try {
      const d = session.database!();
      const seen = new Set<number>([await pid(d)]);
      await d.transaction!(async (tx) => {
        seen.add(await pid(tx));
      });
      await d.getTableSchema!('sessdb_t');
      seen.add(await pid(d));
      expect(seen.size).toBe(1);
    } finally {
      await session.release();
    }
  });

  it('answers eight concurrent queries', async () => {
    const session = await db.acquireSession!();
    try {
      const d = session.database!();
      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, i) => d.query(`SELECT ${i} AS n`)),
      );
      expect(answers.map((a) => Number(a.rows[0].n))).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7,
      ]);
    } finally {
      await session.release();
    }
  });

  it('makes a root call from outside an open transaction wait for it, and refuses one from inside', async () => {
    const session = await db.acquireSession!();
    try {
      const d = session.database!();
      const hold = gate();
      let outsideDone = false;
      const transaction = d.transaction!(async (tx) => {
        await tx.query('SELECT 1');
        // From inside the callback, the root handle is refused at once.
        await expect(d.query('SELECT 2')).rejects.toThrow();
        await hold.promise;
      });
      await until(async () => true, 50);
      const outside = d.query('SELECT 3').then(() => {
        outsideDone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(outsideDone).toBe(false);
      hold.open();
      await transaction;
      await outside;
      expect(outsideDone).toBe(true);
    } finally {
      await session.release();
    }
  });

  it('rejects the commit of a transaction whose statement failed and was swallowed', async () => {
    const session = await db.acquireSession!();
    try {
      const d = session.database!();
      await expect(
        d.transaction!(async (tx) => {
          await tx.query('INSERT INTO sessdb_t VALUES (1)');
          await tx.query('SELECT * FROM no_such_table').catch(() => {});
          return 'returned';
        }),
      ).rejects.toThrow();
      const { rows } = await d.query('SELECT count(*)::int AS n FROM sessdb_t');
      expect(rows[0].n).toBe(0);
    } finally {
      await session.release();
    }
  });

  it('destroys a session at once while a statement is in flight, and its backend goes away', async () => {
    const proxy = await createStallProxy(suite.url);
    try {
      const proxied = await suite.pool({ url: proxy.url });
      const session = await proxied.acquireSession!();
      const backend = await pid(session.database!());
      proxy.stall();
      const inFlight = session.database!()
        .query('SELECT 1')
        .catch(() => 'rejected');
      const started = Date.now();
      session.destroy!();
      expect(Date.now() - started).toBeLessThan(100);
      expect(await inFlight).toBe('rejected');
      await until(
        async () =>
          !(await suite.running(/./)).includes(backend) &&
          !(
            await suite.sql(
              `SELECT 1 FROM pg_stat_activity WHERE pid = ${backend}`,
            )
          ).length,
        10_000,
        'the destroyed backend to exit',
      );
    } finally {
      await proxy.close();
    }
  });

  it('claims affinity on the pool, the session database and transactions, and a spread copy carries none', async () => {
    const expectClaim = (handle: object, kind: string) => {
      const claim = claimOf(handle);
      expect(claim?.kind).toBe(kind);
      expect(claim?.handle === handle).toBe(true);
    };
    expectClaim(db, 'pool');
    const session = await db.acquireSession!();
    try {
      const d = session.database!();
      expectClaim(d, 'session');
      await d.transaction!(async (tx) => {
        expectClaim(tx, 'transaction');
        expect(claimOf({ ...tx })).toBeUndefined();
      });
    } finally {
      await session.release();
    }
    await db.transaction!(async (tx) => {
      expectClaim(tx, 'transaction');
      const copy = { ...tx };
      expect(claimOf(copy)?.handle === copy).toBe(false);
    });
  });
});
