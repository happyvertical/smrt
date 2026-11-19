import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBackfillOnceInTransaction } from '../backfill-once.js';
import { BackfillTracker } from '../backfill-tracker.js';

/**
 * A marker written after the work is only as good as the work is repeatable.
 * `runBackfillOnceInTransaction` makes the work and the marker one transaction, so a
 * backfill that must not be applied twice cannot be.
 */
describe('runBackfillOnceInTransaction', () => {
  let db: DatabaseInterface;
  let tracker: BackfillTracker;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new BackfillTracker({ db });
    await db.query('CREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER)');
    await db.query("INSERT INTO counters VALUES ('balance', 10)");
  });
  afterEach(async () => {
    await db.close?.();
  });

  const balance = async () =>
    Number(
      (await db.query("SELECT n FROM counters WHERE name = 'balance'")).rows[0]
        .n,
    );
  /** Not safe to repeat: every run multiplies again. */
  const timesTen = (unit: DatabaseInterface) =>
    unit.query("UPDATE counters SET n = n * 10 WHERE name = 'balance'");

  it('runs the work once, with the handle of the transaction that records the marker', async () => {
    const first = await runBackfillOnceInTransaction(
      db,
      'times-ten',
      async (unit) => {
        expect(unit).not.toBe(db);
        await timesTen(unit);
        return 'scaled';
      },
      { description: 'multiply once', packageName: '@example/app' },
    );
    expect(first).toEqual({ ran: true, result: 'scaled' });
    expect(await balance()).toBe(100);
    expect(await tracker.listApplied()).toEqual([
      expect.objectContaining({
        name: 'times-ten',
        description: 'multiply once',
        packageName: '@example/app',
      }),
    ]);

    const second = await runBackfillOnceInTransaction(
      db,
      'times-ten',
      timesTen,
    );
    expect(second).toEqual({ ran: false, result: null });
    expect(await balance()).toBe(100);
  });

  it('undoes the work when it fails part-way, so the rerun applies it exactly once', async () => {
    await expect(
      runBackfillOnceInTransaction(db, 'times-ten', async (unit) => {
        await timesTen(unit);
        throw new Error('stopped after the first statement');
      }),
    ).rejects.toThrow('stopped after the first statement');
    expect(await balance()).toBe(10);
    expect(await tracker.isApplied('times-ten')).toBe(false);

    await runBackfillOnceInTransaction(db, 'times-ten', timesTen);
    expect(await balance()).toBe(100);
  });

  it('undoes the work when the marker cannot be recorded', async () => {
    await tracker.initialize();
    await db.query(
      "CREATE TRIGGER no_marker BEFORE INSERT ON _smrt_backfills BEGIN SELECT RAISE(ABORT, 'marker not recorded'); END",
    );

    await expect(
      runBackfillOnceInTransaction(db, 'times-ten', timesTen),
    ).rejects.toThrow(/marker not recorded/);
    expect(await balance()).toBe(10);

    await db.query('DROP TRIGGER no_marker');
    await runBackfillOnceInTransaction(db, 'times-ten', timesTen);
    expect(await balance()).toBe(100);
    expect(await tracker.isApplied('times-ten')).toBe(true);
  });

  it('uses a caller-owned transaction as the unit', async () => {
    await tracker.initialize();
    await expect(
      db.transaction?.(async (tx) => {
        const scoped = tx as unknown as DatabaseInterface;
        BackfillTracker.inheritInitialization(scoped, db);
        const outcome = await runBackfillOnceInTransaction(
          scoped,
          'times-ten',
          async (unit) => {
            // A nested scope of the caller's transaction.
            expect(unit).not.toBe(db);
            await timesTen(unit);
          },
        );
        expect(outcome.ran).toBe(true);
        throw new Error('caller rolls back');
      }),
    ).rejects.toThrow('caller rolls back');

    expect(await balance()).toBe(10);
    expect(await tracker.isApplied('times-ten')).toBe(false);
  });

  it('leaves nothing in a caller-owned transaction that catches the failure and commits', async () => {
    await tracker.initialize();
    await db.transaction?.(async (tx) => {
      const scoped = tx as unknown as DatabaseInterface;
      BackfillTracker.inheritInitialization(scoped, db);
      await expect(
        runBackfillOnceInTransaction(scoped, 'times-ten', async (unit) => {
          await timesTen(unit);
          // A later statement fails with ABORT: SQLite undoes that statement
          // only, not the update before it.
          await unit.query("INSERT INTO counters VALUES ('balance', 1)");
        }),
      ).rejects.toThrow();
      // The caller carries on and commits.
      await scoped.query("INSERT INTO counters VALUES ('other', 1)");
    });

    expect(await balance()).toBe(10);
    expect(await tracker.isApplied('times-ten')).toBe(false);
    expect(
      (await db.query("SELECT n FROM counters WHERE name = 'other'")).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('leaves nothing in a caller-owned transaction that commits after the marker failed', async () => {
    await tracker.initialize();
    await db.query(
      "CREATE TRIGGER no_marker BEFORE INSERT ON _smrt_backfills BEGIN SELECT RAISE(ABORT, 'marker not recorded'); END",
    );
    await db.transaction?.(async (tx) => {
      const scoped = tx as unknown as DatabaseInterface;
      BackfillTracker.inheritInitialization(scoped, db);
      await expect(
        runBackfillOnceInTransaction(scoped, 'times-ten', timesTen),
      ).rejects.toThrow(/marker not recorded/);
    });

    expect(await balance()).toBe(10);
    expect(await tracker.isApplied('times-ten')).toBe(false);
  });

  it('refuses an adapter that cannot make the work and the marker one unit', async () => {
    const withoutTransactions = new Proxy(db, {
      get(target, key, receiver) {
        if (key === 'transaction') return undefined;
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(
      runBackfillOnceInTransaction(withoutTransactions, 'times-ten', timesTen),
    ).rejects.toThrow(/no transaction support/);
    expect(await balance()).toBe(10);
  });

  it('runs as one unit on DuckDB too', async () => {
    const duck = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
    try {
      await duck.query('CREATE TABLE counters (name TEXT, n BIGINT)');
      await duck.query("INSERT INTO counters VALUES ('balance', 10)");
      const duckTracker = new BackfillTracker({ db: duck });
      const read = async () =>
        Number((await duck.query('SELECT n FROM counters')).rows[0].n);

      await expect(
        runBackfillOnceInTransaction(duck, 'times-ten', async (unit) => {
          await unit.query('UPDATE counters SET n = n * 10');
          throw new Error('stopped');
        }),
      ).rejects.toThrow('stopped');
      expect(await read()).toBe(10);
      expect(await duckTracker.isApplied('times-ten')).toBe(false);

      const outcome = await runBackfillOnceInTransaction(
        duck,
        'times-ten',
        (unit) => unit.query('UPDATE counters SET n = n * 10'),
      );
      expect(outcome.ran).toBe(true);
      expect(await read()).toBe(100);
      expect(
        (
          await runBackfillOnceInTransaction(duck, 'times-ten', (unit) =>
            unit.query('UPDATE counters SET n = n * 10'),
          )
        ).ran,
      ).toBe(false);
      expect(await read()).toBe(100);
    } finally {
      await duck.close?.();
    }
  });
});
