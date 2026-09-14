/**
 * Concurrency repro for the recall finding on #2861 review Finding 3's fix
 * (bootstrap.ts `isOpenTransactionHandle()` branch).
 *
 * Making `runSerializedAgainstSystemTableBootstrap()` pass an already-open
 * transaction handle straight through to `work()` (no lock at all) fixed the
 * lock/timeout leak into `createIsolatedTestDb()`'s caller transaction, but
 * an independent reviewer correctly flagged that it reopened the original
 * #2861 race for any OTHER caller that hands this helper two or more
 * separately-opened, caller-owned transactions against a still-cold
 * database: `createIsolatedTestDb()` happens to provision system tables on
 * its base connection before opening the transaction it returns, but that is
 * that one caller's contract, not a rule this helper can assume holds for
 * every caller — `DispatchBusOptions.db`/`DatabaseInterface` place no such
 * restriction on what may be passed.
 *
 * This suite reproduces exactly that: several independently-opened
 * PostgreSQL transactions (via `db.beginTransaction()`, not
 * `createIsolatedTestDb()`) each call `createDispatchBus()` concurrently
 * against freshly-dropped `_smrt_dispatch*` tables, with no prior
 * provisioning, then end their own transaction promptly afterward (the
 * realistic shape: a caller that holds its transaction open forever will
 * make any other transaction's *ordinary* PostgreSQL catalog lock on the
 * same not-yet-committed DDL wait for it regardless of what this helper
 * does — that is inherent to MVCC, not something an advisory lock can
 * paper over, which is why the fix takes the lock directly on the caller's
 * own transaction rather than a separately-scoped one; see bootstrap.ts).
 * All must succeed. Runs only in the disposable PostgreSQL lane
 * (`SMRT_TEST_POSTGRES_URL`, see `scripts/run-with-ci-postgres.mjs`).
 */

import type { DatabaseInterface, TransactionHandle } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatchBus } from './bus.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

const CONCURRENT_OPEN_TRANSACTIONS = 12;

postgresDescribe(
  'DispatchBus concurrent caller-owned transaction handles (#2861 recall)',
  () => {
    let db: DatabaseInterface & {
      beginTransaction: () => Promise<TransactionHandle>;
    };

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
      })) as typeof db;
    });

    afterAll(async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
      if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
        await (db as unknown as { close: () => Promise<void> }).close();
      }
    });

    it('does not race when several independently-opened transaction handles bootstrap dispatch concurrently against a cold database', async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');

      // Each attempt opens its own transaction, bootstraps dispatch on it,
      // and ends that transaction promptly afterward — the realistic shape
      // of "several independent callers each pass DispatchBus their own
      // open transaction." A caller that holds its transaction open forever
      // instead would make any other transaction's *ordinary* PostgreSQL
      // catalog lock on the same not-yet-committed DDL wait for it
      // regardless of what this helper does — inherent to MVCC, not a race
      // this suite is trying to characterize.
      async function attempt(): Promise<void> {
        const handle = await db.beginTransaction();
        try {
          await createDispatchBus({ db: handle });
        } finally {
          if (handle.isActive()) await handle.rollback();
        }
      }

      const attempts = Array.from(
        { length: CONCURRENT_OPEN_TRANSACTIONS },
        () => attempt(),
      );
      const results = await Promise.allSettled(attempts);
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      );

      if (failures.length > 0) {
        const messages = failures
          .map((failure) =>
            failure.reason instanceof Error
              ? failure.reason.message
              : String(failure.reason),
          )
          .join('\n---\n');
        throw new Error(
          `${failures.length}/${CONCURRENT_OPEN_TRANSACTIONS} concurrent caller-owned-transaction DispatchBus initializations failed:\n${messages}`,
        );
      }
      expect(failures).toHaveLength(0);
    }, 35_000);
  },
);
