import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BackfillTableUnavailableError,
  BackfillTracker,
} from './backfill-tracker.js';

describe('BackfillTracker', () => {
  let db: DatabaseInterface;
  let tracker: BackfillTracker;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new BackfillTracker({ db });
  });

  afterEach(async () => {
    const maybeClose = (db as { close?: () => Promise<void> } | undefined)
      ?.close;
    if (typeof maybeClose === 'function') {
      try {
        await maybeClose.call(db);
      } catch {
        // Ignore close errors — mirrors the pattern in differ.test.ts.
      }
    }
  });

  it('returns false for a never-applied backfill', async () => {
    expect(await tracker.isApplied('never')).toBe(false);
  });

  it('records and reads back applied backfills', async () => {
    await tracker.recordApplied('first');
    await tracker.recordApplied('second', {
      description: 'second backfill',
      packageName: '@example/app',
    });
    expect(await tracker.isApplied('first')).toBe(true);
    expect(await tracker.isApplied('second')).toBe(true);
    expect(await tracker.isApplied('third')).toBe(false);

    const list = await tracker.listApplied();
    expect(list.map((r) => r.name)).toEqual(['first', 'second']);
    expect(list[1]).toMatchObject({
      description: 'second backfill',
      packageName: '@example/app',
    });
  });

  it('recordApplied is idempotent', async () => {
    await tracker.recordApplied('only-once');
    await tracker.recordApplied('only-once', {
      description: 'attempted again',
    });
    const list = await tracker.listApplied();
    expect(list).toHaveLength(1);
  });

  it('listApplied uses a stable secondary sort when timestamps tie', async () => {
    await tracker.recordApplied('zeta');
    await tracker.recordApplied('alpha');
    await tracker.recordApplied('mu');

    // Force a same-timestamp tie so secondary ORDER BY behavior is deterministic.
    await db.query(
      `UPDATE _smrt_backfills SET applied_at = '2026-01-01 00:00:00'`,
    );

    const list = await tracker.listApplied();
    expect(list.map((row) => row.name)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('runIfPending runs only the first time and reports ran:false on subsequent calls', async () => {
    let runCount = 0;
    const result1 = await tracker.runIfPending('first', async () => {
      runCount += 1;
      return 'ok';
    });
    expect(result1).toEqual({ ran: true, result: 'ok' });
    expect(runCount).toBe(1);

    const result2 = await tracker.runIfPending('first', async () => {
      runCount += 1;
      return 'again';
    });
    expect(result2).toEqual({ ran: false, result: null });
    expect(runCount).toBe(1);
  });

  it('runIfPending discriminates "ran and returned null" from "already applied"', async () => {
    // Documented footgun from the previous `T | null` shape — fn returning
    // null is now unambiguous via the `ran` discriminator.
    const first = await tracker.runIfPending('null-returner', async () => null);
    expect(first).toEqual({ ran: true, result: null });

    const second = await tracker.runIfPending(
      'null-returner',
      async () => null,
    );
    expect(second).toEqual({ ran: false, result: null });
    // Different `ran` flag distinguishes the two cases even though both
    // have `result: null`.
    expect(first.ran).not.toBe(second.ran);
  });

  it('listApplied returns the raw timestamp string when applied_at is unparseable', async () => {
    // Some drivers (or a corrupted row) can return a non-ISO timestamp.
    // Before normalization, `new Date(garbage).toISOString()` threw
    // RangeError and crashed the caller; now we fall back to the raw
    // string so the listing still returns something usable.
    await tracker.recordApplied('a');
    await db.query(
      `UPDATE _smrt_backfills SET applied_at = 'not a timestamp' WHERE name = 'a'`,
    );
    const list = await tracker.listApplied();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('a');
    expect(list[0].appliedAt).toBe('not a timestamp');
  });

  it('listApplied normalizes SQLite-style timestamps to ISO 8601', async () => {
    // SQLite CURRENT_TIMESTAMP returns 'YYYY-MM-DD HH:MM:SS' (no T, no TZ).
    // V8 parses this as local time; the normalizer should turn it into a
    // valid ISO string without throwing.
    await tracker.recordApplied('b');
    await db.query(
      `UPDATE _smrt_backfills SET applied_at = '2026-01-01 12:34:56' WHERE name = 'b'`,
    );
    const list = await tracker.listApplied();
    expect(list).toHaveLength(1);
    // Must parse as a valid ISO string ending in Z (UTC).
    expect(list[0].appliedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('initialize is safe to call repeatedly', async () => {
    await tracker.initialize();
    await tracker.initialize();
    await tracker.recordApplied('still-works');
    expect(await tracker.isApplied('still-works')).toBe(true);
  });

  it('initialize is safe under concurrent calls — DDL runs once', async () => {
    // Wrap the underlying query so we can count how many times the
    // CREATE TABLE actually fires. Pre-memoization, two concurrent
    // initialize() calls both observed `initialized === false` and both
    // ran the DDL; now they should share the same in-flight promise.
    let createCalls = 0;
    const originalQuery = db.query.bind(db);
    db.query = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('CREATE TABLE') && sql.includes('_smrt_backfills')) {
        createCalls += 1;
      }
      return originalQuery(sql as unknown as string, ...(args as []));
    }) as unknown as typeof db.query;

    const freshTracker = new BackfillTracker({ db });
    await Promise.all([
      freshTracker.initialize(),
      freshTracker.initialize(),
      freshTracker.initialize(),
      freshTracker.initialize(),
    ]);

    expect(createCalls).toBe(1);

    // Restore for the afterEach close.
    db.query = originalQuery as typeof db.query;
  });

  it('shares initialization across tracker instances for one database client', async () => {
    let createCalls = 0;
    const originalQuery = db.query.bind(db);
    db.query = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('CREATE TABLE') && sql.includes('_smrt_backfills')) {
        createCalls += 1;
      }
      return originalQuery(sql as unknown as string, ...(args as []));
    }) as unknown as typeof db.query;

    await Promise.all([
      new BackfillTracker({ db }).initialize(),
      new BackfillTracker({ db }).initialize(),
      new BackfillTracker({ db }).initialize(),
    ]);

    expect(createCalls).toBe(1);
    db.query = originalQuery as typeof db.query;
  });

  it('does not cache transaction-local DDL that is later rolled back', async () => {
    const transaction = db.transaction;
    if (!transaction)
      throw new Error('SQLite test database requires transaction().');

    await expect(
      transaction.call(db, async (tx) => {
        await new BackfillTracker({ db: tx }).initialize();
        throw new Error('roll back tracker initialization');
      }),
    ).rejects.toThrow('roll back tracker initialization');

    const freshTracker = new BackfillTracker({ db });
    await expect(freshTracker.isApplied('after-rollback')).resolves.toBe(false);
  });

  it('skips transaction DDL after inheriting durable root initialization', async () => {
    await tracker.recordApplied('root-ready');
    const transaction = db.transaction;
    if (!transaction)
      throw new Error('SQLite test database requires transaction().');

    await transaction.call(db, async (tx) => {
      let transactionCreates = 0;
      const observedTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property === 'query') {
            return async (sql: string, ...params: unknown[]) => {
              if (
                sql.includes('CREATE TABLE') &&
                sql.includes('_smrt_backfills')
              ) {
                transactionCreates += 1;
              }
              return target.query(sql, ...params);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      BackfillTracker.inheritInitialization(observedTx, db);

      await expect(
        new BackfillTracker({ db: observedTx }).isApplied('root-ready'),
      ).resolves.toBe(true);
      expect(transactionCreates).toBe(0);
    });
  });

  it('does not reuse initialization across fresh clients with the same URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smrt-backfill-tracker-'));
    const url = join(directory, 'tracker.sqlite');
    const firstDb = await getDatabase({
      type: 'sqlite',
      url,
      dbid: 'backfill-same-url-first',
    });
    let secondDb: DatabaseInterface | undefined;

    try {
      await new BackfillTracker({ db: firstDb }).initialize();
      await firstDb.query('DROP TABLE _smrt_backfills');
      await closeDatabase(firstDb);

      secondDb = await getDatabase({
        type: 'sqlite',
        url,
        dbid: 'backfill-same-url-second',
      });
      await expect(
        new BackfillTracker({ db: secondDb }).isApplied('fresh-client'),
      ).resolves.toBe(false);
    } finally {
      await closeDatabase(secondDb);
      await closeDatabase(firstDb);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it('reinitializes after the table is dropped on the same client', async () => {
    await tracker.initialize();
    await db.query('DROP TABLE _smrt_backfills');

    await tracker.initialize();
    await expect(
      new BackfillTracker({ db }).isApplied('same-client-reset'),
    ).resolves.toBe(false);
  });

  it('invalidates the root cache when an inherited transaction finds the table missing', async () => {
    await tracker.initialize();
    await db.query('DROP TABLE _smrt_backfills');
    const transaction = db.transaction;
    if (!transaction)
      throw new Error('SQLite test database requires transaction().');

    await expect(
      transaction.call(db, async (tx) => {
        BackfillTracker.inheritInitialization(tx, db);
        return new BackfillTracker({ db: tx }).isApplied('missing-in-tx');
      }),
    ).rejects.toBeInstanceOf(BackfillTableUnavailableError);

    await expect(
      new BackfillTracker({ db }).isApplied('root-recovers'),
    ).resolves.toBe(false);
  });

  it('initialize allows retry after a failed CREATE TABLE', async () => {
    let attempts = 0;
    const originalQuery = db.query.bind(db);
    db.query = ((sql: string, ...args: unknown[]) => {
      if (sql.includes('CREATE TABLE') && sql.includes('_smrt_backfills')) {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error('transient failure'));
        }
      }
      return originalQuery(sql as unknown as string, ...(args as []));
    }) as unknown as typeof db.query;

    const freshTracker = new BackfillTracker({ db });
    await expect(freshTracker.initialize()).rejects.toThrow(
      'transient failure',
    );
    // The promise slot was cleared on error — a second call must retry,
    // not return a permanently-rejected memoized promise.
    await expect(freshTracker.initialize()).resolves.toBeUndefined();
    expect(attempts).toBe(2);

    db.query = originalQuery as typeof db.query;
  });
});

async function closeDatabase(
  database: DatabaseInterface | undefined,
): Promise<void> {
  const close = (
    database as
      | (DatabaseInterface & { close?: () => Promise<void> })
      | undefined
  )?.close;
  if (close) await close.call(database).catch(() => undefined);
}
