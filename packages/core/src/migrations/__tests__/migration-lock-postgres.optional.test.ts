/**
 * Issue #3634 — live PostgreSQL semantics of the db:migrate lock. Runs only in
 * the PostgreSQL lane (`pnpm --filter @happyvertical/smrt-core test:postgres`,
 * which supplies `DATABASE_URL`); skipped otherwise.
 *
 * The mock-driven contract is in `migration-lock.test.ts`. Only a real server
 * proves what production relies on: a second process really waits behind the
 * first, really acquires once the first releases, and a holder whose
 * connection dies (a crashed or killed migrator) never strands the lock.
 */

import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acquireMigrationLock,
  MIGRATION_ADVISORY_LOCK_KEYS,
  MigrationLockLostError,
  MigrationLockTimeoutError,
} from '../migration-lock.js';
import type { DatabaseInterface } from '../types.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('db:migrate advisory lock (real PostgreSQL)', () => {
  // Two pools stand in for two processes: advisory locks are per session,
  // so separate pools contend exactly as separate pods would.
  let first: DatabaseInterface;
  let second: DatabaseInterface;

  beforeAll(async () => {
    first = (await getDatabase({
      type: 'postgres',
      url: pgUrl as string,
    })) as DatabaseInterface;
    second = (await getDatabase({
      type: 'postgres',
      url: pgUrl as string,
    })) as DatabaseInterface;
  });

  afterAll(async () => {
    await first?.close?.();
    await second?.close?.();
  });

  it('makes a second runner wait until the first releases', async () => {
    const holder = await acquireMigrationLock(first);
    expect(holder.held).toBe(true);

    let waited = false;
    let acquired = false;
    const contender = acquireMigrationLock(second, {
      pollIntervalMs: 50,
      timeoutMs: 10_000,
      onWait: () => {
        waited = true;
      },
    }).then((lock) => {
      acquired = true;
      return lock;
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(waited).toBe(true);
    expect(acquired).toBe(false);

    await holder.release();
    const lock = await contender;
    expect(lock.held).toBe(true);
    expect(lock.waitedMs).toBeGreaterThan(0);
    await lock.release();

    // Released means free for anyone: a fresh try succeeds immediately.
    const again = await acquireMigrationLock(first, { timeoutMs: 1000 });
    expect(again.waitedMs).toBe(0);
    await again.release();
  });

  it('times out instead of waiting forever behind a live holder', async () => {
    const holder = await acquireMigrationLock(first);
    try {
      await expect(
        acquireMigrationLock(second, { pollIntervalMs: 50, timeoutMs: 300 }),
      ).rejects.toBeInstanceOf(MigrationLockTimeoutError);
    } finally {
      await holder.release();
    }
  });

  it('is freed when the holding connection dies without releasing', async () => {
    const holder = await acquireMigrationLock(first);
    // Find the backend holding the lock and terminate it, as a SIGKILLed
    // migrator's dropped TCP connection would.
    const held = await second.query(
      `SELECT pid FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND classid = (hashtext('smrt'))::oid
          AND objid = (hashtext('db:migrate'))::oid`,
    );
    expect(held.rows).toHaveLength(1);
    await second.query('SELECT pg_terminate_backend($1)', [held.rows[0].pid]);

    const lock = await acquireMigrationLock(second, {
      pollIntervalMs: 50,
      timeoutMs: 5000,
    });
    expect(lock.held).toBe(true);
    // The original holder must notice it no longer has exclusivity.
    await expect(holder.assertHeld()).rejects.toBeInstanceOf(
      MigrationLockLostError,
    );
    await expect(lock.assertHeld()).resolves.toBeUndefined();
    await lock.release();
    // The holder's release on a dead connection must not throw.
    await holder.release();
  });

  it('survives a server idle_session_timeout while the run is busy elsewhere', async () => {
    // Every connection in this pool is reaped after 1s idle, as a role- or
    // database-level idle_session_timeout would do in production.
    const url = new URL(pgUrl as string);
    url.searchParams.set('options', '-c idle_session_timeout=1000');
    const reaping = (await getDatabase({
      type: 'postgres',
      url: url.toString(),
      dbid: 'migration-lock-idle-timeout',
    } as any)) as DatabaseInterface;
    try {
      const lock = await acquireMigrationLock(reaping);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await expect(lock.assertHeld()).resolves.toBeUndefined();
      await lock.release();
    } finally {
      await reaping.close?.();
    }
  });

  it('uses the documented lock keys', async () => {
    const lock = await acquireMigrationLock(first);
    try {
      const probe = await second.query(
        `SELECT pg_try_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEYS}) AS free`,
      );
      expect(probe.rows[0].free).toBe(false);
    } finally {
      await lock.release();
    }
  });
});
