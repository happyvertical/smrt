/**
 * Change-feed sequence retries run on a time budget, not a fixed attempt cap
 * (#5271).
 *
 * A writer that loses the `MAX(seq) + 1` race retries until a monotonic
 * deadline passes (with the old attempt count as a floor), so a burst of
 * conflicts no longer drops the entry after a fixed number of rounds. When the
 * budget does run out, the thrown error keeps the database code, carries the
 * last database error as its `cause`, and repeats its diagnostic in the
 * message, because the rate-limited append warning logs only the message.
 *
 * A serialization failure (`40001`) is not sequence contention: a retry inside
 * the same fixed-snapshot transaction cannot succeed, so it is thrown on the
 * first attempt.
 *
 * The drain spends the budget only on conflicting passes; successful passes
 * stay capped, so a busy writer still cannot keep one reader draining forever.
 *
 * Stub handles, so this runs in the default lane without PostgreSQL.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  appendChanges,
  drainChangeFeed,
  resetChangeFeedWarnings,
} from '../change-feed';
import { getTestDatabase } from '../testing/database';

const BUDGET_MS = 2_000;

function uniqueViolation(): Error & { code: string } {
  return Object.assign(
    new Error('UNIQUE constraint failed: _smrt_changes.seq'),
    { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' },
  );
}

/**
 * A PostgreSQL-dialect stub. `appendResult(call)` decides what each call of
 * the append helpers returns; drains return `drainResult(call)`.
 */
function postgresStub(options: {
  appendResult: (call: number) => Record<string, unknown>[];
  batchResult?: (call: number) => Record<string, unknown>[];
  drainResult?: (call: number) => Record<string, unknown>[];
}): DatabaseInterface & {
  calls: { append: number; batch: number; drain: number };
} {
  const calls = { append: 0, batch: 0, drain: 0 };
  return {
    url: `postgres://stub-5271/${Math.random().toString(36).slice(2)}`,
    calls,
    query: async (sql: string) => {
      if (sql.includes('_smrt_append_changes(')) {
        calls.batch += 1;
        return options.batchResult?.(calls.batch) ?? [];
      }
      if (sql.includes('_smrt_append_change(')) {
        calls.append += 1;
        return options.appendResult(calls.append);
      }
      if (sql.includes('_smrt_drain_changes(')) {
        calls.drain += 1;
        return options.drainResult?.(calls.drain) ?? [];
      }
      if (sql.includes('pg_current_xact_id_if_assigned() IS NULL')) {
        return [{ committed: true }];
      }
      return [];
    },
  } as unknown as DatabaseInterface & {
    calls: { append: number; batch: number; drain: number };
  };
}

const conflictRow = {
  allocated_seq: null,
  error_code: '23505',
  error_message:
    'duplicate key value violates unique constraint "_smrt_changes_pkey"',
};

describe('change-feed sequence retry budget (#5271)', () => {
  beforeEach(() => {
    resetChangeFeedWarnings();
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('appendChange succeeds after more conflicts than the old attempt cap', async () => {
    const db = postgresStub({
      appendResult: (call) =>
        call <= 25
          ? [conflictRow]
          : [{ allocated_seq: 7, error_code: null, error_message: null }],
    });
    const pending = appendChange(db, { table: 'budget_notes', rowId: 'a' });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await expect(pending).resolves.toBe(7);
    expect(db.calls.append).toBe(26);
  });

  it('appendChanges succeeds after more conflicts than the old attempt cap', async () => {
    const db = postgresStub({
      appendResult: () => [],
      batchResult: (call) =>
        call <= 25
          ? [{ entry_index: null, ...conflictRow }]
          : [
              {
                entry_index: 0,
                allocated_seq: 3,
                error_code: null,
                error_message: null,
              },
              {
                entry_index: 1,
                allocated_seq: 4,
                error_code: null,
                error_message: null,
              },
            ],
    });
    const pending = appendChanges(db, [
      { table: 'budget_notes', rowId: 'a' },
      { table: 'budget_notes', rowId: 'b' },
    ]);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await expect(pending).resolves.toEqual([3, 4]);
    expect(db.calls.batch).toBe(26);
  });

  it('gives up once the budget is spent, keeping the code, cause and diagnostic', async () => {
    const db = postgresStub({ appendResult: () => [conflictRow] });
    const pending = appendChange(db, { table: 'budget_notes', rowId: 'a' });
    const settled = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 3);
    const error = (await settled) as Error & { code?: string; cause?: Error };
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('23505');
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error & { code?: string }).code).toBe('23505');
    // The append warning logs only `error.message`, so the database's own
    // diagnostic has to survive in it.
    expect(error.message).toContain('retry budget');
    expect(error.message).toContain(
      'duplicate key value violates unique constraint',
    );
    // A time budget, with the old attempt count as a floor.
    expect(db.calls.append).toBeGreaterThan(20);
  });

  it('does not retry a serialization failure', async () => {
    const db = postgresStub({
      appendResult: () => [
        {
          allocated_seq: null,
          error_code: '40001',
          error_message:
            'could not serialize access due to read/write dependencies among transactions',
        },
      ],
    });
    const settled = appendChange(db, {
      table: 'budget_notes',
      rowId: 'a',
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    const error = (await settled) as Error & { code?: string };
    expect(error?.code).toBe('40001');
    expect(db.calls.append).toBe(1);
  });

  it('a settling drain charges only conflicting passes to the budget', async () => {
    const db = postgresStub({
      appendResult: () => [],
      drainResult: () => [
        {
          drained_seq: null,
          error_code: '23505',
          error_message:
            'duplicate key value violates unique constraint "_smrt_changes_pkey"',
        },
      ],
    });
    const pending = drainChangeFeed(db);
    await vi.advanceTimersByTimeAsync(BUDGET_MS * 3);
    await expect(pending).resolves.toBe(0);
    // More conflicting passes than the 50-pass cap: they spend time, not
    // passes.
    expect(db.calls.drain).toBeGreaterThan(50);
  });

  it('time spent on successful drain passes does not shorten the conflict budget', async () => {
    const SLOW_PASSES = 3;
    const PASS_MS = 1_000;
    const CONFLICT_MS = 20;
    let conflicts = 0;
    const db = postgresStub({
      appendResult: () => [],
      drainResult: () => [],
    });
    // Three slow successful passes (3 s, beyond the 2 s budget), then a
    // stream of conflicts that each take 20 ms.
    (db as { query: DatabaseInterface['query'] }).query = (async (
      sql: string,
    ) => {
      if (!sql.includes('_smrt_drain_changes(')) {
        return sql.includes('pg_current_xact_id_if_assigned() IS NULL')
          ? [{ committed: true }]
          : [];
      }
      db.calls.drain += 1;
      if (db.calls.drain <= SLOW_PASSES) {
        await new Promise((resolve) => setTimeout(resolve, PASS_MS));
        return [
          {
            drained_seq: db.calls.drain,
            drained_table: 'budget_notes',
            drained_row_id: String(db.calls.drain),
            drained_operation: 'update',
            drained_tenant_id: null,
            error_code: null,
            error_message: null,
          },
        ];
      }
      conflicts += 1;
      await new Promise((resolve) => setTimeout(resolve, CONFLICT_MS));
      return [{ drained_seq: null, ...conflictRow }];
    }) as unknown as DatabaseInterface['query'];

    const pending = drainChangeFeed(db);
    await vi.advanceTimersByTimeAsync(SLOW_PASSES * PASS_MS + BUDGET_MS * 3);
    await expect(pending).resolves.toBe(SLOW_PASSES);
    // Charged from the clock since the drain began, the 3 s of successful
    // passes would leave only the 20-attempt floor. Charged per conflict,
    // the budget allows at least 2000 / (20 + 40) conflicting passes.
    expect(conflicts).toBeGreaterThanOrEqual(
      Math.floor(BUDGET_MS / (CONFLICT_MS + 40)),
    );
    expect(conflicts).toBeLessThanOrEqual(
      Math.ceil(BUDGET_MS / CONFLICT_MS) + 1,
    );
  });

  it('a settling drain still caps successful passes', async () => {
    let next = 0;
    const db = postgresStub({
      appendResult: () => [],
      drainResult: () => {
        next += 1;
        return [
          {
            drained_seq: next,
            drained_table: 'budget_notes',
            drained_row_id: String(next),
            drained_operation: 'update',
            drained_tenant_id: null,
            error_code: null,
            error_message: null,
          },
        ];
      },
    });
    const pending = drainChangeFeed(db);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await expect(pending).resolves.toBe(50);
    expect(db.calls.drain).toBe(50);
  });

  it('the write-path drain stays one statement on a conflict', async () => {
    const db = postgresStub({
      appendResult: () => [
        { allocated_seq: 9, error_code: null, error_message: null },
      ],
      drainResult: () => [
        {
          drained_seq: null,
          error_code: '23505',
          error_message: 'duplicate key value',
        },
      ],
    });
    const pending = appendChange(db, { table: 'budget_notes', rowId: 'a' });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await expect(pending).resolves.toBe(9);
    expect(db.calls.drain).toBe(1);
  });
});

describe('change-feed retry budget on SQLite (#5271)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    resetChangeFeedWarnings();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.close?.();
  });

  it('appendChange survives more conflicts than the old attempt cap', async () => {
    const original = db.query.bind(db);
    let conflicts = 25;
    let attempts = 0;
    (db as { query: DatabaseInterface['query'] }).query = (async (
      sql: string,
      ...params: unknown[]
    ) => {
      if (/^INSERT INTO _smrt_changes\b/.test(sql)) {
        attempts += 1;
        if (conflicts > 0) {
          conflicts -= 1;
          throw uniqueViolation();
        }
      }
      return original(sql, ...params);
    }) as DatabaseInterface['query'];

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
    });
    const pending = appendChange(db, { table: 'budget_notes', rowId: 'a' });
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    await expect(pending).resolves.toBe(1);
    expect(attempts).toBe(26);
  });
});
