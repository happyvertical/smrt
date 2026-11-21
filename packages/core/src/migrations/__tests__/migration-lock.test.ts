/**
 * The migration lock's contract on a scripted server-PostgreSQL double
 * (#3634, #5435): handle classes, the session run, transaction rules, one
 * deadline from the entry point, the lock-owning backend registry, and the
 * order guards. The double proves control flow and timing; what depends on
 * PostgreSQL or `@happyvertical/sql` itself is in the PostgreSQL lanes.
 */

import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ActivationManifest,
  createActivationCoordinator,
  withRuntimeSchemaActivation,
} from '../../activation.js';
import { createAppModelEditor } from '../../cookbook/model-editor.js';
import { COOKBOOK_SCHEMA_URL } from '../../cookbook/validate.js';
import { ObjectRegistry } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database.js';
import {
  acquireMigrationLock,
  MIGRATION_ADVISORY_LOCK_KEYS,
  type MigrationLock,
  MigrationLockBusyError,
  MigrationLockIsolationError,
  MigrationLockLostError,
  MigrationLockOrderError,
  MigrationLockTimeoutError,
  MigrationLockUnsupportedError,
  MigrationRunOverlapError,
  withMigrationLock,
} from '../migration-lock.js';
import { migrateSmrtSchemas } from '../orchestrate.js';
import { MigrationTracker } from '../tracker.js';
import {
  answer,
  createPgDouble,
  deferred,
  fakeClock,
  never,
} from './pg-lock-double.js';

const MINIMUM_SQL = '0.116.7';
const EDITOR_TENANT = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  vi.useRealTimers();
});

describe('session run on a pool handle', () => {
  it('runs the work on the session database of the backend that holds the key, then releases', async () => {
    const pg = createPgDouble();
    let seen: MigrationLock | undefined;
    const result = await withMigrationLock(pg.db, async (lock) => {
      seen = lock;
      expect(lock.held).toBe(true);
      expect(lock.kind).toBe('session');
      expect(lock.db).not.toBe(pg.db);
      await lock.db.query('SELECT 1 AS work');
      await lock.db.transaction!(async (tx) => tx.query('SELECT 2 AS work'));
      return 'done';
    });
    expect(result).toBe('done');
    const holder = pg.sessions[0].backend.pid;
    expect(pg.workStatements().filter((s) => /work/.test(s.sql))).toEqual([
      { pid: holder, sql: 'SELECT 1 AS work' },
      { pid: holder, sql: 'SELECT 2 AS work' },
    ]);
    expect(pg.tryStatements()).toEqual([
      {
        pid: holder,
        sql: `SELECT pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS}) AS acquired`,
      },
    ]);
    expect(pg.sessions[0].release.calls).toBe(1);
    expect(pg.key.pid).toBeNull();
    expect(seen?.held).toBe(true);
  });

  it('rejects a call on the run database after the run ended', async () => {
    const pg = createPgDouble();
    let runDb: any;
    await withMigrationLock(pg.db, async (lock) => {
      runDb = lock.db;
    });
    await expect(runDb.query('SELECT 1')).rejects.toThrow();
  });

  it('waits without limit when the timeout is 0 and acquires on release', async () => {
    const pg = createPgDouble();
    const clock = fakeClock();
    pg.holdKey();
    let attempts = 0;
    pg.setScript((sql) => {
      if (/pg_try_advisory_lock/.test(sql) && ++attempts === 1441)
        pg.releaseKey();
      return undefined;
    });
    const lock = await acquireMigrationLock(pg.db, {
      timeoutMs: 0,
      pollIntervalMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(lock.held).toBe(true);
    expect(clock.value).toBe(24 * 60 * 60_000);
    expect(lock.waitedMs).toBe(24 * 60 * 60_000);
    await lock.release();
  });

  it('counts the checkout and the lock wait against one deadline', async () => {
    const clock = fakeClock();
    const pg = createPgDouble({
      checkout: () => {
        clock.value += 800;
      },
    });
    pg.holdKey();
    const failure = await acquireMigrationLock(pg.db, {
      timeoutMs: 1000,
      pollIntervalMs: 150,
      now: clock.now,
      sleep: clock.sleep,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).phase).toBe('lock');
    expect(clock.value).toBe(1000);
    expect(clock.sleeps).toEqual([150, 50]);
    expect(pg.sessions[0].destroy.calls).toBe(1);
  });

  it('rejects at the deadline while the checkout is still pending, and destroys a late session', async () => {
    const gate = deferred();
    const pg = createPgDouble({ checkout: () => gate.promise });
    const started = performance.now();
    const failure = await withMigrationLock(pg.db, async () => 'never', {
      timeoutMs: 120,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).phase).toBe('checkout');
    expect(performance.now() - started).toBeLessThan(2000);
    gate.resolve();
    await vi.waitFor(() => expect(pg.sessions).toHaveLength(1));
    await vi.waitFor(() => expect(pg.sessions[0].destroy.calls).toBe(1));
    expect(pg.tryStatements()).toEqual([]);
  });

  it('surfaces an error thrown by onWait and leaves nothing pinned or locked', async () => {
    const pg = createPgDouble();
    pg.holdKey();
    const failure = await withMigrationLock(pg.db, async () => 'never', {
      onWait: () => {
        throw new Error('onWait failed');
      },
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('onWait failed');
    expect(pg.sessions[0].active()).toBe(false);
    pg.releaseKey();
    const onWait = vi.fn();
    await expect(
      withMigrationLock(pg.db, async (lock) => lock.held, { onWait }),
    ).resolves.toBe(true);
    expect(onWait).not.toHaveBeenCalled();
  });

  it('checks the deadline after onWait and never sleeps for zero', async () => {
    const clock = fakeClock();
    const pg = createPgDouble();
    pg.holdKey();
    const nearly = await acquireMigrationLock(pg.db, {
      timeoutMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
      onWait: () => {
        clock.value = 999.6;
      },
    }).catch((error: unknown) => error);
    expect(nearly).toBeInstanceOf(MigrationLockTimeoutError);
    expect(clock.sleeps).toHaveLength(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(1);
    expect(pg.tryStatements()).toHaveLength(1);

    const later = fakeClock();
    const pg2 = createPgDouble();
    pg2.holdKey();
    const past = await acquireMigrationLock(pg2.db, {
      timeoutMs: 1000,
      now: later.now,
      sleep: later.sleep,
      onWait: () => {
        later.value = 1500;
      },
    }).catch((error: unknown) => error);
    expect(past).toBeInstanceOf(MigrationLockTimeoutError);
    expect(later.sleeps).toEqual([]);
    expect(pg2.tryStatements()).toHaveLength(1);
  });

  it('rejects at the deadline when the proof statement never answers, without awaiting cleanup', async () => {
    const pg = createPgDouble();
    pg.setScript((sql, backend) => {
      if (/FROM pg_locks/.test(sql)) {
        backend.hung = true;
        return never();
      }
      return undefined;
    });
    const work = vi.fn();
    const started = performance.now();
    const failure = await withMigrationLock(pg.db, work, {
      timeoutMs: 300,
    }).catch((error: unknown) => error);
    const elapsed = performance.now() - started;
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).phase).toBe('lock');
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2500);
    expect(work).not.toHaveBeenCalled();
    expect(pg.sessions[0].destroy.calls).toBe(1);
    expect(pg.key.pid).toBeNull();
  });

  it('reads a malformed lock answer as not acquired and a malformed proof as no proof', async () => {
    const clock = fakeClock();
    const empty = createPgDouble({
      script: (sql) =>
        /pg_try_advisory_lock/.test(sql)
          ? answer([])
          : /pg_try/.test(sql)
            ? undefined
            : undefined,
    });
    await expect(
      acquireMigrationLock(empty.db, {
        timeoutMs: 500,
        pollIntervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    expect(empty.tryStatements().length).toBeGreaterThan(1);

    const yes = createPgDouble({
      script: (sql) =>
        /pg_try_advisory_lock/.test(sql)
          ? answer([{ acquired: 'yes' }])
          : undefined,
    });
    const yesClock = fakeClock();
    await expect(
      acquireMigrationLock(yes.db, {
        timeoutMs: 500,
        pollIntervalMs: 100,
        now: yesClock.now,
        sleep: yesClock.sleep,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);

    const proof = createPgDouble();
    proof.setScript((sql, backend) =>
      /FROM pg_locks/.test(sql)
        ? answer([{ held: 'yes', pid: backend.pid }])
        : undefined,
    );
    await expect(acquireMigrationLock(proof.db)).rejects.toBeInstanceOf(
      MigrationLockUnsupportedError,
    );
    expect(proof.sessions[0].destroy.calls).toBe(1);
  });

  it('refuses when the proof comes from another backend', async () => {
    const pg = createPgDouble();
    pg.setScript((sql) =>
      /FROM pg_locks/.test(sql)
        ? answer([{ held: true, pid: 4242 }])
        : undefined,
    );
    const work = vi.fn();
    await expect(withMigrationLock(pg.db, work)).rejects.toBeInstanceOf(
      MigrationLockUnsupportedError,
    );
    expect(work).not.toHaveBeenCalled();
    expect(pg.sessions[0].destroy.calls).toBe(1);
  });

  it('refuses a session without database() or destroy(), leaving nothing pinned', async () => {
    const noDatabase = createPgDouble({ sessionDatabase: false });
    await expect(
      withMigrationLock(noDatabase.db, async () => {}),
    ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    expect(noDatabase.sessions[0].destroy.calls).toBe(1);
    expect(noDatabase.sessions[0].release.calls).toBe(0);
    expect(noDatabase.tryStatements()).toEqual([]);

    const noDestroy = createPgDouble({ sessionDestroy: false });
    await expect(
      withMigrationLock(noDestroy.db, async () => {}),
    ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    expect(noDestroy.sessions[0].release.calls).toBe(1);
    expect(noDestroy.tryStatements()).toEqual([]);
  });

  it('exempts the lock session from idle_session_timeout on PostgreSQL 14+ only', async () => {
    const modern = createPgDouble();
    await withMigrationLock(modern.db, async () => {});
    expect(modern.log.map((s) => s.sql)).toContain(
      'SET idle_session_timeout = 0',
    );
    // A destroyed session's backend notices the closed connection within a
    // second, before the key is first tried.
    const sqls = modern.log.map((s) => s.sql);
    const check = sqls.indexOf("SET client_connection_check_interval = '1s'");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(
      sqls.findIndex((sql) => /pg_try_advisory_lock/.test(sql)),
    );
    const legacy = createPgDouble({ serverVersion: 130012 });
    await withMigrationLock(legacy.db, async () => {});
    expect(legacy.log.map((s) => s.sql)).not.toContain(
      'SET idle_session_timeout = 0',
    );
    expect(legacy.log.map((s) => s.sql).join('\n')).not.toContain(
      'client_connection_check_interval',
    );
  });

  it('assertHeld: a statement error on a live session is that error; a dead session is a lost lock', async () => {
    const pg = createPgDouble();
    const lock = await acquireMigrationLock(pg.db);
    pg.setScript((sql) => {
      if (/FROM pg_locks/.test(sql)) throw new Error('statement failed');
      return undefined;
    });
    await expect(lock.assertHeld()).rejects.toThrow('statement failed');
    pg.setScript(undefined);
    await expect(lock.assertHeld()).resolves.toBeUndefined();
    pg.kill(pg.sessions[0].backend.pid);
    await expect(lock.assertHeld()).rejects.toBeInstanceOf(
      MigrationLockLostError,
    );
    await lock.release();
  });

  it('releases the key when the work throws, and the next run does not wait', async () => {
    const pg = createPgDouble();
    await expect(
      withMigrationLock(pg.db, async () => {
        throw new Error('work failed');
      }),
    ).rejects.toThrow('work failed');
    expect(pg.key.pid).toBeNull();
    const onWait = vi.fn();
    await withMigrationLock(pg.db, async () => {}, { onWait });
    expect(onWait).not.toHaveBeenCalled();
  });
});

describe('handles without a valid affinity claim', () => {
  it('refuses a pool-shaped handle with every member but no claim, naming the minimum version', async () => {
    const pg = createPgDouble({ claims: false });
    const failure = await withMigrationLock(pg.db, async () => {}).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationLockUnsupportedError);
    expect((failure as Error).message).toContain(MINIMUM_SQL);
    expect((failure as Error).message).toContain('created');
    expect(pg.log).toEqual([]);
    expect(pg.counters.checkouts).toBe(0);
  });

  it('refuses a structural wrapper built from pool methods, key held or free', async () => {
    const pg = createPgDouble();
    const wrapper = {
      url: pg.url,
      query: (sql: string) => pg.db.query(sql),
      transaction: (work: any) => pg.db.transaction(work),
    } as any;
    await expect(
      migrateSmrtSchemas({ db: wrapper, packageName: '@lock/app' }),
    ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    pg.holdKey();
    await expect(
      withMigrationLock(wrapper, async () => {}),
    ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    expect(pg.log).toEqual([]);
  });

  it('refuses an engine-only wrapper with no URL as server PostgreSQL, never planning it as SQLite', async () => {
    const pg = createPgDouble();
    const wrapper = {
      engine: 'postgres',
      query: (sql: string) => pg.db.query(sql),
      transaction: (work: any) => pg.db.transaction(work),
    } as any;
    await expect(
      migrateSmrtSchemas({ db: wrapper, packageName: '@lock/app' }),
    ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    expect(pg.log.filter((s) => /PRAGMA|sqlite_master/i.test(s.sql))).toEqual(
      [],
    );
    expect(pg.log).toEqual([]);
  });

  it('refuses a spread copy of a transaction mixed with pool members, and a spread pool', async () => {
    const pg = createPgDouble();
    await pg.db.transaction(async (tx: any) => {
      const mixed = { ...tx, transaction: pg.db.transaction } as any;
      await expect(
        withMigrationLock(mixed, async () => {}),
      ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
      const reverse = { ...pg.db, transaction: tx.transaction } as any;
      await expect(
        withMigrationLock(reverse, async () => {}),
      ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    });
    expect(pg.tryStatements()).toEqual([]);
    expect(pg.counters.checkouts).toBe(0);
  });

  it('refuses a session database that is not a live run', async () => {
    const pg = createPgDouble();
    const session = await pg.db.acquireSession();
    await expect(
      withMigrationLock(session.database(), async () => {}),
    ).rejects.toBeInstanceOf(MigrationLockUnsupportedError);
    await session.release();
  });
});

describe('a caller transaction', () => {
  it.each([
    'repeatable read',
    'serializable',
    'snapshot (unrecognised)',
  ])('refuses %s with the key untouched and the transaction usable', async (isolation) => {
    const pg = createPgDouble({ isolation });
    await pg.db.transaction(async (tx: any) => {
      await expect(
        withMigrationLock(tx, async () => {}),
      ).rejects.toBeInstanceOf(MigrationLockIsolationError);
      expect(pg.key.pid).toBeNull();
      await expect(tx.query('SELECT 1 AS still_usable')).resolves.toBeDefined();
    });
    expect(pg.tryStatements()).toEqual([]);
  });

  it('takes the key at transaction level under read committed, held to the end of the transaction', async () => {
    const pg = createPgDouble();
    await pg.db.transaction(async (tx: any) => {
      const lock = await acquireMigrationLock(tx);
      expect(lock).toMatchObject({ held: true, kind: 'transaction' });
      expect(lock.db).toBe(tx);
      await lock.release();
      expect(pg.key).toMatchObject({ level: 'transaction' });
    });
    expect(pg.key.pid).toBeNull();
  });

  it('refuses at once with a retryable busy error when another run holds the key', async () => {
    const pg = createPgDouble();
    pg.holdKey();
    const clock = fakeClock();
    await pg.db.transaction(async (tx: any) => {
      const failure = await withMigrationLock(tx, async () => {}, {
        now: clock.now,
        sleep: clock.sleep,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MigrationLockBusyError);
      expect((failure as MigrationLockBusyError).retryable).toBe(true);
    });
    expect(pg.tryStatements()).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
    pg.releaseKey();
    await pg.db.transaction(async (tx: any) => {
      await expect(
        withMigrationLock(tx, async (lock) => lock.held),
      ).resolves.toBe(true);
    });
  });

  it('proceeds without another attempt when the transaction already holds the key', async () => {
    const pg = createPgDouble();
    await pg.db.transaction(async (tx: any) => {
      await withMigrationLock(tx, async () => {});
      await withMigrationLock(tx, async () => {});
    });
    expect(pg.tryStatements()).toHaveLength(1);
  });

  it('runs a transaction of a live run at any isolation, and refuses a pool transaction at repeatable read', async () => {
    const pg = createPgDouble({ isolation: 'repeatable read' });
    await withMigrationLock(pg.db, async (lock) => {
      await lock.db.transaction!(async (tx) => {
        const inner = await acquireMigrationLock(tx);
        expect(inner.held).toBe(true);
      });
    });
    await pg.db.transaction(async (tx: any) => {
      await expect(acquireMigrationLock(tx)).rejects.toBeInstanceOf(
        MigrationLockIsolationError,
      );
    });
  });
});

describe('reuse, overlap and lifetime', () => {
  it('reuses the run for its own handle and its transactions, on one backend, never waiting', async () => {
    const pg = createPgDouble();
    const onWait = vi.fn();
    await withMigrationLock(pg.db, async (lock) => {
      const tries = pg.tryStatements().length;
      await withMigrationLock(
        lock.db,
        async (inner) => expect(inner).toBe(lock),
        { onWait },
      );
      await lock.db.transaction!((tx) =>
        withMigrationLock(tx, async (inner) => expect(inner.held).toBe(true), {
          onWait,
        }),
      );
      expect(pg.tryStatements()).toHaveLength(tries);
    });
    expect(onWait).not.toHaveBeenCalled();
    expect(new Set(pg.log.map((s) => s.pid)).size).toBe(1);
  });

  it('refuses a second migrate operation on the same backend, through the run handle or its transaction', async () => {
    const pg = createPgDouble();
    const gate = deferred<never>();
    await withMigrationLock(pg.db, async (lock) => {
      pg.setScript((sql) =>
        /pg_postmaster|pg_try|pg_locks|idle_session/.test(sql)
          ? undefined
          : gate.promise,
      );
      const first = migrateSmrtSchemas({
        db: lock.db,
        packageName: '@lock/app',
      });
      const second = migrateSmrtSchemas({
        db: lock.db,
        packageName: '@lock/app',
      });
      const viaTransaction = lock.db.transaction!((tx) =>
        migrateSmrtSchemas({ db: tx, packageName: '@lock/app' }),
      );
      await expect(second).rejects.toBeInstanceOf(MigrationRunOverlapError);
      await expect(viaTransaction).rejects.toBeInstanceOf(
        MigrationRunOverlapError,
      );
      gate.reject(new Error('stop planning'));
      await first.catch(() => {});
    });
  });

  it('refuses a migrate operation on the run transaction while one runs on the run handle', async () => {
    const pg = createPgDouble();
    const gate = deferred<never>();
    await withMigrationLock(pg.db, async (lock) => {
      const runDb = lock.db;
      pg.setScript((sql) =>
        /pg_postmaster|pg_try|pg_locks|idle_session|^BEGIN|^COMMIT|^ROLLBACK/.test(
          sql,
        )
          ? undefined
          : gate.promise,
      );
      const first = migrateSmrtSchemas({ db: runDb, packageName: '@lock/a' });
      const tx = await (runDb as any).beginTransaction();
      await expect(
        migrateSmrtSchemas({ db: tx, packageName: '@lock/a' }),
      ).rejects.toBeInstanceOf(MigrationRunOverlapError);
      await tx.rollback();
      gate.reject(new Error('stop planning'));
      await first.catch(() => {});
    });
  });

  it('refuses a second migrate operation on one borrowed transaction', async () => {
    const pg = createPgDouble();
    const gate = deferred<never>();
    await pg.db
      .transaction(async (tx: any) => {
        pg.setScript((sql) =>
          /pg_postmaster|pg_try|pg_locks|^BEGIN|^COMMIT|^ROLLBACK/.test(sql)
            ? undefined
            : gate.promise,
        );
        const settled = Promise.allSettled([
          migrateSmrtSchemas({ db: tx, packageName: '@lock/a' }),
          migrateSmrtSchemas({ db: tx, packageName: '@lock/a' }),
        ]);
        await vi.waitFor(() =>
          expect(pg.tryStatements().length).toBeGreaterThan(0),
        );
        setTimeout(() => gate.reject(new Error('stop planning')), 50);
        const [one, two] = await settled;
        const reasons = [one, two].map((r) =>
          r.status === 'rejected' ? r.reason : undefined,
        );
        expect(
          reasons.filter((r) => r instanceof MigrationRunOverlapError),
        ).toHaveLength(1);
        throw new Error('roll back');
      })
      .catch(() => {});
  });

  it('does not reuse an explicit lock for an unrelated run on the same pool handle', async () => {
    const pg = createPgDouble();
    const held = await acquireMigrationLock(pg.db);
    const failure = await withMigrationLock(pg.db, async () => {}, {
      timeoutMs: 200,
      pollIntervalMs: 20,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).heldByThisProcess).toBe(true);
    await held.release();
    await expect(
      withMigrationLock(pg.db, async (lock) => lock.held),
    ).resolves.toBe(true);
  });

  it('refuses re-entry on the pool handle from inside a holder before any checkout', async () => {
    const pg = createPgDouble();
    await withMigrationLock(pg.db, async () => {
      const checkouts = pg.counters.checkouts;
      const failure = await withMigrationLock(pg.db, async () => {}).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MigrationLockOrderError);
      expect((failure as MigrationLockOrderError).reason).toBe('reentry');
      await expect(
        migrateSmrtSchemas({ db: pg.db, packageName: '@lock/app' }),
      ).rejects.toBeInstanceOf(MigrationLockOrderError);
      await expect(acquireMigrationLock(pg.db)).rejects.toBeInstanceOf(
        MigrationLockOrderError,
      );
      expect(pg.counters.checkouts).toBe(checkouts);
    });
  });

  it('refuses a migrate on the pool handle and an activation inside a borrowed transaction callback', async () => {
    const pg = createPgDouble();
    await pg.db.transaction(async (tx: any) => {
      await withMigrationLock(tx, async () => {
        await expect(
          migrateSmrtSchemas({ db: pg.db, packageName: '@lock/app' }),
        ).rejects.toBeInstanceOf(MigrationLockOrderError);
        expect(() => withRuntimeSchemaActivation(async () => {})).toThrow(
          MigrationLockOrderError,
        );
      });
    });
  });

  it('without async context propagation, reuse by handle still works and an independent run waits', async () => {
    const original = (process as { getBuiltinModule?: unknown })
      .getBuiltinModule;
    vi.resetModules();
    (process as { getBuiltinModule?: unknown }).getBuiltinModule = undefined;
    let lockModule: typeof import('../migration-lock.js');
    try {
      lockModule = await import('../migration-lock.js');
    } finally {
      (process as { getBuiltinModule?: unknown }).getBuiltinModule = original;
    }
    const pg = createPgDouble();
    const order: string[] = [];
    let independent: Promise<unknown> | undefined;
    await lockModule.withMigrationLock(pg.db, async (lock) => {
      // No holder scope reaches here without async context: guards cannot
      // refuse, and correctness must not depend on them.
      expect(() =>
        lockModule.refuseInsideMigrationLockHolder('activation-inside-holder'),
      ).not.toThrow();
      await lockModule.withMigrationLock(lock.db, async () => {
        order.push('nested');
      });
      independent = lockModule.withMigrationLock(
        pg.db,
        async () => {
          order.push('independent');
        },
        { pollIntervalMs: 10 },
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      order.push('holder done');
    });
    await independent;
    expect(order).toEqual(['nested', 'holder done', 'independent']);
    vi.resetModules();
  });
});

const MODEL = '@lock/fixture:Thing';
function manifest(): ActivationManifest {
  return {
    version: 1,
    modules: {
      thing: { models: [MODEL], dependencies: [] } as any,
    },
    models: {
      [MODEL]: {
        module: 'thing',
        effective: MODEL,
        table: 'lock_things',
        dependencies: [],
      },
    },
    tables: { lock_things: { owners: [MODEL], dependencies: [] } },
  };
}
let scopes = 0;
function coordinator(db: any, extra: Record<string, unknown> = {}) {
  return createActivationCoordinator({
    scope: `lock-test-${++scopes}`,
    db,
    packageName: '@lock/fixture',
    manifest: manifest(),
    loaders: {
      thing: async () => {
        throw new Error('loader stop');
      },
    },
    readEnabled: async () => [],
    ...extra,
  } as any);
}

describe('order guards at the public entry points', () => {
  it('refuses activate() inside a holder before joining a pending activation', async () => {
    const pg = createPgDouble();
    const activation = coordinator(pg.db);
    pg.holdKey();
    const pending = activation.activate([MODEL]);
    const settled = pending.then(
      () => 'resolved',
      (error: Error) => error.message,
    );
    await vi.waitFor(() =>
      expect(pg.tryStatements().length).toBeGreaterThan(0),
    );
    pg.releaseKey();
    const other = createPgDouble();
    await withMigrationLock(other.db, async () => {
      expect(() => activation.activate([MODEL])).toThrow(
        MigrationLockOrderError,
      );
    });
    expect(await settled).toBe('loader stop');
  });

  it('refuses withRuntimeSchemaActivation and createAppModelEditor inside a holder', async () => {
    const pg = createPgDouble();
    await withMigrationLock(pg.db, async () => {
      expect(() => withRuntimeSchemaActivation(async () => {})).toThrow(
        MigrationLockOrderError,
      );
      await expect(createAppModelEditor({} as any)).rejects.toBeInstanceOf(
        MigrationLockOrderError,
      );
    });
  });

  it('refuses an editor apply inside a holder before it joins the edit queue', async () => {
    const restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    const sqlite = await getTestDatabase({
      type: 'sqlite',
      classes: [],
      includeSystemTables: false,
    });
    try {
      const editor = await createAppModelEditor({
        db: sqlite,
        application: 'lock-editor',
        tenantId: EDITOR_TENANT,
        packageName: '@lock/editor',
        cookbook: {
          $schema: COOKBOOK_SCHEMA_URL,
          version: 1,
          recipes: [],
          features: [],
          policies: [],
        } as any,
        catalog: { recipes: [], models: [] } as any,
        authorize: () => true,
      });
      const pg = createPgDouble();
      await withMigrationLock(pg.db, async () => {
        expect(() =>
          editor.apply({ type: 'label', model: 'x', label: 'y' } as any, {
            tenantId: EDITOR_TENANT,
            actor: 'owner',
            requestId: 'lock-apply',
            expectedRevision: editor.snapshot().revision,
          }),
        ).toThrow(MigrationLockOrderError);
      });
    } finally {
      await sqlite.close?.();
      restore();
    }
  });

  it('rejects an activation still queued at its deadline, and the queued turn then does nothing', async () => {
    const pg = createPgDouble();
    const activation = coordinator(pg.db, { migrationLockTimeout: 150 });
    const gate = deferred();
    const blocker = withRuntimeSchemaActivation(() => gate.promise);
    const started = performance.now();
    const failure = await activation
      .activate([MODEL])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect((failure as MigrationLockTimeoutError).phase).toBe('queue');
    expect(performance.now() - started).toBeLessThan(2000);
    gate.resolve();
    await blocker;
    await withRuntimeSchemaActivation(async () => {});
    expect(pg.counters.checkouts).toBe(0);
  });

  it('honours migrationLockTimeout on activation while another run holds the key', async () => {
    const pg = createPgDouble();
    pg.holdKey();
    const activation = coordinator(pg.db, { migrationLockTimeout: 200 });
    const started = performance.now();
    const failure = await activation
      .activate([MODEL])
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationLockTimeoutError);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('holds the key from the ownership check through the loaders', async () => {
    const pg = createPgDouble();
    const seen: Array<number | null> = [];
    const activation = createActivationCoordinator({
      scope: `lock-test-${++scopes}`,
      db: pg.db,
      packageName: '@lock/fixture',
      manifest: manifest(),
      loaders: {
        thing: async () => {
          seen.push(pg.key.pid);
          throw new Error('loader stop');
        },
      },
      readEnabled: async () => [],
    });
    await expect(activation.activate([MODEL])).rejects.toThrow('loader stop');
    expect(seen).toEqual([pg.sessions[0].backend.pid]);
    const journalRead = pg.log.findIndex((s) =>
      /_smrt_app_model_changes/.test(s.sql),
    );
    expect(journalRead).toBeGreaterThan(-1);
    expect(pg.log[journalRead].pid).toBe(pg.sessions[0].backend.pid);
    expect(pg.key.pid).toBeNull();
  });
});

describe('embedded engines take no lock', () => {
  it('DuckDB: no lock, the same handle, and no guard fires in the callback', async () => {
    const duck = await getDatabase({ type: 'duckdb', url: ':memory:' });
    const query = vi.spyOn(duck, 'query');
    await withMigrationLock(duck, async (lock) => {
      expect(lock).toMatchObject({ held: false, kind: 'none' });
      expect(lock.db).toBe(duck);
      await expect(
        withRuntimeSchemaActivation(async () => 'ran'),
      ).resolves.toBe('ran');
    });
    expect(query).not.toHaveBeenCalled();
    await duck.close?.();
  });
});

describe('tracker on handles that cannot pin a session', () => {
  it('refuses an explicit CONCURRENTLY batch on a PostgreSQL transaction before any statement', async () => {
    const pg = createPgDouble();
    await pg.db.transaction(async (tx: any) => {
      const before = pg.log.length;
      const tracker = new MigrationTracker({ db: tx, engineHint: 'postgres' });
      await expect(
        tracker.applyAll(
          [
            {
              id: 'lock_concurrent_index',
              up: ['CREATE INDEX CONCURRENTLY lock_idx ON lock_t (a)'],
              down: [],
              checksum: 'x',
            } as any,
          ],
          { postgresSafe: true },
        ),
      ).rejects.toThrow(/lock_concurrent_index/);
      expect(
        pg.log.slice(before).filter((s) => /CREATE INDEX/i.test(s.sql)),
      ).toEqual([]);
    });
  });

  it('writes concurrent-index rows and runs the index phase on the run session', async () => {
    const pg = createPgDouble();
    await withMigrationLock(pg.db, async (lock) => {
      const tracker = new MigrationTracker({
        db: lock.db,
        engineHint: 'postgres',
      });
      await tracker
        .applyAll(
          [
            {
              id: 'lock_index_phase',
              up: ['CREATE INDEX lock_idx2 ON lock_t (a)'],
              down: [],
              checksum: 'y',
            } as any,
          ],
          { atomic: true, postgresSafe: true },
        )
        .catch(() => {});
    });
    expect(pg.counters.checkouts).toBe(1);
    const pids = new Set(
      pg.log.filter((s) => s.pid !== 1000).map((s) => s.pid),
    );
    expect(pids.size).toBe(1);
  });

  it('refuses beforeCommit without an atomic batch', async () => {
    const sqlite = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const tracker = new MigrationTracker({ db: sqlite });
    await expect(
      tracker.applyAll([], { beforeCommit: async () => {} } as any),
    ).rejects.toThrow(/beforeCommit/);
    await sqlite.close?.();
  });
});
