/**
 * Issue #3634 — `acquireMigrationLock` contract, mock-driven. The live
 * PostgreSQL semantics (a second session really waits, a dropped connection
 * really frees the lock) are in `migration-lock-postgres.optional.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  acquireMigrationLock,
  MIGRATION_ADVISORY_LOCK_KEYS,
  MigrationLockTimeoutError,
  MigrationLockUnsupportedError,
} from '../migration-lock.js';

function fakePostgres(answers: boolean[]) {
  const queries: string[] = [];
  const release = vi.fn(async () => {});
  const session = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      const acquired = answers.length > 0 ? answers.shift() : false;
      return { rows: [{ acquired }], rowCount: 1 };
    }),
    isActive: () => true,
    release,
  };
  const acquireSession = vi.fn(async () => session);
  const db = {
    url: 'postgres://localhost/app',
    query: vi.fn(),
    acquireSession,
  } as any;
  return { db, queries, release, acquireSession };
}

function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
  };
}

describe('acquireMigrationLock', () => {
  it('is a no-op on SQLite and never touches the database', async () => {
    const db = { url: 'sqlite:///tmp/app.db', query: vi.fn() } as any;
    const lock = await acquireMigrationLock(db);
    expect(lock.held).toBe(false);
    expect(lock.waitedMs).toBe(0);
    await lock.release();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('honours an explicit engine hint over the URL', async () => {
    const { db, acquireSession } = fakePostgres([true]);
    db.url = '';
    const lock = await acquireMigrationLock(db, { engineHint: 'postgres' });
    expect(lock.held).toBe(true);
    expect(acquireSession).toHaveBeenCalledTimes(1);
    await lock.release();
  });

  it('takes the db:migrate advisory lock on a pinned session when uncontended', async () => {
    const { db, queries, release } = fakePostgres([true]);
    const onWait = vi.fn();
    const lock = await acquireMigrationLock(db, { onWait });

    expect(lock.held).toBe(true);
    expect(lock.waitedMs).toBe(0);
    expect(onWait).not.toHaveBeenCalled();
    expect(queries).toEqual([
      `SELECT pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS}) AS acquired`,
    ]);
    expect(db.query).not.toHaveBeenCalled();

    expect(release).not.toHaveBeenCalled();
    await lock.release();
    await lock.release();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits for a concurrent holder, notifying once, then takes the lock', async () => {
    const { db, queries, release } = fakePostgres([false, false, true]);
    const clock = fakeClock();
    const onWait = vi.fn();

    const lock = await acquireMigrationLock(db, {
      ...clock,
      onWait,
      pollIntervalMs: 250,
      timeoutMs: 10_000,
    });

    expect(lock.held).toBe(true);
    expect(lock.waitedMs).toBe(500);
    expect(queries).toHaveLength(3);
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
    expect(release).not.toHaveBeenCalled();
    await lock.release();
  });

  it('gives up at the deadline and releases the pinned session', async () => {
    const { db, release } = fakePostgres([]);
    const clock = fakeClock();

    await expect(
      acquireMigrationLock(db, {
        ...clock,
        pollIntervalMs: 400,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    // The last sleep is clamped to the remaining budget, not a full interval.
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([400, 400, 200]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('waits indefinitely when the timeout is 0', async () => {
    const { db } = fakePostgres([...Array(50).fill(false), true]);
    const clock = fakeClock();
    const lock = await acquireMigrationLock(db, {
      ...clock,
      pollIntervalMs: 60_000,
      timeoutMs: 0,
    });
    expect(lock.held).toBe(true);
    expect(lock.waitedMs).toBe(50 * 60_000);
  });

  it('releases the session when the lock query itself fails', async () => {
    const { db, release } = fakePostgres([]);
    const session = await db.acquireSession();
    session.query.mockRejectedValueOnce(new Error('connection reset'));

    await expect(acquireMigrationLock(db)).rejects.toThrow('connection reset');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('refuses a PostgreSQL adapter that cannot pin a session', async () => {
    const db = { url: 'postgres://localhost/app', query: vi.fn() } as any;
    await expect(acquireMigrationLock(db)).rejects.toBeInstanceOf(
      MigrationLockUnsupportedError,
    );
    expect(db.query).not.toHaveBeenCalled();
  });
});
