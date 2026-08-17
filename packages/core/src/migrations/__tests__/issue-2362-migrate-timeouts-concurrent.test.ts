/**
 * Issue #2362 — `db:migrate` on PostgreSQL must bound its locks and must be
 * able to build indexes concurrently.
 *
 * Before this change the production path (`applyAll({ atomic: true })`) ran
 * every statement in one transaction with no `lock_timeout` and no
 * `statement_timeout`: an index build queued behind a long-running writer held
 * the locks it had already taken on every earlier table, stalling application
 * writes indefinitely. `--postgres-safe` and the
 * `migrations.postgres.lockTimeout` / `.statementTimeout` config keys were
 * read by nothing.
 *
 * These tests drive the tracker against a recording fake so the exact SQL and
 * the exact connection each statement lands on are observable. The live
 * PostgreSQL behaviour (a lock_timeout that actually fires, an INVALID index
 * that is actually rebuilt) is covered by
 * `issue-2362-postgres-migrate-timeouts.optional.test.ts`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { MigrationDefinition } from '../../schema/types.js';
import { MigrationTracker } from '../tracker.js';

interface RecordedQuery {
  channel: 'pool' | 'transaction' | 'session';
  sql: string;
}

interface FakeDbOptions {
  url?: string;
  /** Provide `acquireSession` (PostgreSQL pools do; SQLite/DuckDB do not). */
  withSession?: boolean;
  /** Index names reported as INVALID by `pg_index.indisvalid = false`. */
  invalidIndexes?: string[];
  /** SQL fragments that should throw when executed. */
  failOn?: Array<{ match: string; message: string }>;
}

interface FakeDb {
  db: any;
  queries: RecordedQuery[];
  /** Migration rows keyed by name, as the tracker would have written them. */
  rows: Map<string, Record<string, unknown>>;
  sessionsOpened: number;
  sessionsReleased: number;
  sqlIn(channel: RecordedQuery['channel']): string[];
}

/**
 * Minimal `_smrt_schema_migrations` stand-in: enough of the tracker's own
 * bookkeeping SQL to observe the status transitions that decide whether a
 * failed concurrent index build is retryable on the next run.
 */
function createFakeDb(options: FakeDbOptions = {}): FakeDb {
  const queries: RecordedQuery[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const invalidIndexes = options.invalidIndexes ?? [];
  const state = { sessionsOpened: 0, sessionsReleased: 0 };

  function maybeFail(sql: string): void {
    const failure = options.failOn?.find((entry) => sql.includes(entry.match));
    if (failure) {
      throw new Error(failure.message);
    }
  }

  function run(
    channel: RecordedQuery['channel'],
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[]; rowCount: number } {
    queries.push({ channel, sql });

    if (sql.includes('pg_index')) {
      return {
        rows: invalidIndexes.map((index_name) => ({ index_name })),
        rowCount: invalidIndexes.length,
      };
    }

    if (sql.includes('SELECT MAX(batch)')) {
      return { rows: [{ max_batch: 0 }], rowCount: 1 };
    }

    if (sql.includes('SELECT * FROM _smrt_schema_migrations WHERE name = ?')) {
      const row = rows.get(String(params[0]));
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.startsWith('INSERT INTO _smrt_schema_migrations')) {
      // (id, name, version, checksum, status, attempts, ...)
      rows.set(String(params[1]), {
        id: params[0],
        name: params[1],
        version: params[2],
        checksum: params[3],
        status: 'running',
        attempts: 1,
        applied_at: new Date().toISOString(),
        is_reversible: 0,
        batch: 1,
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('UPDATE _smrt_schema_migrations')) {
      // Status writes address the row either by `name` (concurrent phase) or
      // by `id` (in-batch writes); the selector is always the last parameter.
      const selector = String(params[params.length - 1]);
      const row = sql.includes('WHERE name = ?')
        ? rows.get(selector)
        : [...rows.values()].find((candidate) => candidate.id === selector);

      if (row) {
        if (sql.includes("status = 'completed'")) {
          row.status = 'completed';
          row.error_message = null;
        } else if (sql.includes("status = 'failed'")) {
          row.status = 'failed';
        } else if (sql.includes("status = 'running'")) {
          row.status = 'running';
        }

        // In every tracker statement that binds `error_message`, it is the
        // last SET placeholder — i.e. the parameter before the selector.
        if (sql.includes('error_message = ?')) {
          row.error_message = params[params.length - 2];
        }
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('SELECT')) {
      return { rows: [], rowCount: 0 };
    }

    maybeFail(sql);
    return { rows: [], rowCount: 0 };
  }

  const db: any = {
    url: options.url ?? 'postgresql://user:pass@localhost:5432/test',
    query: async (sql: string, ...params: unknown[]) =>
      run('pool', sql, params),
    transaction: async (callback: (tx: any) => Promise<unknown>) => {
      const tx = {
        url: options.url ?? 'postgresql://user:pass@localhost:5432/test',
        query: async (sql: string, ...params: unknown[]) =>
          run('transaction', sql, params),
      };
      return callback(tx);
    },
  };

  if (options.withSession !== false) {
    db.acquireSession = async () => {
      state.sessionsOpened++;
      return {
        query: async (sql: string, ...params: unknown[]) =>
          run('session', sql, params),
        isActive: () => true,
        release: async () => {
          state.sessionsReleased++;
        },
      };
    };
  }

  return {
    db,
    queries,
    rows,
    get sessionsOpened() {
      return state.sessionsOpened;
    },
    get sessionsReleased() {
      return state.sessionsReleased;
    },
    sqlIn(channel) {
      return queries
        .filter((entry) => entry.channel === channel)
        .map((entry) => entry.sql);
    },
  };
}

function definition(id: string, up: string[]): MigrationDefinition {
  return { id, description: id, version: '1.0.0', up, down: [] };
}

const addColumn = definition('add_column_jobs_status', [
  'ALTER TABLE "jobs" ADD COLUMN "status" TEXT',
]);
const addIndex = definition('add_index_jobs_status_idx', [
  'CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
]);
const addSecondIndex = definition('add_index_jobs_run_at_idx', [
  'CREATE INDEX IF NOT EXISTS "jobs_run_at_idx" ON "jobs" ("run_at")',
]);

describe('atomic PostgreSQL migrations are bounded by timeouts (issue #2362)', () => {
  let fake: FakeDb;

  beforeEach(() => {
    fake = createFakeDb();
  });

  it('sets lock_timeout and statement_timeout inside the atomic transaction', async () => {
    const tracker = new MigrationTracker({
      db: fake.db,
      lockTimeout: 7000,
      statementTimeout: 9000,
    });

    const results = await tracker.applyAll([addColumn], { atomic: true });

    expect(results[0].success).toBe(true);
    const inTx = fake.sqlIn('transaction');
    expect(inTx[0]).toBe(`SET LOCAL lock_timeout = '7000ms'`);
    expect(inTx[1]).toBe(`SET LOCAL statement_timeout = '9000ms'`);
    // The timeouts must precede every statement they are meant to bound —
    // including the tracker's own bookkeeping writes.
    expect(
      inTx.indexOf('ALTER TABLE "jobs" ADD COLUMN "status" TEXT'),
    ).toBeGreaterThan(1);
  });

  it('uses SET LOCAL so the timeout cannot leak onto the pooled connection', async () => {
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addColumn], { atomic: true });

    // A bare `SET` would survive the transaction and follow the connection
    // back into the pool for unrelated application queries.
    expect(
      fake.queries.some(
        (entry) =>
          /^SET (lock|statement)_timeout/.test(entry.sql) &&
          entry.channel === 'transaction',
      ),
    ).toBe(false);
  });

  it('falls each timeout back to its own default, never the other one', async () => {
    // A bad lock_timeout must not inherit the statement-timeout default:
    // silently widening a 30s lock bound to 60s is exactly the unbounded-wait
    // problem this issue is about, in miniature.
    const tracker = new MigrationTracker({
      db: fake.db,
      lockTimeout: Number.NaN,
      statementTimeout: Number.POSITIVE_INFINITY,
    });

    await tracker.applyAll([addColumn], { atomic: true });

    const inTx = fake.sqlIn('transaction');
    expect(inTx[0]).toBe(`SET LOCAL lock_timeout = '30000ms'`);
    expect(inTx[1]).toBe(`SET LOCAL statement_timeout = '60000ms'`);
  });

  it('applies the timeouts even without concurrent-index mode', async () => {
    // Regression guard for the original bug: the timeouts were only reached
    // on the non-atomic `postgresSafe` path, which production never took.
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addColumn], { atomic: true, postgresSafe: false });

    expect(fake.sqlIn('transaction')).toContain(
      `SET LOCAL lock_timeout = '30000ms'`,
    );
  });

  it('does not emit PostgreSQL timeout syntax on other engines', async () => {
    const sqlite = createFakeDb({ url: 'sqlite://./test.db' });
    const tracker = new MigrationTracker({ db: sqlite.db });

    await tracker.applyAll([addColumn], { atomic: true });

    expect(
      sqlite.queries.some((entry) => entry.sql.includes('lock_timeout')),
    ).toBe(false);
  });

  it('still rejects CONCURRENTLY DDL in a plain atomic batch, naming the escape hatch', async () => {
    const tracker = new MigrationTracker({ db: fake.db });

    await expect(
      tracker.applyAll(
        [
          definition('0001_concurrent', [
            'CREATE INDEX CONCURRENTLY idx ON t (a)',
          ]),
        ],
        { atomic: true, postgresSafe: false },
      ),
    ).rejects.toThrow(/--postgres-safe/);
  });
});

describe('PostgreSQL concurrent-index mode (issue #2362)', () => {
  it('commits non-index DDL in the transaction and builds indexes outside it', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll([addColumn, addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(results.every((result) => result.success)).toBe(true);
    expect(fake.sqlIn('transaction')).toContain(
      'ALTER TABLE "jobs" ADD COLUMN "status" TEXT',
    );
    expect(fake.sqlIn('session')).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
    );
    // The index must NOT have run in the transaction — PostgreSQL rejects
    // CONCURRENTLY there, and the whole point is to avoid the batch lock.
    // (The tracker's own `_smrt_schema_migrations` bootstrap DDL also creates
    // indexes in there, so match the migration's index by name.)
    expect(
      fake.sqlIn('transaction').some((sql) => sql.includes('jobs_status_idx')),
    ).toBe(false);
  });

  it('pins one session and bounds it with session-level timeouts', async () => {
    // A pooled `db.query` may run `SET lock_timeout` on a different connection
    // than the DDL that follows, silently leaving the build unbounded.
    const fake = createFakeDb();
    const tracker = new MigrationTracker({
      db: fake.db,
      lockTimeout: 1234,
      statementTimeout: 5678,
    });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    const sessionSql = fake.sqlIn('session');
    expect(sessionSql[0]).toBe(`SET lock_timeout = '1234ms'`);
    expect(sessionSql[1]).toBe(`SET statement_timeout = '5678ms'`);
    expect(fake.sessionsOpened).toBe(1);
    expect(fake.sessionsReleased).toBe(1);
  });

  it('releases the pinned session even when an index build fails', async () => {
    const fake = createFakeDb({
      failOn: [
        {
          match: 'jobs_status_idx',
          message: 'canceling statement due to lock timeout',
        },
      ],
    });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    expect(fake.sessionsReleased).toBe(1);
  });

  it('falls back to the plain interface when the adapter has no acquireSession', async () => {
    const fake = createFakeDb({ withSession: false });
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll([addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(results[0].success).toBe(true);
    expect(fake.sqlIn('pool')).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
    );
  });

  it('accepts explicit CONCURRENTLY DDL that a plain atomic batch would reject', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll(
      [
        definition('drop_index_legacy', [
          'DROP INDEX CONCURRENTLY IF EXISTS "legacy_idx"',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );

    expect(results[0].success).toBe(true);
    expect(fake.sqlIn('session')).toContain(
      'DROP INDEX CONCURRENTLY IF EXISTS "legacy_idx"',
    );
  });

  it('marks a deferred migration completed only after its index build finishes', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    // The completion write must come after the CONCURRENTLY build, otherwise a
    // crash between the commit and the build records a migration that never
    // created its index.
    const buildAt = fake.queries.findIndex((entry) =>
      entry.sql.includes('CREATE INDEX CONCURRENTLY'),
    );
    const completeAt = fake.queries.findIndex((entry) =>
      entry.sql.includes("status = 'completed'"),
    );
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(completeAt).toBeGreaterThan(buildAt);
    expect(fake.rows.get('add_index_jobs_status_idx')?.status).toBe(
      'completed',
    );
    expect(
      fake.rows.get('add_index_jobs_status_idx')?.error_message,
    ).toBeNull();
  });

  it('commits the interim record as retryable, not stuck running', async () => {
    // Unlike the single-transaction path — where a crash rolls the record
    // insert back along with the DDL — phase 1 commits this row. A `running`
    // row would then require `--force-migration` for every index the crash
    // did not reach, which is unworkable for a large index rollout.
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    const interimWrite = fake.queries.findIndex(
      (entry) =>
        entry.sql.includes("status = 'failed'") &&
        entry.channel === 'transaction',
    );
    const buildAt = fake.queries.findIndex((entry) =>
      entry.sql.includes('CREATE INDEX CONCURRENTLY'),
    );

    expect(interimWrite).toBeGreaterThanOrEqual(0);
    expect(interimWrite).toBeLessThan(buildAt);
  });

  it('resumes at the index phase without re-running committed non-index DDL', async () => {
    // A definition may mix transaction-safe DDL with index DDL — a
    // `create_table_*` migration always does. The differ emits
    // `ALTER TABLE … ADD COLUMN` without `IF NOT EXISTS`, so re-running the
    // committed half on retry would fail with "column already exists" forever
    // and never reach the index build the retry existed for.
    const mixed = definition('add_table_and_index_jobs', [
      'ALTER TABLE "jobs" ADD COLUMN "status" TEXT',
      'CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
    ]);

    const first = createFakeDb({
      failOn: [
        {
          match: 'jobs_status_idx',
          message: 'canceling statement due to lock timeout',
        },
      ],
    });
    const firstRun = await new MigrationTracker({ db: first.db }).applyAll(
      [mixed],
      { atomic: true, postgresSafe: true },
    );

    expect(firstRun[0].success).toBe(false);
    const stranded = first.rows.get('add_table_and_index_jobs');
    expect(stranded?.status).toBe('failed');
    expect(
      first.sqlIn('transaction').some((sql) => sql.includes('ADD COLUMN')),
    ).toBe(true);

    // Second run: the tracker finds the committed interim record. Seed a fresh
    // fake with it, then replay the same definition.
    const second = createFakeDb();
    second.rows.set('add_table_and_index_jobs', {
      ...stranded,
      // The interim marker the resume check reads.
      status: 'failed',
      error_message: stranded?.error_message,
    });

    const secondRun = await new MigrationTracker({ db: second.db }).applyAll(
      [mixed],
      { atomic: true, postgresSafe: true, reconcile: true },
    );

    expect(secondRun[0].success).toBe(true);
    // The already-committed column DDL must NOT run again…
    expect(
      second.sqlIn('transaction').some((sql) => sql.includes('ADD COLUMN')),
    ).toBe(false);
    // …but the index build it was retrying for must.
    expect(second.sqlIn('session')).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
    );
    expect(second.rows.get('add_table_and_index_jobs')?.status).toBe(
      'completed',
    );
  });

  it('re-runs everything when the definition itself changed', async () => {
    // A different checksum means the interim marker describes different SQL,
    // so resuming would skip statements that never ran.
    const fake = createFakeDb();
    fake.rows.set('add_index_jobs_status_idx', {
      id: 'seeded',
      name: 'add_index_jobs_status_idx',
      checksum: 'a-different-definition',
      status: 'failed',
      error_message:
        '[smrt: concurrent-index phase 1 committed] Concurrent index build pending.',
      attempts: 1,
      applied_at: new Date().toISOString(),
      is_reversible: 0,
      batch: 1,
    });

    const results = await new MigrationTracker({ db: fake.db }).applyAll(
      [addIndex],
      { atomic: true, postgresSafe: true, reconcile: true },
    );

    expect(results[0].success).toBe(true);
    expect(fake.sqlIn('session')).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
    );
  });

  it('records a failed index build as failed so the next run retries it', async () => {
    const fake = createFakeDb({
      failOn: [
        {
          match: 'jobs_status_idx',
          message: 'canceling statement due to lock timeout',
        },
      ],
    });
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll([addIndex, addSecondIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toContain('lock timeout');
    expect(fake.rows.get('add_index_jobs_status_idx')?.status).toBe('failed');

    // Everything after the failure is left retryable too, not stuck 'running'
    // (which would demand --force on the next db:migrate).
    expect(results[1].success).toBe(false);
    expect(String(results[1].error)).toContain('Not attempted');
    expect(fake.rows.get('add_index_jobs_run_at_idx')?.status).toBe('failed');
    expect(
      fake.sqlIn('session').some((sql) => sql.includes('jobs_run_at_idx')),
    ).toBe(false);
  });

  it('reports progress for a deferred migration once, from the concurrent phase', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });
    const progress: string[] = [];

    await tracker.applyAll([addColumn, addIndex], {
      atomic: true,
      postgresSafe: true,
      onProgress: (result) => progress.push(result.name),
    });

    expect(progress).toEqual([
      'add_column_jobs_status',
      'add_index_jobs_status_idx',
    ]);
  });

  it('rolls the whole batch back when the transactional phase fails', async () => {
    const fake = createFakeDb({
      failOn: [
        { match: 'ADD COLUMN', message: 'column "status" already exists' },
      ],
    });
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll([addColumn, addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(results.every((result) => !result.success)).toBe(true);
    // No index build may start once the transaction rolled back.
    expect(fake.sqlIn('session')).toEqual([]);
  });
});

describe('INVALID index detection and rebuild (issue #2362)', () => {
  it('drops an INVALID index before recreating it', async () => {
    // `pg_indexes` — what the SQL adapter's introspection reads — lists an
    // INVALID index exactly like a healthy one, and `IF NOT EXISTS` then
    // treats the stump as present, so the index never gets rebuilt.
    const fake = createFakeDb({ invalidIndexes: ['jobs_status_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    const sessionSql = fake.sqlIn('session');
    const dropAt = sessionSql.indexOf(
      'DROP INDEX CONCURRENTLY IF EXISTS "jobs_status_idx"',
    );
    const createAt = sessionSql.findIndex((sql) =>
      sql.includes('CREATE INDEX CONCURRENTLY'),
    );
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
  });

  it('scopes the catalog read to the session search path', async () => {
    // Migration DDL names indexes unqualified, and so does the repair drop.
    // Scanning every schema would let an unrelated invalid index of the same
    // name in another schema trigger a drop that resolves to a different
    // object.
    const fake = createFakeDb({ invalidIndexes: ['jobs_status_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    const catalogRead = fake.queries.find((entry) =>
      entry.sql.includes('pg_index'),
    );
    expect(catalogRead?.sql).toContain('current_schemas(false)');
    expect(catalogRead?.sql).not.toContain("NOT IN ('pg_catalog'");
  });

  it('leaves healthy indexes alone', async () => {
    const fake = createFakeDb({ invalidIndexes: ['some_other_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    expect(
      fake.sqlIn('session').some((sql) => sql.startsWith('DROP INDEX')),
    ).toBe(false);
  });

  it('continues when the catalog read is not permitted', async () => {
    const fake = createFakeDb();
    const original = fake.db.acquireSession;
    fake.db.acquireSession = async () => {
      const session = await original();
      const query = session.query;
      session.query = async (sql: string, ...params: unknown[]) => {
        if (sql.includes('pg_index')) {
          throw new Error('permission denied for table pg_index');
        }
        return query(sql, ...params);
      };
      return session;
    };
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll([addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(results[0].success).toBe(true);
  });
});
