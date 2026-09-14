/**
 * Engine-detection regression for #2861 review (bus.ts:189-197).
 *
 * `DispatchBus.initialize()` bootstraps its dispatch tables inside the
 * advisory-locked transaction `runSerializedAgainstSystemTableBootstrap()`
 * opens. That helper hands the callback the *lock-holding transaction*
 * handle, not `this.db`. A `DatabaseInterface`/`TransactionHandle` is not
 * guaranteed to carry the same `url`/`type` (or `config.url`/`config.type` —
 * the structural fallback `getDatabaseEngine()` already supports for
 * adapters that expose their connection string on `config` instead of
 * `url`, see `packages/core/src/system/compatibility.ts`) that the outer
 * handle used to decide `postgres` in the first place. Recomputing the
 * engine on that transaction handle can silently disagree with the outer
 * decision: `detectEngine('', undefined)` falls back to `sqlite`, which
 * would create the dispatch tables with `TIMESTAMP` instead of
 * `TIMESTAMPTZ` and skip the PostgreSQL timestamp guard entirely.
 *
 * This suite wraps a real PostgreSQL connection in a `config.url`-style
 * adapter whose `beginTransaction()`/`transaction()` return a handle that
 * deliberately does not carry `url`/`type`/`config` — the shape the review
 * comment describes — and proves the dispatch tables still materialize as
 * `TIMESTAMPTZ` (i.e. the resolved engine inside the lock is `postgres`,
 * not the `sqlite` fallback), rather than trusting static inspection of the
 * fix. Runs only in the disposable PostgreSQL lane
 * (`SMRT_TEST_POSTGRES_URL`, see `scripts/run-with-ci-postgres.mjs`).
 */

import type { DatabaseInterface, TransactionHandle } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDispatchBus } from './bus.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

/**
 * Strip the engine-detection hints (`url`, `type`, `config`) a transaction
 * handle would otherwise inherit, while leaving every other method — the
 * ones DispatchBus actually uses to read/write — delegating to the real
 * handle. Simulates the "transaction view is not guaranteed to expose
 * `url`/`type`" adapter shape the review comment describes.
 */
function stripEngineHints<T extends object>(handle: T): T {
  return new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === 'url') return '';
      if (prop === 'type' || prop === 'config') return undefined;
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Wrap a real PostgreSQL `DatabaseInterface` so the outer handle exposes its
 * connection string only via `config.url`/`config.type` (the documented
 * "adapters that expose the URL on `db.config?.url`" shape,
 * `packages/core/src/migrations/orchestrate.ts:270`) — never `url`/`type`
 * directly — while any transaction handle it opens has those hints
 * stripped entirely. `getDatabaseEngine()` must resolve `postgres` from the
 * outer handle without help from `url`; the transaction it opens for the
 * bootstrap lock carries no engine hints at all, so anything computed from
 * that handle (rather than the outer handle it was opened from) falls back
 * to `sqlite`.
 */
function wrapAsConfigOnlyAdapter(
  db: DatabaseInterface,
  url: string,
): DatabaseInterface {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'url') return '';
      if (prop === 'type') return undefined;
      if (prop === 'config') return { url, type: 'postgres' };
      if (prop === 'beginTransaction') {
        const original = (
          target as DatabaseInterface & {
            beginTransaction?: () => Promise<TransactionHandle>;
          }
        ).beginTransaction;
        if (typeof original !== 'function') return undefined;
        return async () => stripEngineHints(await original.call(target));
      }
      if (prop === 'transaction') {
        const original = (
          target as DatabaseInterface & {
            transaction?: <T>(
              callback: (tx: DatabaseInterface) => Promise<T>,
            ) => Promise<T>;
          }
        ).transaction;
        if (typeof original !== 'function') return undefined;
        return async <T>(callback: (tx: DatabaseInterface) => Promise<T>) =>
          original.call(target, (tx: DatabaseInterface) =>
            callback(stripEngineHints(tx)),
          );
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as DatabaseInterface;
}

async function dispatchTimestampColumnTypes(
  db: DatabaseInterface,
): Promise<Record<string, unknown>[]> {
  const result = await db.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('_smrt_dispatch', '_smrt_dispatch_subscriptions')
      AND data_type LIKE 'timestamp%'
    ORDER BY table_name, column_name
  `);
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

postgresDescribe(
  'DispatchBus engine detection inside the bootstrap lock (#2861)',
  () => {
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

    it('materializes TIMESTAMPTZ dispatch columns even when the lock-scoped transaction handle carries no url/type hints', async () => {
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
      await db.query('DROP TABLE IF EXISTS _smrt_dispatch');

      const configOnlyDb = wrapAsConfigOnlyAdapter(db, pgUrl as string);

      await createDispatchBus({ db: configOnlyDb });

      const columns = await dispatchTimestampColumnTypes(db);
      expect(columns.length).toBeGreaterThan(0);
      expect(new Set(columns.map((column) => column.data_type))).toEqual(
        new Set(['timestamp with time zone']),
      );
    });
  },
);
