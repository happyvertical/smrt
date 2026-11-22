/**
 * Migrate runs on one PostgreSQL database exclude each other, and the writer
 * ends with its lock (#3634, #5435). Pools stand in for processes; each case
 * works in a database of its own. Barriers are observed states
 * (`pg_stat_activity`, `pg_locks`), never sleeps.
 *
 * Fixture tables: `serial_plains` (SerialPlain) and `serial_noteds`
 * (SerialNoted). A "change" is declaring SerialNoted: either a new table
 * (CREATE TABLE plus its indexes, which a default run builds CONCURRENTLY in
 * its index phase) or, after `notedWithoutNote()`, an `ADD COLUMN note`.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { createMigrationDefinition } from '../generator.js';
import { readConfirmedRetirements } from '../migrate-record.js';
import {
  acquireMigrationLock,
  MigrationLockLostError,
  MigrationLockOrderError,
  MigrationLockTimeoutError,
  MigrationRunOverlapError,
  withMigrationLock,
} from '../migration-lock.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import {
  registerRetiredTables,
  snapshotRegisteredRetiredTables,
} from '../retired-tables.js';
import { MigrationTracker } from '../tracker.js';
import {
  createPgSuite,
  createStallProxy,
  gate,
  holdKey,
  type PgSuite,
  pgUrl,
  until,
} from './pg-lock-harness.js';

const PKG = '@lock-serial/fixture';
class SerialPlain extends SmrtObject {
  title = '';
}
class SerialNoted extends SmrtObject {
  title = '';
  note = '';
}
const declarePlain = () =>
  ObjectRegistry.register(SerialPlain, { packageName: PKG });
const declareNoted = () =>
  ObjectRegistry.register(SerialNoted, { packageName: PKG });

let runs = 0;
const migrate = (db: DatabaseInterface, extra: Record<string, unknown> = {}) =>
  migrateSmrtSchemas({
    db,
    packageName: '@lock-serial/app',
    name: `lock_serial_${++runs}`,
    engineHint: 'postgres',
    ...extra,
  });

describe.skipIf(!pgUrl)('migrate runs exclude each other on PostgreSQL', () => {
  let suite: PgSuite;
  let first: DatabaseInterface;
  let second: DatabaseInterface;
  let restore: () => void;
  let restoreRetired: () => void;
  const columns = async (table: string) =>
    (
      await suite.sql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY column_name`,
      )
    ).map((row) => String(row.column_name));
  /** Migrate the plain table, then create `serial_noteds` as it without `note`. */
  const notedWithoutNote = async () => {
    declarePlain();
    await migrate(first);
    await first.query(
      'CREATE TABLE serial_noteds (LIKE serial_plains INCLUDING ALL)',
    );
    declareNoted();
  };

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    restoreRetired = snapshotRegisteredRetiredTables();
    ObjectRegistry.clear();
    suite = await createPgSuite('smrt_serial');
    first = await suite.pool();
    second = await suite.pool();
  });
  afterEach(async () => {
    await suite?.close();
    restoreRetired();
    restore();
  });

  it('a run that waited plans fresh and applies nothing (A1)', async () => {
    declarePlain();
    declareNoted();
    const hold = gate();
    const holder = withMigrationLock(first, async (lock) => {
      await hold.promise;
      return migrate(lock.db);
    });
    await until(async () => (await suite.holderPid()) !== undefined);
    let settled = false;
    const contender = migrate(second, {
      migrationLockTimeout: 30_000,
    }).then((result) => {
      settled = true;
      return result;
    });
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length > 0,
    );
    expect(settled).toBe(false);
    hold.open();
    expect((await holder).applied).toBe(true);
    const result = await contender;
    expect(result.applied).toBe(false);
    expect(result.results).toEqual([]);
  }, 60_000);

  it('a run whose lock backend is terminated at its writing statement commits nothing; the next applies once (A3)', async () => {
    await notedWithoutNote();
    const barrier = await suite.admin.beginTransaction!();
    await barrier.query('LOCK TABLE serial_noteds IN ACCESS SHARE MODE');
    const run = migrate(first, { postgresSafe: false }).catch(
      (error: unknown) => error,
    );
    await until(
      async () =>
        (await suite.waiting(/ALTER TABLE .*serial_noteds.* ADD COLUMN/i))
          .length > 0,
      15_000,
      'the writing statement to block',
    );
    const pid = await suite.holderPid();
    expect(pid).toBeDefined();
    await suite.kill(pid!);
    expect(await run).toBeInstanceOf(MigrationLockLostError);
    await barrier.commit();
    expect(await columns('serial_noteds')).not.toContain('note');
    const again = await migrate(second);
    expect(again.applied).toBe(true);
    expect(await columns('serial_noteds')).toContain('note');
  }, 60_000);

  it('finishes an index-bearing change on a pool of one (A6)', async () => {
    // Pools are opened before the models change (see the note on `pool`).
    const one = await suite.pool({ max: 1 });
    declarePlain();
    await migrate(first);
    declareNoted();
    const result = await migrate(one);
    expect(result).toMatchObject({ applied: true, refused: false });
    expect(result.statements.join('\n')).toMatch(/CREATE (UNIQUE )?INDEX/);
    const valid = await suite.sql(
      `SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid WHERE c.relname = 'serial_noteds' AND NOT i.indisprimary`,
    );
    expect(valid.length).toBeGreaterThan(0);
    expect(valid.every((row) => row.indisvalid === true)).toBe(true);
  }, 60_000);

  it('runs started together on a pool of two all resolve and apply once (A8)', async () => {
    const two = await suite.pool({ max: 2 });
    declarePlain();
    await migrate(first);
    declareNoted();
    const results = await Promise.all([
      migrate(two, { migrationLockTimeout: 30_000 }),
      migrate(two, { migrationLockTimeout: 30_000 }),
      withMigrationLock(two, async (lock) => migrate(lock.db), {
        timeoutMs: 30_000,
      }),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
  }, 60_000);

  it('a holder completes while two runs wait on a pool of three (A10)', async () => {
    const three = await suite.pool({ max: 3 });
    declarePlain();
    await migrate(first);
    declareNoted();
    const hold = gate();
    const holder = withMigrationLock(three, async (lock) => {
      await hold.promise;
      return migrate(lock.db);
    });
    await until(async () => (await suite.holderPid()) !== undefined);
    const waiters = [
      migrate(three, { migrationLockTimeout: 30_000 }),
      migrate(three, { migrationLockTimeout: 30_000 }),
    ];
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length >= 2,
    );
    hold.open();
    expect((await holder).applied).toBe(true);
    const after = await Promise.all(waiters);
    expect(after.every((r) => !r.applied)).toBe(true);
  }, 60_000);

  it('times out in the checkout while every slot is held, and leaves nothing pinned (A21)', async () => {
    const two = await suite.pool({ max: 2 });
    const a = await two.acquireSession!();
    const b = await two.acquireSession!();
    const started = Date.now();
    const failure = await migrate(two, { migrationLockTimeout: 300 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).phase).toBe('checkout');
    expect(Date.now() - started).toBeLessThan(3000);
    await a.release();
    await b.release();
    const lock = await acquireMigrationLock(two, { timeoutMs: 5000 });
    await lock.release();
  }, 60_000);

  it('an onWait that throws surfaces, and the next call acquires at once (A25)', async () => {
    const holder = await holdKey(first);
    const failure = await withMigrationLock(second, async () => {}, {
      onWait: () => {
        throw new Error('onWait failed');
      },
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('onWait failed');
    await holder.release();
    let waited = false;
    await withMigrationLock(second, async () => {}, {
      onWait: () => {
        waited = true;
      },
    });
    expect(waited).toBe(false);
  }, 60_000);

  it('reuses the run for lock.db and its transaction, on one backend (A27)', async () => {
    declarePlain();
    let waited = false;
    await withMigrationLock(
      first,
      async (lock) => {
        const holder = await suite.holderPid();
        await migrate(lock.db);
        await lock.db.transaction!((tx) => migrate(tx));
        expect(await suite.holderPid()).toBe(holder);
      },
      {
        onWait: () => {
          waited = true;
        },
      },
    );
    expect(waited).toBe(false);
  }, 60_000);

  it('two migrates at once on lock.db, or on lock.db and its transaction: one runs, one is refused (A28, A51)', async () => {
    declarePlain();
    await withMigrationLock(first, async (lock) => {
      const outcomes = await Promise.allSettled([
        migrate(lock.db),
        migrate(lock.db),
      ]);
      expect(outcomes.map((o) => o.status).sort()).toEqual([
        'fulfilled',
        'rejected',
      ]);
      const refused = outcomes.find((o) => o.status === 'rejected');
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
        MigrationRunOverlapError,
      );
      const mixed = await Promise.allSettled([
        migrate(lock.db),
        lock.db.transaction!((tx) => migrate(tx)),
      ]);
      expect(
        mixed.filter(
          (o) =>
            o.status === 'rejected' &&
            o.reason instanceof MigrationRunOverlapError,
        ),
      ).toHaveLength(1);
    });
  }, 60_000);

  it('lock.db rejects after the run; an explicit lock grants nothing to the pool handle (A29, A30)', async () => {
    let runDb: DatabaseInterface | undefined;
    await withMigrationLock(first, async (lock) => {
      runDb = lock.db;
    });
    await expect(runDb!.query('SELECT 1')).rejects.toThrow();
    const explicit = await acquireMigrationLock(first);
    const failure = await migrate(first, { migrationLockTimeout: 400 }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).heldByThisProcess).toBe(true);
    await explicit.release();
  }, 60_000);

  it('a migrate on the pool handle inside its own holder is refused at once (A33)', async () => {
    await withMigrationLock(first, async () => {
      await expect(migrate(first)).rejects.toBeInstanceOf(
        MigrationLockOrderError,
      );
    });
  }, 60_000);

  it('the key is released when the work throws (A49)', async () => {
    await expect(
      withMigrationLock(first, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(await suite.holderPid()).toBeUndefined();
  }, 60_000);

  it('a lock connection whose answers stop arriving never strands the key: the release is bounded (A58, release half)', async () => {
    // The deadline half (the proof statement never answering) is timed on
    // the double in migration-lock.test.ts; on a real server the proof
    // follows the try-lock too closely to stall between them.
    const proxy = await createStallProxy(suite.url);
    try {
      const proxied = await suite.pool({ url: proxy.url });
      const hold = gate();
      const run = withMigrationLock(proxied, async () => {
        await hold.promise;
      });
      await until(async () => (await suite.holderPid()) !== undefined);
      proxy.stall();
      const started = Date.now();
      hold.open();
      await run.catch(() => {});
      // The normal release gets no answer; after its grace the session is
      // destroyed without sending anything.
      expect(Date.now() - started).toBeLessThan(8000);
      await until(
        async () => (await suite.holderPid()) === undefined,
        10_000,
        'the destroyed session to free the key',
      );
      const lock = await acquireMigrationLock(second, { timeoutMs: 5000 });
      await lock.release();
    } finally {
      await proxy.close();
    }
  }, 60_000);

  it('a confirmed retirement is on the ledger once even when the run ends in the index phase (A62)', async () => {
    declarePlain();
    await migrate(first);
    await first.query(
      'CREATE TABLE serial_gone (id text PRIMARY KEY, payload text)',
    );
    registerRetiredTables(PKG, [
      {
        table: 'serial_gone',
        lastOwner: `${PKG}:Gone`,
        since: '1.0.0',
        reason: 'moved',
        rows: 'discard',
        definitions: [
          {
            release: '0.9.0',
            columns: { id: { type: 'TEXT' }, v: { type: 'TEXT' } },
          },
        ],
        packageName: PKG,
      },
    ]);
    declareNoted();
    // An older snapshot (REPEATABLE READ keeps it for the transaction):
    // CREATE INDEX CONCURRENTLY waits for it, after the batch and its
    // confirmation committed.
    const writer = await suite.admin.beginTransaction!();
    let run: Promise<unknown> | undefined;
    try {
      await writer.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await writer.query('SELECT txid_current()');
      run = migrate(first, {
        confirmRetireTables: ['serial_gone'],
        postgresSafe: true,
      }).catch((error: unknown) => error);
      await until(
        async () =>
          (await suite.waiting(/CREATE (UNIQUE )?INDEX CONCURRENTLY/i)).length >
          0,
        15_000,
        'the concurrent index build to wait',
      );
      const pid = await suite.holderPid();
      await suite.kill(pid!);
      await run;
    } finally {
      await writer.commit();
      await run;
    }
    const afterKill = await readConfirmedRetirements(first, {
      engineHint: 'postgres',
    });
    expect(afterKill).toHaveLength(1);
    expect(afterKill[0].retirements.map((r) => r.table)).toEqual([
      'serial_gone',
    ]);
    const again = await migrate(second);
    expect(again.refused).toBe(false);
    expect(
      await readConfirmedRetirements(second, { engineHint: 'postgres' }),
    ).toHaveLength(1);
  }, 60_000);

  it('two runs that both record a migration of the same change: unserialized they collide, through migrateSmrtSchemas both end cleanly (#5569)', async () => {
    const statement = (table: string) =>
      `ALTER TABLE "${table}" ADD COLUMN note text`;
    await first.query('CREATE TABLE race_5569 (id int PRIMARY KEY)');
    await new MigrationTracker({
      db: first,
      engineHint: 'postgres',
    }).initialize();

    // Control: two trackers on separate pools, no lock. A barrier holds each
    // run right after it records its migration as running, until the other
    // has done the same (or two seconds pass, should the other be blocked
    // behind it), so both planned before either applied the change.
    const arrived = { count: 0 };
    const bothRecorded = gate();
    const barrier = (db: DatabaseInterface) =>
      wrapAfterRecord(db, async () => {
        if (++arrived.count === 2) bothRecorded.open();
        await Promise.race([
          bothRecorded.promise,
          new Promise((resolve) => setTimeout(resolve, 2000)),
        ]);
      });
    const unlocked = await Promise.allSettled(
      [first, second].map((db, index) =>
        new MigrationTracker({ db: barrier(db), engineHint: 'postgres' })
          .applyAll(
            [
              createMigrationDefinition(
                `race_5569_${index}`,
                [statement('race_5569')],
                [],
                { packageName: PKG, version: '1' },
              ),
            ],
            { atomic: true, postgresSafe: false },
          )
          .then((results) => {
            const failed = results.find((r) => !r.success);
            if (failed) throw failed.error;
            return results;
          }),
      ),
    );
    expect(unlocked.filter((o) => o.status === 'rejected')).toHaveLength(1);

    // With the lock: the same change through two concurrent migrate runs.
    declarePlain();
    await migrate(first);
    await first.query('ALTER TABLE serial_plains DROP COLUMN title');
    const outcomes = await Promise.allSettled([
      migrate(first, { migrationLockTimeout: 30_000 }),
      migrate(second, { migrationLockTimeout: 30_000 }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    const applied = outcomes.map(
      (o) => (o as PromiseFulfilledResult<{ applied: boolean }>).value.applied,
    );
    expect(applied.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await suite.sql(
          "SELECT 1 FROM information_schema.columns WHERE table_name = 'serial_plains' AND column_name = 'title'",
        )
      ).length,
    ).toBe(1);
  }, 60_000);
});

/**
 * A wrapper of `db` (carrying its affinity claim) that calls `after` once,
 * right after its transaction records a migration as running.
 */
function wrapAfterRecord(
  db: DatabaseInterface,
  after: () => Promise<void>,
): DatabaseInterface {
  const AFFINITY = Symbol.for('@happyvertical/sql/connection-affinity');
  let fired = false;
  const wrap = (handle: DatabaseInterface): DatabaseInterface => {
    const source = handle as unknown as Record<string | symbol, any>;
    const wrapper: Record<string | symbol, unknown> = {
      ...source,
      query: async (sql: string, ...args: unknown[]) => {
        const result = await source.query(sql, ...args);
        if (!fired && /INSERT INTO _smrt_schema_migrations/i.test(sql)) {
          fired = true;
          await after();
        }
        return result;
      },
    };
    if (typeof source.transaction === 'function')
      wrapper.transaction = <T>(work: (tx: DatabaseInterface) => Promise<T>) =>
        source.transaction((tx: DatabaseInterface) => work(wrap(tx)));
    const claim = source[AFFINITY] as { kind: string } | undefined;
    if (claim)
      Object.defineProperty(wrapper, AFFINITY, {
        value: Object.freeze({ kind: claim.kind, handle: wrapper }),
      });
    return wrapper as unknown as DatabaseInterface;
  };
  return wrap(db);
}
