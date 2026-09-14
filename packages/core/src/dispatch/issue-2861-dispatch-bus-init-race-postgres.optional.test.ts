/**
 * Concurrency repro for #2861.
 *
 * `DispatchBus.initialize()` creates/verifies `_smrt_dispatch` and
 * `_smrt_dispatch_subscriptions` without the advisory-lock serialization that
 * `ensureSystemTables()`/`bootstrapSystemTables()` use for every other system
 * table (system/bootstrap.ts). Two or more `DispatchBus` instances
 * initializing concurrently against the same already-warmed PostgreSQL
 * database — exactly what happens across parallel Vitest files/workers that
 * all point at the one shared `SMRT_TEST_POSTGRES_URL` database, or across
 * concurrent `Suasor`/`Agent` instantiations in one process — race on
 * unguarded DDL. Proven below: concurrent `CREATE TABLE IF NOT EXISTS`
 * throws `duplicate key value violates unique constraint
 * "pg_type_typname_nsp_index"`. The same missing serialization also leaves
 * catalog-lock contention (`ALTER TABLE`/`CREATE INDEX`) unguarded, which can
 * plausibly present as a hang under heavier load than this test drives —
 * that variant is not separately reproduced here.
 *
 * This suite runs only in the disposable PostgreSQL lane
 * (`SMRT_TEST_POSTGRES_URL`, see `scripts/run-with-ci-postgres.mjs`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatchBus } from './bus.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

const CONCURRENT_INITIALIZERS = 12;

postgresDescribe('DispatchBus concurrent initialization race (#2861)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
    })) as DatabaseInterface;
  });

  afterAll(async () => {
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as unknown as { close: () => Promise<void> }).close();
    }
  });

  it('does not race when many DispatchBus instances initialize concurrently against a fresh table', async () => {
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch');

    // Multiple independent DispatchBus instances sharing one pooled
    // connection — the same shape as multiple Suasor/Agent instances in one
    // process, or multiple Vitest files against one shared CI database —
    // all racing to bootstrap `_smrt_dispatch` for the first time.
    const attempts = Array.from({ length: CONCURRENT_INITIALIZERS }, () =>
      createDispatchBus({ db }),
    );

    const results = await Promise.allSettled(attempts);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
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
        `${failures.length}/${CONCURRENT_INITIALIZERS} concurrent DispatchBus initializations failed:\n${messages}`,
      );
    }
    expect(failures).toHaveLength(0);
  }, 35_000);

  it('does not race when re-initializing an already-warmed database concurrently', async () => {
    // Warm it up first (sequential, like the first `it()` in a
    // `describe.sequential` block).
    await createDispatchBus({ db });

    // Now many callers re-initialize against the already-warmed table at
    // once — the exact "re-initialization against a warmed Postgres DB"
    // scenario from the issue title.
    const attempts = Array.from({ length: CONCURRENT_INITIALIZERS }, () =>
      createDispatchBus({ db }),
    );
    const results = await Promise.allSettled(attempts);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
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
        `${failures.length}/${CONCURRENT_INITIALIZERS} concurrent re-initializations failed:\n${messages}`,
      );
    }
    expect(failures).toHaveLength(0);
  }, 35_000);
});
