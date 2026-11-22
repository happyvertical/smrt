/**
 * The migration lock on a caller's transaction, on real PostgreSQL (#5435):
 * one try and no wait, the lock held to the caller's COMMIT, isolation and
 * overlap refusals, refusal of handles without a valid affinity claim, and
 * the order guard inside a borrowed callback.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { withRuntimeSchemaActivation } from '../../activation.js';
import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { ensureSystemTables } from '../../system/bootstrap.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  acquireMigrationLock,
  MigrationLockBusyError,
  MigrationLockIsolationError,
  MigrationLockOrderError,
  MigrationLockUnsupportedError,
  MigrationRunOverlapError,
  withMigrationLock,
} from '../migration-lock.js';
import { rescaleMoneyColumnsToMinorUnits } from '../minor-units.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import {
  createPgSuite,
  gate,
  holdKey,
  type PgSuite,
  pgUrl,
  until,
} from './pg-lock-harness.js';

class LockTxThing extends SmrtObject {
  title = '';
}
field({ type: 'text' })(LockTxThing.prototype, 'title');

let runs = 0;
const migrate = (db: DatabaseInterface, extra: Record<string, unknown> = {}) =>
  migrateSmrtSchemas({
    db,
    packageName: '@lock-tx/app',
    name: `lock_tx_${++runs}`,
    engineHint: 'postgres',
    atomic: true,
    postgresSafe: false,
    useConcurrentIndexes: false,
    ...extra,
  });
const held = async (tx: { query: DatabaseInterface['query'] }) =>
  (
    await tx.query(
      `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 2 AND pid = pg_backend_pid() AND classid = (hashtext('smrt'))::oid AND objid = (hashtext('db:migrate'))::oid) AS held`,
    )
  ).rows[0].held === true;

describe.skipIf(!pgUrl)('migration lock on a caller transaction', () => {
  let suite: PgSuite;
  let db: DatabaseInterface;
  let other: DatabaseInterface;
  let restore: () => void;
  beforeAll(async () => {
    suite = await createPgSuite('smrt_locktx');
    db = await suite.pool();
    other = await suite.pool();
    await ensureSystemTables(db, 'postgres');
  });
  afterAll(async () => {
    await suite?.close();
  });
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  it('holds the lock to the commit; another run waits for it and applies nothing new', async () => {
    ObjectRegistry.register(LockTxThing, {
      packageName: '@lock-tx/fixture',
      tableName: 'lock_tx_things',
    });
    const tx = await db.beginTransaction!();
    await migrate(tx as unknown as DatabaseInterface);
    let waited = false;
    const second = migrate(other, {
      migrationLockTimeout: 20_000,
    }).then((result) => {
      waited = true;
      return result;
    });
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length > 0,
      10_000,
      'the second run to poll the key',
    );
    expect(waited).toBe(false);
    await tx.commit();
    const result = await second;
    expect(result.applied).toBe(false);
  }, 60_000);

  it('refuses at once, without planning, when a session holder has the key', async () => {
    const holder = await holdKey(other);
    try {
      const started = Date.now();
      const tx = await db.beginTransaction!();
      await expect(
        migrate(tx as unknown as DatabaseInterface),
      ).rejects.toBeInstanceOf(MigrationLockBusyError);
      expect(Date.now() - started).toBeLessThan(1000);
      await expect(tx.query('SELECT 1')).resolves.toBeDefined();
      await tx.rollback();
    } finally {
      await holder.release();
    }
    // A new transaction after release succeeds.
    await db.transaction!(async (tx) => {
      await migrate(tx);
    });
  }, 60_000);

  it('a second migrate on a transaction that already holds the key does not wait', async () => {
    const tx = await db.beginTransaction!();
    await migrate(tx as unknown as DatabaseInterface);
    const waiting = migrate(other, { migrationLockTimeout: 20_000 });
    await until(
      async () => (await suite.running(/pg_try_advisory_lock/)).length > 0,
    );
    const started = Date.now();
    await migrate(tx as unknown as DatabaseInterface);
    expect(Date.now() - started).toBeLessThan(2000);
    await tx.commit();
    await waiting;
  }, 60_000);

  it('succeeds after the bootstrap lock with the key free, and refuses at once with it held', async () => {
    await db.transaction!(async (tx) => {
      await ensureSystemTables(tx, 'postgres');
      await migrate(tx);
    });
    const holder = await holdKey(other);
    try {
      await expect(
        db.transaction!(async (tx) => {
          await ensureSystemTables(tx, 'postgres');
          await migrate(tx);
        }),
      ).rejects.toBeInstanceOf(MigrationLockBusyError);
    } finally {
      await holder.release();
    }
  }, 60_000);

  it.each([
    'repeatable read',
    'serializable',
  ])('refuses a borrowed transaction at %s, leaving it usable and the key free', async (level) => {
    await expect(
      db.transaction!(async (tx) => {
        await tx.query(
          `SET TRANSACTION ISOLATION LEVEL ${level.toUpperCase()}`,
        );
        await tx.query('SELECT 1');
        await expect(migrate(tx)).rejects.toBeInstanceOf(
          MigrationLockIsolationError,
        );
        expect(await held(tx)).toBe(false);
        await expect(tx.query('SELECT 2')).resolves.toBeDefined();
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it('plans against a column committed elsewhere under read committed', async () => {
    ObjectRegistry.register(LockTxThing, {
      packageName: '@lock-tx/fixture',
      tableName: 'lock_tx_fresh',
    });
    await other.query('CREATE TABLE lock_tx_fresh (id uuid PRIMARY KEY)');
    await db.transaction!(async (tx) => {
      await tx.query('SELECT 1');
      await other.query('ALTER TABLE lock_tx_fresh ADD COLUMN title text');
      const result = await migrate(tx);
      expect(result.statements.join('\n')).not.toMatch(/ADD COLUMN "?title/);
    });
  }, 60_000);

  it('refuses a transaction from another pool at the same URL inside a holder', async () => {
    await withMigrationLock(db, async () => {
      await expect(
        other.transaction!((tx) => migrate(tx)),
      ).rejects.toBeInstanceOf(MigrationLockBusyError);
    });
  }, 60_000);

  it('refuses wrappers without a valid affinity claim before any statement', async () => {
    const statements: string[] = [];
    const record =
      (target: DatabaseInterface) =>
      (sql: string, ...vars: unknown[]) => {
        statements.push(sql);
        return target.query(sql, ...vars);
      };
    const wrapper = {
      url: suite.url,
      query: record(db),
      transaction: db.transaction!.bind(db),
    } as unknown as DatabaseInterface;
    await expect(migrate(wrapper)).rejects.toBeInstanceOf(
      MigrationLockUnsupportedError,
    );
    const engineOnly = {
      engine: 'postgres',
      query: record(db),
      transaction: db.transaction!.bind(db),
    } as unknown as DatabaseInterface;
    await expect(migrate(engineOnly)).rejects.toBeInstanceOf(
      MigrationLockUnsupportedError,
    );
    await db.transaction!(async (tx) => {
      const mixed = { ...tx, transaction: db.transaction } as DatabaseInterface;
      await expect(migrate(mixed)).rejects.toBeInstanceOf(
        MigrationLockUnsupportedError,
      );
    });
    expect(statements).toEqual([]);
  }, 60_000);

  it('refuses two migrates at once on one borrowed transaction; the retry after rollback succeeds', async () => {
    const tx = await db.beginTransaction!();
    const outcomes = await Promise.allSettled([
      migrate(tx as unknown as DatabaseInterface),
      migrate(tx as unknown as DatabaseInterface),
    ]);
    expect(
      outcomes.filter(
        (o) =>
          o.status === 'rejected' &&
          o.reason instanceof MigrationRunOverlapError,
      ),
    ).toHaveLength(1);
    await tx.rollback();
    await db.transaction!((retry) => migrate(retry));
  }, 60_000);

  it('refuses an activation and a migrate on the pool inside a borrowed callback', async () => {
    await db.transaction!(async (tx) => {
      await withMigrationLock(tx, async () => {
        expect(() => withRuntimeSchemaActivation(async () => {})).toThrow(
          MigrationLockOrderError,
        );
        await expect(migrate(db)).rejects.toBeInstanceOf(
          MigrationLockOrderError,
        );
      });
    });
  }, 60_000);

  it('runs a transaction of a live run at the role default repeatable read, and refuses a pool transaction there', async () => {
    await suite.sql(
      `ALTER DATABASE ${suite.name} SET default_transaction_isolation = 'repeatable read'`,
    );
    try {
      const fresh = await suite.pool();
      await withMigrationLock(fresh, async (lock) => {
        await lock.db.transaction!((tx) => migrate(tx));
      });
      await expect(
        fresh.transaction!((tx) => migrate(tx)),
      ).rejects.toBeInstanceOf(MigrationLockIsolationError);
    } finally {
      await suite.sql(
        `ALTER DATABASE ${suite.name} RESET default_transaction_isolation`,
      );
    }
  }, 60_000);

  it('a holder whose transaction is paused keeps a borrowed transaction refused at once', async () => {
    const pause = gate();
    const holder = withMigrationLock(other, async () => {
      await pause.promise;
    });
    await until(async () => (await suite.holderPid()) !== undefined);
    const started = Date.now();
    await expect(db.transaction!((tx) => migrate(tx))).rejects.toBeInstanceOf(
      MigrationLockBusyError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    pause.open();
    await holder;
    // An explicit lock on a transaction: transaction kind, the same handle.
    await db.transaction!(async (tx) => {
      const lock = await acquireMigrationLock(tx);
      expect(lock).toMatchObject({ held: true, kind: 'transaction' });
      expect(lock.db).toBe(tx);
    });
  }, 60_000);

  it('a transaction that rescaled a table and then migrates while a holder waits on that table is refused at once; the holder finishes after the rollback (A16)', async () => {
    await rescaleMoneyColumnsToMinorUnits(db, [], {
      engineHint: 'postgres',
      backfillName: 'test:a16-setup',
    });
    await db.query(
      'CREATE TABLE a16_orders (id text PRIMARY KEY, total double precision)',
    );
    await db.query("INSERT INTO a16_orders VALUES ('o1', 19.99)");
    const tx = await db.beginTransaction!();
    try {
      // The rescale takes the backfill claim and rewrites the table, so the
      // transaction holds an ACCESS EXCLUSIVE lock on it.
      await rescaleMoneyColumnsToMinorUnits(
        tx as unknown as DatabaseInterface,
        [{ table: 'a16_orders', columns: ['total'] }],
        { engineHint: 'postgres', backfillName: 'test:a16' },
      );
      const holder = withMigrationLock(other, async (lock) => {
        await lock.db.query('ALTER TABLE a16_orders ADD COLUMN note text');
      });
      await until(
        async () => (await suite.waiting(/ALTER TABLE a16_orders/)).length > 0,
        15_000,
        "the holder's ALTER to wait on the transaction",
      );
      const started = Date.now();
      await expect(
        migrate(tx as unknown as DatabaseInterface),
      ).rejects.toBeInstanceOf(MigrationLockBusyError);
      expect(Date.now() - started).toBeLessThan(1000);
      await tx.rollback();
      await holder;
    } finally {
      if (tx.isActive()) await tx.rollback();
    }
    const columns = (
      await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'a16_orders'",
      )
    ).rows.map((row) => String(row.column_name));
    expect(columns).toContain('note');
  }, 60_000);
});
