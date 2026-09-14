/**
 * Regression for the third final-review finding on #2861 review Finding 3's
 * fix (bootstrap.ts's caller-owned-transaction branch).
 *
 * Every framework-owned PostgreSQL connection is built through
 * `applyPostgresRuntimeTimeouts()` (wired into `SmrtClass`,
 * `createDispatchBus`'s own `getDatabase()` path, and the generators),
 * which bakes a request-sized `lock_timeout=10000ms` into the connection by
 * default. The caller-owned-transaction branch added for #2861 review
 * Finding 3 took `pg_advisory_xact_lock` directly on the caller's session
 * with no budget of its own — so once one caller held the bootstrap lock
 * for longer than the *next* caller's ambient `lock_timeout`, that next
 * caller aborted with "canceling statement due to lock timeout" instead of
 * waiting: the #2861 symptom class (concurrent `createDispatchBus()` calls
 * failing) returning through the timeout door rather than the catalog-race
 * door, on the very code path this revision added to close the race.
 * `issue-2861-dispatch-bus-concurrent-transaction-handles-postgres.optional.test.ts`
 * did not catch this because it builds connections with bare
 * `getDatabase()`, which inherits PostgreSQL's own `lock_timeout = 0`
 * (unlimited) — every waiter there passes whether or not the branch raises
 * its own budget.
 *
 * This suite builds its connection through the real
 * `applyPostgresRuntimeTimeouts()` path, sets one session's `lock_timeout`
 * even lower than the framework default to force contention quickly, holds
 * the bootstrap lock from a first transaction, and proves a second
 * transaction's `createDispatchBus()` call still succeeds despite its own
 * short ambient timeout — because the branch raises its own budget before
 * waiting and restores it before `work()` runs. Runs only in the disposable
 * PostgreSQL lane (`SMRT_TEST_POSTGRES_URL`, see
 * `scripts/run-with-ci-postgres.mjs`).
 */

import type { DatabaseInterface, TransactionHandle } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPostgresRuntimeTimeouts } from '../postgres-timeouts.js';
import { createDispatchBus } from './bus.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

const BOOTSTRAP_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('smrt'), hashtext('system-tables'))";

postgresDescribe(
  'DispatchBus caller-owned-transaction lock wait under a bounded runtime pool (#2861 third final-review finding)',
  () => {
    let db: DatabaseInterface & {
      beginTransaction: () => Promise<TransactionHandle>;
    };

    beforeAll(async () => {
      // The real framework path — every SmrtClass/DispatchBus connection is
      // built this way — rather than a bare `getDatabase()` call, so this
      // suite exercises the actual default `lock_timeout=10000ms` shape the
      // finding is about.
      const bounded = applyPostgresRuntimeTimeouts({
        type: 'postgres',
        url: pgUrl,
      });
      db = (await getDatabase(
        bounded as Parameters<typeof getDatabase>[0],
      )) as typeof db;
    });

    afterAll(async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
      if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
        await (db as unknown as { close: () => Promise<void> }).close();
      }
    });

    it("waits out a contended bootstrap lock instead of aborting on the second caller's short ambient lock_timeout", async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');

      const holder = await db.beginTransaction();
      const waiter = await db.beginTransaction();
      try {
        // The waiter's own ambient timeout is far shorter than how long the
        // holder will keep the lock — without the branch's internal raise,
        // the waiter's `pg_advisory_xact_lock` would abort well before the
        // holder ever releases it.
        await waiter.query("SET lock_timeout = '500ms'");

        await holder.query(BOOTSTRAP_LOCK_SQL);
        const holdMs = 2_000;
        const released = holder
          .query(`SELECT pg_sleep(${holdMs / 1000})`)
          .then(() => holder.commit());

        const waiterResult = await createDispatchBus({ db: waiter });
        const dispatch = await waiterResult.emit(
          'issue-2861.lock-wait-probe',
          { ready: true },
          { source: 'smrt-vitest' },
        );
        expect(await waiter.count('_smrt_dispatch', { id: dispatch.id })).toBe(
          1,
        );

        await released;
      } finally {
        if (holder.isActive()) await holder.rollback();
        if (waiter.isActive()) await waiter.rollback();
      }
    }, 20_000);
  },
);
