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
import { readCreateIndexStatement } from '../postgres-create-index.js';
import { MigrationTracker } from '../tracker.js';

interface RecordedQuery {
  channel: 'pool' | 'transaction' | 'session';
  sql: string;
  params?: unknown[];
}

interface FakeDbOptions {
  url?: string;
  /** Provide `acquireSession` (PostgreSQL pools do; SQLite/DuckDB do not). */
  withSession?: boolean;
  /** Index names reported as INVALID by `pg_index.indisvalid = false`. */
  invalidIndexes?: string[];
  /** Schema that holds those INVALID indexes. Default `public`. */
  invalidIndexSchema?: string;
  /** Schema every table of a pending statement resolves to. Default `public`. */
  tableSchema?: string | null;
  /** Whether the index a CREATE INDEX names is valid on its table afterwards. */
  builtIndexValid?: boolean;
  /** No index of the name on the statement's table afterwards. */
  builtIndexMissing?: boolean;
  /** Indexes already on the table before the run: name -> its CREATE INDEX. */
  existingIndexes?: Record<string, string>;
  /** The index of the name differs from the statement (e.g. not unique). */
  builtIndexDiffers?: boolean;
  /** An EXPLAIN whose SQL contains this fragment fails (an unknown column). */
  explainFailsOn?: string;
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
  /** Index name -> the CREATE INDEX that built it (or that it already had). */
  const built = new Map<string, string>(
    Object.entries(options.existingIndexes ?? {}),
  );
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
    queries.push({ channel, sql, params });

    // The checks around a CREATE INDEX: the index of the name on its table,
    // and its definition, as the statements this fake has run built them.
    if (sql.includes('AS definition')) {
      const create = built.get(String(params[0]));
      if (!create) return { rows: [], rowCount: 0 };
      const definition = options.builtIndexDiffers
        ? /UNIQUE/i.test(create)
          ? create.replace(/UNIQUE\s+/i, '')
          : create.replace(/CREATE\s+/i, 'CREATE UNIQUE ')
        : create;
      return {
        rows: [{ definition, predicate: null, collations: [], opclasses: [] }],
        rowCount: 1,
      };
    }
    if (sql.startsWith('EXPLAIN')) {
      if (options.explainFailsOn && sql.includes(options.explainFailsOn))
        throw new Error('column does not exist');
      return { rows: [{ 'QUERY PLAN': sql }], rowCount: 1 };
    }
    if (sql.includes('index_oid')) {
      const name = String(params[0]);
      return options.builtIndexMissing || !built.has(name)
        ? { rows: [], rowCount: 0 }
        : {
            rows: [
              { index_oid: name, is_valid: options.builtIndexValid ?? true },
            ],
            rowCount: 1,
          };
    }

    // The concurrent phase's own bookkeeping (#5325): the schema of the
    // tracking table, the session it was handed, and the row's lock.
    if (sql.includes("to_regclass('_smrt_schema_migrations')")) {
      return { rows: [{ schema_name: 'public' }], rowCount: 1 };
    }
    if (sql.includes('FROM pg_catalog.pg_settings')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('session_user AS session_name')) {
      return {
        rows: [
          {
            session_name: 'migrator',
            current_name: 'migrator',
            search_path: 'public',
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('pg_try_advisory')) {
      return { rows: [{ locked: true }], rowCount: 1 };
    }
    if (sql.includes('SELECT status, attempts, error_message FROM')) {
      const row = [...rows.values()].find(
        (candidate) => candidate.id === params[0],
      );
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (sql.includes('to_regclass')) {
      const schema =
        options.tableSchema === undefined ? 'public' : options.tableSchema;
      return schema === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ schema_name: schema }], rowCount: 1 };
    }

    if (sql.includes('pg_index')) {
      return {
        rows: invalidIndexes.map((index_name) => ({
          index_name,
          schema_name: options.invalidIndexSchema ?? 'public',
        })),
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

    if (
      sql.includes("FROM _smrt_schema_migrations WHERE status = 'completed'")
    ) {
      const completed = [...rows.values()].filter(
        (row) => row.status === 'completed',
      );
      return { rows: completed, rowCount: completed.length };
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

    if (/UPDATE (public\.)?_smrt_schema_migrations/.test(sql)) {
      // Status writes address the row by `id`, the first WHERE parameter;
      // fenced writes also match the status and attempt number they expect.
      const [set, where = ''] = sql.split('WHERE');
      const setCount = (set.match(/\?/g) ?? []).length;
      const [selector, ...fence] = params.slice(setCount);
      const row = [...rows.values()].find(
        (candidate) => candidate.id === selector,
      );
      const expected = where.includes('status = ?')
        ? { status: fence[0], attempts: fence[1] }
        : where.includes("status = 'failed'")
          ? { status: 'failed', attempts: fence[0] }
          : null;
      const matches =
        row !== undefined &&
        (expected === null ||
          (row.status === expected.status &&
            Number(row.attempts ?? 0) === Number(expected.attempts)));

      if (row && matches) {
        if (set.includes("status = 'completed'")) {
          row.status = 'completed';
          row.error_message = null;
        } else if (set.includes("status = 'failed'")) {
          row.status = 'failed';
        } else if (set.includes("status = 'running'")) {
          row.status = 'running';
          row.attempts = params[1];
        }

        // In every tracker statement that binds `error_message`, it is the
        // last SET placeholder.
        if (set.includes('error_message = ?')) {
          row.error_message = params[setCount - 1];
        }
      }
      return matches && sql.includes('RETURNING id')
        ? { rows: [{ id: selector }], rowCount: 1 }
        : { rows: [], rowCount: matches ? 1 : 0 };
    }

    if (sql.startsWith('SELECT')) {
      return { rows: [], rowCount: 0 };
    }

    maybeFail(sql);
    const created = readCreateIndexStatement(sql);
    if (created.kind === 'create-index' && created.statement.name)
      built.set(created.statement.name, sql);
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
    // After the session's own settings are read (#5325), before any DDL.
    const bound = sessionSql.indexOf(`SET lock_timeout = '1234ms'`);
    expect(bound).toBeGreaterThan(-1);
    expect(sessionSql[bound + 1]).toBe(`SET statement_timeout = '5678ms'`);
    expect(sessionSql.slice(0, bound).every((sql) => !/INDEX/.test(sql))).toBe(
      true,
    );
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

  it('refuses a retry when the definition itself changed (#5325)', async () => {
    // A different checksum means the interim marker describes different SQL:
    // resuming would skip statements that never ran, and running everything
    // again would repeat the half that committed.
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

    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toContain('changed');
    expect(fake.sqlIn('session')).not.toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
    );
  });

  it('re-runs everything when a changed definition is forced by name', async () => {
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
      {
        atomic: true,
        postgresSafe: true,
        reconcile: true,
        forceMigrations: ['add_index_jobs_status_idx'],
      },
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
      'DROP INDEX CONCURRENTLY IF EXISTS "public"."jobs_status_idx"',
    );
    const createAt = sessionSql.findIndex((sql) =>
      sql.includes('CREATE INDEX CONCURRENTLY'),
    );
    expect(dropAt).toBeGreaterThanOrEqual(0);
    expect(createAt).toBeGreaterThan(dropAt);
  });

  it("resolves the pending statement's table on the session and drops the index in that schema only", async () => {
    // Several schemas may each hold an index of this name. The index a create
    // collides with is the one in its table's schema, so the drop names it.
    const fake = createFakeDb({
      invalidIndexes: ['jobs_status_idx'],
      invalidIndexSchema: 'tenant_a',
      tableSchema: 'tenant_a',
    });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    const sessionSql = fake.sqlIn('session');
    expect(sessionSql.some((sql) => sql.includes('to_regclass'))).toBe(true);
    expect(sessionSql.filter((sql) => sql.startsWith('DROP INDEX'))).toEqual([
      'DROP INDEX CONCURRENTLY IF EXISTS "tenant_a"."jobs_status_idx"',
    ]);
  });

  it('never drops an index of the same name in another schema', async () => {
    // The INVALID index is in a schema the pending statement's table is not
    // in. An unqualified drop would resolve by search path and could remove a
    // healthy index of that name; no drop is issued at all.
    const fake = createFakeDb({
      invalidIndexes: ['jobs_status_idx'],
      invalidIndexSchema: 'tenant_b',
      tableSchema: 'tenant_a',
    });
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll([addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(results[0].success).toBe(true);
    const sessionSql = fake.sqlIn('session');
    expect(sessionSql.some((sql) => sql.startsWith('DROP INDEX'))).toBe(false);
    expect(
      sessionSql.some((sql) => sql.includes('CREATE INDEX CONCURRENTLY')),
    ).toBe(true);
  });

  it("does not repair when the pending statement's table cannot be resolved", async () => {
    const fake = createFakeDb({
      invalidIndexes: ['jobs_status_idx'],
      tableSchema: null,
    });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    expect(
      fake.sqlIn('session').some((sql) => sql.startsWith('DROP INDEX')),
    ).toBe(false);
  });

  it('does not repair, and does not record success, when the statement names its table in a form it cannot read whole', async () => {
    // A three-part name: refused before anything runs (nothing dropped,
    // nothing built, nothing recorded), so the migration stays retryable.
    const fake = createFakeDb({ invalidIndexes: ['jobs_status_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });
    const unreadable: MigrationDefinition = {
      ...addIndex,
      up: [
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_status_idx" ON db.app.jobs ("status")',
      ],
    };

    await expect(
      tracker.applyAll([unreadable], { atomic: true, postgresSafe: true }),
    ).rejects.toThrow('could not be read with certainty');

    expect(fake.sqlIn('session')).toEqual([]);
  });

  it('does not record success when the index is not valid on its table after the create', async () => {
    const fake = createFakeDb({ builtIndexValid: false });
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll([addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(
      'jobs_status_idx on "jobs" is INVALID',
    );
  });

  it('matches the INVALID index to the pending statement by its table, not by name alone', async () => {
    const fake = createFakeDb({ invalidIndexes: ['jobs_status_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    const lookup = fake
      .sqlIn('session')
      .find((sql) => sql.includes('to_regclass'));
    expect(lookup).toMatch(/indrelid\s*=\s*to_regclass\(\?\)/);
    expect(lookup).toMatch(/indisvalid\s*=\s*false/);
  });

  it('asks the catalog about a table only when an INVALID index has the pending name', async () => {
    const fake = createFakeDb({ invalidIndexes: ['some_other_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    expect(
      fake
        .sqlIn('session')
        .some(
          (sql) =>
            sql.includes('to_regclass') && sql.includes('indisvalid = false'),
        ),
    ).toBe(false);
  });

  it('leaves healthy indexes alone', async () => {
    const fake = createFakeDb({ invalidIndexes: ['some_other_idx'] });
    const tracker = new MigrationTracker({ db: fake.db });

    await tracker.applyAll([addIndex], { atomic: true, postgresSafe: true });

    expect(
      fake.sqlIn('session').some((sql) => sql.startsWith('DROP INDEX')),
    ).toBe(false);
  });

  it('keeps the migration retryable when the catalog cannot be read to confirm the index', async () => {
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

    // The repair degrades without the catalog; the confirmation cannot.
    expect(results[0].success).toBe(false);
    expect(String(results[0].error)).toContain('could not be confirmed');
  });

  it('does not record success when an index of the name on the same table is not the one described', async () => {
    const fake = createFakeDb({ builtIndexDiffers: true });
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll([addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(
      'is not the index its statement describes',
    );
    // Nothing was created to compare: the catalog is read.
    expect(
      fake.sqlIn('session').some((sql) => /CREATE\s+TEMP/i.test(sql)),
    ).toBe(false);
  });

  it('does not record success when no index of the name is on the statement table', async () => {
    const fake = createFakeDb({ builtIndexMissing: true });
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll([addIndex], {
      atomic: true,
      postgresSafe: true,
    });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('does not exist');
  });

  it.each([
    [
      'a leading comment',
      '/* nightly */ CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs" ("status")',
      'jobs_status_idx',
    ],
    [
      'an unquoted mixed-case name',
      'CREATE INDEX IF NOT EXISTS Jobs_Status_Idx ON jobs (status)',
      'jobs_status_idx',
    ],
  ])('confirms the index of a statement with %s under the name PostgreSQL stores', async (_label, sql, stored) => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll(
      [definition('add_index_variant', [sql])],
      { atomic: true, postgresSafe: true },
    );

    expect(result.success).toBe(true);
    const lookup = fake.queries.filter(
      (query) => query.channel === 'session' && query.sql.includes('index_oid'),
    );
    // Looked up before the create (not yet there) and after it.
    expect(lookup).toHaveLength(2);
    expect(lookup.map((query) => query.params?.[0])).toEqual([stored, stored]);
  });

  it('does not replay a plain CREATE INDEX whose index an earlier run already built as described', async () => {
    // The earlier run built the index, then failed before recording it.
    const fake = createFakeDb({
      existingIndexes: {
        jobs_status_idx:
          'CREATE INDEX jobs_status_idx ON public.jobs USING btree (status)',
      },
    });
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll(
      [
        definition('add_index_plain', [
          'CREATE INDEX "jobs_status_idx" ON "jobs" ("status")',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );

    expect(result.success).toBe(true);
    expect(
      fake
        .sqlIn('session')
        .some((sql) => /^CREATE INDEX CONCURRENTLY/.test(sql)),
    ).toBe(false);
  });

  it('refuses a statement it cannot read before running anything', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    await expect(
      tracker.applyAll(
        [
          addColumn,
          definition('add_index_unicode', [
            'CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON U&"jobs" ("status")',
          ]),
        ],
        { atomic: true, postgresSafe: true },
      ),
    ).rejects.toThrow('refused under --postgres-safe before anything ran');

    expect(fake.sqlIn('transaction')).toEqual([]);
    expect(fake.sqlIn('session')).toEqual([]);
  });

  it.each([
    'CREATE INDEX U&"jobs\\0061idx" ON jobs (status)',
    'DROP INDEX U&"jobs\\0061idx"',
  ])('refuses %s, whose index name it cannot read, before running anything', async (sql) => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    await expect(
      tracker.applyAll([definition('unicode_index_name', [sql])], {
        atomic: true,
        postgresSafe: true,
      }),
    ).rejects.toThrow('could not be read with certainty');
    expect(fake.queries.some((query) => query.sql.includes('jobs'))).toBe(
      false,
    );
  });

  it('refuses an unnamed index before running anything: a retry would build another', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    await expect(
      tracker.applyAll(
        [definition('add_unnamed_index', ['CREATE INDEX ON jobs (status)'])],
        { atomic: true, postgresSafe: true },
      ),
    ).rejects.toThrow('names no index');
    expect(
      fake.queries.some((query) => query.sql.includes('CREATE INDEX')),
    ).toBe(false);
  });

  describe('a batch that repeats a migration already recorded as applied', () => {
    const appliedUnnamed = definition('applied_unnamed_index', [
      'CREATE INDEX ON jobs (status)',
    ]);
    const pending = definition('add_jobs_run_at_idx', [
      'CREATE INDEX IF NOT EXISTS "jobs_run_at_idx" ON "jobs" ("run_at")',
    ]);
    const recordApplied = async (fake: FakeDb) => {
      // Recorded `completed` by an atomic run without --postgres-safe, which
      // keeps an unnamed create in the transaction.
      const [first] = await new MigrationTracker({ db: fake.db }).applyAll(
        [appliedUnnamed],
        { atomic: true },
      );
      expect(first.success).toBe(true);
      expect(fake.rows.get(appliedUnnamed.id)?.status).toBe('completed');
    };

    it('skips the applied migration without checking its statements, and applies the pending one', async () => {
      const fake = createFakeDb();
      await recordApplied(fake);

      const results = await new MigrationTracker({ db: fake.db }).applyAll(
        [appliedUnnamed, pending],
        { atomic: true, postgresSafe: true },
      );

      expect(
        results.map((result) => [result.name, result.success, result.skipped]),
      ).toEqual([
        [appliedUnnamed.id, true, true],
        [pending.id, true, false],
      ]);
      expect(fake.sqlIn('session')).toContain(
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS "jobs_run_at_idx" ON "jobs" ("run_at")',
      );
    });

    it('still refuses the applied migration when it is forced to run again', async () => {
      const fake = createFakeDb();
      await recordApplied(fake);

      await expect(
        new MigrationTracker({ db: fake.db }).applyAll(
          [appliedUnnamed, pending],
          {
            atomic: true,
            postgresSafe: true,
            forceMigrations: [appliedUnnamed.id],
          },
        ),
      ).rejects.toThrow('names no index');
      expect(
        fake.sqlIn('session').some((sql) => sql.includes('jobs_run_at_idx')),
      ).toBe(false);
    });
  });

  it('checks a create before an earlier drop of its name runs, and drops nothing when the create cannot be checked', async () => {
    const fake = createFakeDb({
      existingIndexes: {
        jobs_status_idx:
          'CREATE INDEX jobs_status_idx ON public.jobs USING btree (status)',
      },
      explainFailsOn: 'no_such_column',
    });
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll(
      [
        definition('recreate_jobs_status_idx', [
          'DROP INDEX "jobs_status_idx"',
          'CREATE INDEX "jobs_status_idx" ON "jobs" ((lower(no_such_column)))',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain(
      'refused under --postgres-safe before the concurrent index phase ran anything',
    );
    expect(fake.sqlIn('session').some((sql) => /DROP INDEX/.test(sql))).toBe(
      false,
    );
  });

  it("marks every pending migration not attempted when a later migration's create cannot be checked", async () => {
    const fake = createFakeDb({ explainFailsOn: 'no_such_column' });
    const tracker = new MigrationTracker({ db: fake.db });

    const results = await tracker.applyAll(
      [
        definition('drop_jobs_status_idx', ['DROP INDEX "jobs_status_idx"']),
        definition('add_jobs_status_idx', [
          'CREATE INDEX "jobs_status_idx" ON "jobs" ((lower(no_such_column)))',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );

    expect(results.map((result) => result.success)).toEqual([false, false]);
    expect(String(results[0].error)).toContain('Not attempted');
    expect(String(results[1].error)).toContain('cannot be checked');
    expect(fake.sqlIn('session').some((sql) => /DROP INDEX/.test(sql))).toBe(
      false,
    );
  });

  it('runs an authored drop and rename after a create as written, not as a generated swap', async () => {
    const fake = createFakeDb();
    const tracker = new MigrationTracker({ db: fake.db });

    const [result] = await tracker.applyAll(
      [
        definition('authored_swap', [
          'ALTER TABLE "c" VALIDATE CONSTRAINT "fk"',
          'CREATE UNIQUE INDEX "jobs_tmp" ON "b"."jobs" ("status")',
          'DROP INDEX "jobs_old"',
          'ALTER INDEX "jobs_tmp" RENAME TO "jobs_old"',
        ]),
      ],
      { atomic: true, postgresSafe: true },
    );

    expect(result.success).toBe(true);
    const sessionSql = fake.sqlIn('session');
    expect(sessionSql).toContain('DROP INDEX CONCURRENTLY "jobs_old"');
    expect(sessionSql).toContain('ALTER INDEX "jobs_tmp" RENAME TO "jobs_old"');
    expect(sessionSql.some((sql) => sql.includes('"public"."jobs_old"'))).toBe(
      false,
    );
  });
});
