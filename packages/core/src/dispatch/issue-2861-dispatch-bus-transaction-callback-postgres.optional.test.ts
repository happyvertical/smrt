/**
 * Regression for the second final-review finding on #2861 review Finding 3's
 * fix (bootstrap.ts `runSerializedAgainstSystemTableBootstrap()`).
 *
 * The `@happyvertical/sql` PostgreSQL adapter produces two different
 * "already inside a transaction" handle shapes: `beginTransaction()`'s
 * returned handle (carries `commit`/`rollback`/`isActive`, covered by
 * `issue-2429-postgres-system-tables.optional.test.ts` and
 * `issue-2861-dispatch-bus-concurrent-transaction-handles-postgres.optional.test.ts`)
 * and the callback argument of `db.transaction(async (tx) => ...)`, which
 * carries neither `commit`/`rollback` nor `beginTransaction()`. An
 * independent reviewer found the first fix for Finding 3 detected only the
 * former shape, so `db.transaction(cb)` callers still hit the original
 * leak: the timeout/lock taken to serialize the bootstrap would be raised
 * via `SET LOCAL` on the caller's transaction and never reset. Reachable via
 * any `SmrtClass`/`Agent`/`DispatchBus` constructed with `db: tx` inside a
 * `db.transaction(async (tx) => ...)` callback — a documented pattern
 * (`packages/vitest/src/test-db.ts`).
 *
 * This suite exercises exactly that callback shape directly against
 * `createDispatchBus()`. Runs only in the disposable PostgreSQL lane
 * (`SMRT_TEST_POSTGRES_URL`, see `scripts/run-with-ci-postgres.mjs`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatchBus } from './bus.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

const CONCURRENT_TRANSACTION_CALLBACKS = 6;

postgresDescribe(
  'DispatchBus inside a db.transaction(callback) handle (#2861 second final-review finding)',
  () => {
    let db: DatabaseInterface & {
      transaction: <T>(
        callback: (tx: DatabaseInterface) => Promise<T>,
      ) => Promise<T>;
    };

    beforeAll(async () => {
      db = (await getDatabase({ type: 'postgres', url: pgUrl })) as typeof db;
    });

    afterAll(async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
      if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
        await (db as unknown as { close: () => Promise<void> }).close();
      }
    });

    it('bootstraps dispatch inside db.transaction(callback) without leaking the lock/timeout budget onto the caller', async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');

      await db.transaction(async (tx) => {
        const timeoutBefore = rowsOf(await tx.query('SHOW lock_timeout'))[0];

        const bus = await createDispatchBus({ db: tx });
        const dispatch = await bus.emit(
          'issue-2861.transaction-callback-probe',
          { ready: true },
          { source: 'smrt-vitest' },
        );
        expect(await tx.count('_smrt_dispatch', { id: dispatch.id })).toBe(1);

        expect(rowsOf(await tx.query('SHOW lock_timeout'))[0]).toEqual(
          timeoutBefore,
        );
      });
    });

    it('does not race when several concurrent db.transaction(callback) invocations bootstrap dispatch against a cold database', async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');

      const attempts = Array.from(
        { length: CONCURRENT_TRANSACTION_CALLBACKS },
        () =>
          db.transaction(async (tx) => {
            await createDispatchBus({ db: tx });
          }),
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
          `${failures.length}/${CONCURRENT_TRANSACTION_CALLBACKS} concurrent db.transaction(callback) DispatchBus initializations failed:\n${messages}`,
        );
      }
      expect(failures).toHaveLength(0);
    }, 35_000);
  },
);
