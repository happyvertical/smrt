import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getTestDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_COLLECTION_BUSY_TIMEOUT_MS,
} from '@happyvertical/smrt-core';
import {
  type DatabaseEngine,
  type DatabaseInterface,
  getDatabase,
  ReopenNotSupportedError,
  type ReopenOptions,
} from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskRunner } from '../runner.js';
import { SmrtWorkerCollection } from '../smrt-worker.js';
import { planLivenessConnection } from '../worker-liveness.js';
import { runLivenessTicker } from '../worker-liveness-ticker.js';

// Capture every connection opened through getDatabase so tests can inspect it.
const opened = vi.hoisted(() => [] as unknown[]);
vi.mock('@happyvertical/sql', async (importActual) => {
  const actual = await importActual<typeof import('@happyvertical/sql')>();
  return {
    ...actual,
    getDatabase: async (...args: Parameters<typeof actual.getDatabase>) => {
      const db = await actual.getDatabase(...args);
      opened.push(db);
      return db;
    },
  };
});

/**
 * Regression tests for #4978. The runtime holds the application database
 * through `node:sqlite`; a liveness thread that opens the same WAL file through
 * `@libsql/client` does not share its file locks and corrupts the file when a
 * renewal lands inside a main-thread write transaction.
 */

const TICK_MS = 5;
let dir: string;
const closers: Array<() => Promise<unknown>> = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-liveness-engine-')));
  opened.length = 0;
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) {
    await close().catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
});

async function openNodeSqlite(
  options: { migrate?: boolean } = {},
): Promise<DatabaseInterface> {
  const db = await getDatabase({
    type: 'sqlite',
    url: join(dir, 'application.sqlite'),
    cache: false,
    secureFile: {
      driver: 'node:sqlite',
      custody: 'trusted-parent',
      root: dir,
    },
  });
  closers.push(() => db.close?.() ?? Promise.resolve());
  await db.query('PRAGMA journal_mode = WAL');
  await db.query('PRAGMA busy_timeout = 5000');
  // Create the job-system tables on this node:sqlite connection.
  if (options.migrate !== false) await getTestDatabase({ db });
  return db;
}

async function readLease(
  db: DatabaseInterface,
  workerKey: string,
): Promise<string | null> {
  const result = await db.query(
    'SELECT lease_expires_at FROM _smrt_workers WHERE worker_id = ?',
    workerKey,
  );
  return (
    (result.rows[0] as { lease_expires_at?: string } | undefined)
      ?.lease_expires_at ?? null
  );
}

/** Wrap a connection so it reports `overrides` and delegates everything else. */
function wrap(
  db: DatabaseInterface,
  overrides: Record<string, unknown>,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in overrides) {
        return overrides[prop];
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as DatabaseInterface;
}

describe('liveness thread and the runtime share one SQLite engine (#4978)', () => {
  it('does not let the liveness thread write while the runtime holds the write lock', async () => {
    const db = await openNodeSqlite();
    await db.query('CREATE TABLE IF NOT EXISTS probe (id INTEGER, v TEXT)');
    const reader = await openNodeSqlite({ migrate: false });

    const runner = createTaskRunner({
      pollInterval: 60_000,
      leaseTickMs: TICK_MS,
      leaseTtlMs: 60_000,
      retention: false,
    });
    await runner.initialize(db);
    await runner.start();
    closers.push(() => runner.stop());
    const internals = runner as unknown as {
      livenessWorker: unknown;
      workerKey: string;
    };
    expect(internals.livenessWorker).not.toBeNull();

    // The thread is renewing every 5 ms: wait until it has done so at least once
    // since start, then take the write lock on the runtime's own connection.
    const atStart = await readLease(reader, internals.workerKey);
    await expect
      .poll(() => readLease(reader, internals.workerKey), {
        timeout: 5_000,
        interval: 5,
      })
      .not.toBe(atStart);

    const tx = await db.beginTransaction?.();
    if (!tx) throw new Error('beginTransaction() is required');
    await tx.query('INSERT INTO probe (id, v) VALUES (?, ?)', 1, 'held');
    const held = await readLease(reader, internals.workerKey);

    // While the write lock is held, a renewal from the same engine must wait.
    // A thread on the other engine (the #4978 defect) ignores the lock and its
    // write lands here: observe it for as long as it takes to arrive, up to a
    // ceiling, and stop at the first change.
    let wroteWhileHeld = false;
    const deadline = Date.now() + 400;
    while (Date.now() < deadline && !wroteWhileHeld) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      wroteWhileHeld = (await readLease(reader, internals.workerKey)) !== held;
    }
    expect(wroteWhileHeld).toBe(false);

    await tx.commit();

    // Once the lock is released the waiting renewal goes through.
    await expect
      .poll(() => readLease(reader, internals.workerKey), {
        timeout: 5_000,
        interval: 5,
      })
      .not.toBe(held);
    const check = await db.query('PRAGMA integrity_check');
    expect(check.rows).toEqual([{ integrity_check: 'ok' }]);
  }, 30_000);

  it('stress: keeps the SQLite file intact while renewals race main-thread write transactions', async () => {
    const db = await openNodeSqlite();
    expect(db.engine).toBe('node-sqlite');
    await db.query('CREATE TABLE IF NOT EXISTS probe (id INTEGER, v TEXT)');

    const runner = createTaskRunner({
      pollInterval: 60_000,
      leaseTickMs: TICK_MS,
      leaseTtlMs: 60_000,
      retention: false,
    });
    await runner.initialize(db);
    await runner.start();
    closers.push(() => runner.stop());
    const internals = runner as unknown as {
      livenessWorker: unknown;
      workerKey: string;
    };
    // Same engine on both sides, so the thread runs.
    expect(internals.livenessWorker).not.toBeNull();

    // The runtime's other connections (a second node:sqlite handle, like the
    // session service's) read what the first one wrote.
    const reader = await openNodeSqlite({ migrate: false });

    // Write transactions on the main thread, each yielding to the event loop
    // mid-transaction like an awaited statement chain does, so renewals (every
    // 5 ms) arrive while the write lock is held.
    const transaction = db.transaction?.bind(db);
    if (!transaction) throw new Error('transaction() is required');
    const payload = 'x'.repeat(200);
    for (let i = 0; i < 300; i++) {
      await transaction(async (tx) => {
        for (let j = 0; j < 20; j++) {
          await tx.query('INSERT INTO probe (id, v) VALUES (?, ?)', i, payload);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
        await tx.query('UPDATE probe SET v = ? WHERE id = ?', 'y', i);
      });
      await reader.query('SELECT COUNT(*) AS n FROM probe');
    }

    const check = await db.query('PRAGMA integrity_check');
    expect(check.rows).toEqual([{ integrity_check: 'ok' }]);
    const count = await db.query('SELECT COUNT(*) AS n FROM probe');
    expect((count.rows[0] as { n: number }).n).toBe(300 * 20);

    // And the thread really did renew the lease meanwhile.
    const before = await readLease(db, internals.workerKey);
    await expect
      .poll(async () => (await readLease(db, internals.workerKey)) !== before, {
        timeout: 5_000,
        interval: 10,
      })
      .toBe(true);
  }, 60_000);

  it('opens the thread connection on the runtime engine with busy_timeout applied', async () => {
    const db = await openNodeSqlite();
    const workers = await SmrtWorkerCollection.create({ db });
    await workers.registerWorker({ workerKey: 'eng-w', leaseTtlMs: 10_000 });
    const mark = opened.length;

    const ticker = await runLivenessTicker({
      url: '',
      reopen: db.reopenOptions?.() as ReopenOptions,
      expectedEngine: db.engine as DatabaseEngine,
      workerKey: 'eng-w',
      leaseTtlMs: 10_000,
      leaseTickMs: 60_000,
    });
    closers.push(() => ticker.stop());

    const second = opened[mark] as DatabaseInterface;
    expect(second).not.toBe(db);
    expect(second.engine).toBe(db.engine);
    expect(second.engine).toBe('node-sqlite');
    const timeout = await second.query('PRAGMA busy_timeout');
    expect(Object.values(timeout.rows[0] as object)[0]).toBe(
      SQLITE_BUSY_TIMEOUT_MS,
    );
  });

  it('refuses a thread connection whose engine differs from the runtime engine', async () => {
    const db = await openNodeSqlite();
    const mark = opened.length;
    await expect(
      runLivenessTicker({
        url: '',
        reopen: db.reopenOptions?.() as ReopenOptions,
        expectedEngine: 'libsql',
        workerKey: 'x',
        leaseTtlMs: 10_000,
        leaseTickMs: 60_000,
      }),
    ).rejects.toThrow(/engine/);
    expect(opened.length).toBe(mark + 1);
  });

  it('refuses to build SQLite thread options from a URL', async () => {
    await expect(
      runLivenessTicker({
        url: `file:${join(dir, 'x.db')}`,
        type: 'sqlite',
        workerKey: 'x',
        leaseTtlMs: 10_000,
        leaseTickMs: 60_000,
      }),
    ).rejects.toThrow(/reopen options/);
  });

  describe.each([
    [
      'the connection does not report an engine',
      (db: DatabaseInterface) => wrap(db, { engine: undefined }),
    ],
    [
      'reopenOptions throws ReopenNotSupportedError',
      (db: DatabaseInterface) =>
        wrap(db, {
          reopenOptions: () => {
            throw new ReopenNotSupportedError('node-sqlite', 'not reopenable');
          },
        }),
    ],
    [
      'reopenOptions is missing',
      (db: DatabaseInterface) => wrap(db, { reopenOptions: undefined }),
    ],
  ])('when %s', (_name, make) => {
    it('does not start the thread and renews the lease on the main loop, logging once', async () => {
      const real = await openNodeSqlite();
      const db = make(real);
      expect(planLivenessConnection(db).kind).toBe('none');

      const runner = createTaskRunner({
        pollInterval: 60_000,
        leaseTickMs: 20,
        leaseTtlMs: 10_000,
        retention: false,
      });
      const warn = vi.spyOn(
        (runner as unknown as { logger: { warn(m: string): void } }).logger,
        'warn',
      );
      await runner.initialize(db);
      await runner.start();
      closers.push(() => runner.stop());
      const internals = runner as unknown as {
        livenessWorker: unknown;
        leaseTimer: unknown;
        workerKey: string;
      };

      expect(internals.livenessWorker).toBeNull();
      expect(internals.leaseTimer).not.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(
        'Liveness thread not used',
      );

      const before = await readLease(real, internals.workerKey);
      await expect
        .poll(
          async () => {
            const now = await readLease(real, internals.workerKey);
            return Boolean(now && before && now > before);
          },
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses reopen options without the expected engine', async () => {
    const db = await openNodeSqlite();
    await expect(
      runLivenessTicker({
        url: '',
        reopen: db.reopenOptions?.() as ReopenOptions,
        workerKey: 'x',
        leaseTtlMs: 10_000,
        leaseTickMs: 60_000,
      } as unknown as Parameters<typeof runLivenessTicker>[0]),
    ).rejects.toThrow(/expectedEngine/);
  });

  it('names the thread error when the thread cannot start, and renews on the main loop', async () => {
    const real = await openNodeSqlite();
    // Report a different engine than the reopened connection really has, so the
    // thread's engine check refuses to run.
    const db = wrap(real, { engine: 'libsql' });
    expect(planLivenessConnection(db).kind).toBe('reopen');
    const runner = createTaskRunner({
      pollInterval: 60_000,
      leaseTickMs: 20,
      leaseTtlMs: 10_000,
      retention: false,
    });
    const warn = vi.spyOn(
      (runner as unknown as { logger: { warn(m: string): void } }).logger,
      'warn',
    );
    await runner.initialize(db);
    await runner.start();
    closers.push(() => runner.stop());
    const internals = runner as unknown as {
      livenessWorker: unknown;
      leaseTimer: unknown;
    };
    expect(internals.livenessWorker).toBeNull();
    expect(internals.leaseTimer).not.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('across engines');
  });

  it('keeps main-loop renewal quiet for engines that never had a second connection', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    const plan = planLivenessConnection(db);
    expect(plan.kind).toBe('none');
    if (plan.kind === 'none') expect(plan.degraded).toBe(false);

    const runner = createTaskRunner({
      pollInterval: 60_000,
      leaseTickMs: 20,
      leaseTtlMs: 10_000,
      retention: false,
    });
    const logger = (
      runner as unknown as {
        logger: { warn(m: string): void; debug(m: string): void };
      }
    ).logger;
    const warn = vi.spyOn(logger, 'warn');
    const debug = vi.spyOn(logger, 'debug');
    await runner.initialize(db);
    await runner.start();
    closers.push(() => runner.stop());
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('marks file SQLite fallbacks as degraded', async () => {
    const real = await openNodeSqlite();
    for (const db of [
      wrap(real, { engine: undefined }),
      wrap(real, { reopenOptions: undefined }),
    ]) {
      const plan = planLivenessConnection(db);
      expect(plan.kind).toBe('none');
      if (plan.kind === 'none') expect(plan.degraded).toBe(true);
    }
    const plan = planLivenessConnection(real, 'win32');
    if (plan.kind === 'none') expect(plan.degraded).toBe(true);
  });

  it('start() keeps a shorter collection busy timeout and sets one when unset', async () => {
    const db = await openNodeSqlite();
    const timeout = async () =>
      Number(
        Object.values(
          ((await db.query('PRAGMA busy_timeout')).rows[0] ?? {}) as object,
        )[0],
      );
    for (const [before, after] of [
      [SQLITE_COLLECTION_BUSY_TIMEOUT_MS, SQLITE_COLLECTION_BUSY_TIMEOUT_MS],
      [0, SQLITE_BUSY_TIMEOUT_MS],
    ]) {
      await db.query(`PRAGMA busy_timeout = ${before}`);
      const runner = createTaskRunner({
        pollInterval: 60_000,
        leaseTickMs: 20,
        leaseTtlMs: 10_000,
        retention: false,
      });
      await runner.initialize(db);
      await runner.start();
      closers.push(() => runner.stop());
      expect(await timeout()).toBe(after);
      await runner.stop();
    }
  });

  it('plans no thread for secure SQLite on Windows, a reopen for it elsewhere', async () => {
    const db = await openNodeSqlite();
    expect(planLivenessConnection(db, 'win32').kind).toBe('none');
    const plan = planLivenessConnection(db, 'linux');
    expect(plan.kind).toBe('reopen');
    if (plan.kind === 'reopen') expect(plan.engine).toBe('node-sqlite');
  });

  it('plans PostgreSQL from its URL, unchanged', () => {
    const pg = {
      url: 'postgres://u:p@localhost:5432/db',
      type: 'postgres',
    } as unknown as DatabaseInterface;
    expect(planLivenessConnection(pg)).toEqual({
      kind: 'url',
      url: 'postgres://u:p@localhost:5432/db',
      type: 'postgres',
    });
  });
});
