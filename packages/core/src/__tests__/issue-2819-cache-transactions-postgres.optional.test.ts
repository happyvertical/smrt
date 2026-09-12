/** Real PostgreSQL executor/snapshot isolation for collection singleflight. */
import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SmrtCollection } from '../collection.js';
import {
  resetCollectionCache,
  resolveDbCacheKey,
} from '../collection-cache.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { ensureSystemTables } from '../system/bootstrap.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2819_tx_rows';

@smrt({ tableName: 'issue_2819_tx_rows', cache: { ttl: 60_000 } })
class Issue2819TxRow extends SmrtObject {
  name: string = '';
}

class Issue2819TxRows extends SmrtCollection<Issue2819TxRow> {
  static readonly _itemClass = Issue2819TxRow;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dataSelect(sql: string) {
  return /^SELECT/i.test(sql.trim()) && sql.includes(TABLE);
}

/** Delay a real adapter result/error, never synthesize its rows or failure. */
function holdFirstRead(db: DatabaseInterface) {
  const entered = deferred();
  const released = deferred();
  const query = db.query.bind(db);
  let first = true;
  const spy = vi
    .spyOn(db, 'query')
    .mockImplementation(async (sql, ...params) => {
      if (!first || !dataSelect(sql)) return query(sql, ...params);
      first = false;
      try {
        const result = await query(sql, ...params);
        entered.resolve();
        await released.promise;
        return result;
      } catch (error) {
        entered.resolve();
        await released.promise;
        throw error;
      }
    });
  return { entered: entered.promise, release: released.resolve, spy };
}

function read(rows: Issue2819TxRows) {
  return rows.list({ select: ['name'], orderBy: 'id ASC' });
}

function selects(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter(
    ([sql]) => typeof sql === 'string' && dataSelect(sql),
  ).length;
}

describe.skipIf(!pgUrl)(
  'collection cache transaction isolation on PostgreSQL (#2819)',
  () => {
    let db: DatabaseInterface;
    let pooled: Issue2819TxRows;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `cache-tx-${randomUUID()}`,
      });
      await ensureSystemTables(db, 'postgres');
      await db.query(`DROP TABLE IF EXISTS ${TABLE}`);
      const registration = ObjectRegistry.getClassByConstructor(Issue2819TxRow);
      const name = registration?.qualifiedName ?? Issue2819TxRow.name;
      const ddl = ObjectRegistry.getSchemaDDL(name, 'postgres');
      if (!ddl) throw new Error('Missing transaction-cache fixture DDL');
      await db.query(ddl);
      const schema = ObjectRegistry.getSchema(name);
      if (!schema) throw new Error('Missing transaction-cache fixture schema');
      for (const index of getDDLStrategy('postgres').generateIndexes(schema)) {
        await db.query(index);
      }
      pooled = await Issue2819TxRows.create({ db });
    }, 60_000);

    beforeEach(async () => {
      vi.restoreAllMocks();
      resetCollectionCache();
      await db.query(`DELETE FROM ${TABLE}`);
      await pooled.create({ name: 'committed' });
      resetCollectionCache();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      resetCollectionCache();
      try {
        await db?.query(`DROP TABLE IF EXISTS ${TABLE}`);
      } finally {
        await db?.close?.();
      }
    });

    async function withReaders(
      run: (
        leader: DatabaseInterface,
        peer: DatabaseInterface,
      ) => Promise<void>,
    ) {
      const peer = await db.beginTransaction?.();
      const rollback = new Error('rollback transaction-cache fixture');
      try {
        await peer.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await peer.query(`SELECT name FROM ${TABLE}`); // establish peer snapshot
        try {
          await db.transaction?.(async (leader) => {
            // Callback and manual handles have the same URL but distinct public
            // executor identities. No driver/private transaction fields are used.
            expect(leader === db || leader === peer || peer === db).toBe(false);
            expect(resolveDbCacheKey(leader) === resolveDbCacheKey(db)).toBe(
              true,
            );
            expect(resolveDbCacheKey(peer) === resolveDbCacheKey(db)).toBe(
              true,
            );
            await run(leader, peer);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      } finally {
        await peer.rollback();
      }
    }

    it('keeps uncommitted rows out of concurrent and completed peer reads', async () => {
      await withReaders(async (leader, peer) => {
        const leaderRows = await Issue2819TxRows.create({ db: leader });
        const peerRows = await Issue2819TxRows.create({ db: peer });
        await leader.query(`UPDATE ${TABLE} SET name = 'uncommitted'`);
        const held = holdFirstRead(leader);
        const poolSpy = vi.spyOn(db, 'query');
        const peerSpy = vi.spyOn(peer, 'query');
        const leading = read(leaderRows);
        const pending: Promise<unknown>[] = [leading];
        try {
          await held.entered;
          const fromPool = read(pooled);
          const fromPeer = read(peerRows);
          pending.push(fromPool, fromPeer);
          // On the broken implementation peers join the held flight instead of
          // issuing SQL. Release even then so the actual leaked rows are asserted.
          const independent = await vi
            .waitFor(
              () => {
                expect(selects(poolSpy)).toBe(1);
                expect(selects(peerSpy)).toBe(1);
              },
              { timeout: 1_000 },
            )
            .then(
              () => true,
              () => false,
            );
          // Complete peer cache publication before releasing the leader.
          if (independent) await Promise.all([fromPool, fromPeer]);
          held.release();
          expect(await leading).toEqual([{ name: 'uncommitted' }]);
          expect(await fromPool).toEqual([{ name: 'committed' }]);
          expect(await fromPeer).toEqual([{ name: 'committed' }]);
          expect(independent).toBe(true);
          // The transaction's completed cache publication must not replace the
          // pool cache or the other transaction's repeatable-read snapshot.
          expect(await read(pooled)).toEqual([{ name: 'committed' }]);
          expect(await read(peerRows)).toEqual([{ name: 'committed' }]);
        } finally {
          held.release();
          await Promise.allSettled(pending);
        }
      });
      expect(await read(pooled)).toEqual([{ name: 'committed' }]);
    });

    it('does not share an aborted transaction error with healthy executors', async () => {
      await withReaders(async (leader, peer) => {
        const leaderRows = await Issue2819TxRows.create({ db: leader });
        const peerRows = await Issue2819TxRows.create({ db: peer });
        await expect(leader.query('SELECT 1 / 0')).rejects.toThrow();
        const held = holdFirstRead(leader);
        const poolSpy = vi.spyOn(db, 'query');
        const peerSpy = vi.spyOn(peer, 'query');
        const leading = read(leaderRows).then(
          () => null,
          (error: unknown) => error,
        );
        const pending: Promise<unknown>[] = [leading];
        try {
          await held.entered;
          const fromPool = read(pooled).then(
            (rows) => ({ rows }),
            (error) => ({ error }),
          );
          const fromPeer = read(peerRows).then(
            (rows) => ({ rows }),
            (error) => ({ error }),
          );
          pending.push(fromPool, fromPeer);
          const independent = await vi
            .waitFor(
              () => {
                expect(selects(poolSpy)).toBe(1);
                expect(selects(peerSpy)).toBe(1);
              },
              { timeout: 1_000 },
            )
            .then(
              () => true,
              () => false,
            );
          // Complete peer cache publication before releasing the leader.
          if (independent) await Promise.all([fromPool, fromPeer]);
          held.release();
          expect(await leading).toBeInstanceOf(Error);
          expect(await fromPool).toEqual({ rows: [{ name: 'committed' }] });
          expect(await fromPeer).toEqual({ rows: [{ name: 'committed' }] });
          expect(independent).toBe(true);
          expect(await read(pooled)).toEqual([{ name: 'committed' }]);
        } finally {
          held.release();
          await Promise.allSettled(pending);
        }
      });
    });

    it('still coalesces one actual handle and returns independent row copies', async () => {
      const held = holdFirstRead(db);
      const pending = Array.from({ length: 20 }, () => read(pooled));
      try {
        await held.entered;
        expect(selects(held.spy)).toBe(1);
        held.release();
        const results = await Promise.all(pending);
        expect(selects(held.spy)).toBe(1);
        results[0][0].name = 'caller mutation';
        expect(
          results.slice(1).every((rows) => rows[0].name === 'committed'),
        ).toBe(true);
      } finally {
        held.release();
        await Promise.allSettled(pending);
      }
    });

    it('preserves a repeatable-read snapshot after a fresh pool cache fill', async () => {
      const peer = await db.beginTransaction?.();
      try {
        await peer.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const peerRows = await Issue2819TxRows.create({ db: peer });
        expect(await read(peerRows)).toEqual([{ name: 'committed' }]);
        // The autocommitted update invalidates both handles' entries. The pool
        // sees its new value; the peer must still query its older MVCC snapshot.
        await pooled.query(`UPDATE ${TABLE} SET name = 'newly committed'`);
        expect(await read(pooled)).toEqual([{ name: 'newly committed' }]);
        expect(await read(peerRows)).toEqual([{ name: 'committed' }]);
      } finally {
        await peer.rollback();
      }
    });

    it('invalidates completed entries across distinct handles of the same URL', async () => {
      const other = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `cache-peer-${randomUUID()}`,
      });
      try {
        expect(other === db).toBe(false);
        const otherRows = await Issue2819TxRows.create({ db: other });
        expect(await read(pooled)).toEqual([{ name: 'committed' }]);
        expect(await read(otherRows)).toEqual([{ name: 'committed' }]);
        await pooled.query(`UPDATE ${TABLE} SET name = 'changed'`);
        expect(await read(pooled)).toEqual([{ name: 'changed' }]);
        expect(await read(otherRows)).toEqual([{ name: 'changed' }]);
      } finally {
        await other.close?.();
      }
    });
  },
);
