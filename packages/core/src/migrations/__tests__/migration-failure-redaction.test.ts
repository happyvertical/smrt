/**
 * A failed migration is reported as a closed reason (migration, statement
 * ordinal in the authored list, fixed kind, phase, SQLSTATE). The authored SQL
 * and the database's message text, which can echo an authored literal, reach
 * neither the thrown error (nor anything that inspects it), nor log output,
 * nor the tracking table. Closing is the default for every failure the
 * executor did not raise itself; only a guard the framework generated, failing
 * for its own reason, keeps its fixed message.
 */
import { inspect } from 'node:util';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDatabase } from '../../testing/database.js';
import {
  FRAMEWORK_GUARD_ERRCODE_SQL,
  FRAMEWORK_GUARD_SQLSTATE,
  frameworkGuardStatement,
  isMigrationStatementFailure,
  MigrationStatementFailure,
  runStatementClosed,
  sqlstateOf,
  statementKindOf,
} from '../migration-failure.js';
import {
  REBUILD_PLAN_STALE_MARKER,
  rebuildPlanStaleMessage,
  TableChangedSincePlanError,
} from '../rebuild-plan-guard.js';
import { SQLITE_RELAX_REBUILD_MARKER } from '../sqlite-rebuild.js';
import { MigrationTracker } from '../tracker.js';

const CANARY = 'canary_literal_8f3a91';

/** Everything printed, objects rendered as `console` renders them. */
function captureOutput() {
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args
          .map((arg) =>
            typeof arg === 'string' ? arg : inspect(arg, { depth: 10 }),
          )
          .join(' '),
      );
    });
  }
  return () => lines.join('\n');
}

/** Every rendering of `error` a caller or a logger can reach. */
function everyRendering(error: unknown): string {
  const parts: string[] = [inspect(error, { depth: 10 }), String(error)];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (typeof current !== 'object') break;
    const { message, stack, cause, context } = current as {
      message?: unknown;
      stack?: unknown;
      cause?: unknown;
      context?: { originalError?: unknown };
    };
    parts.push(String(message), String(stack), JSON.stringify(current));
    if (context?.originalError) parts.push(String(context.originalError));
    current = cause;
  }
  return parts.join('\n');
}

const definition = (id: string, up: string[], down: string[] = []) => ({
  id,
  description: id,
  version: '1.0.0',
  up,
  down,
});

describe('closed failure helpers', () => {
  it('reads only a real SQLSTATE, through the adapter wrapper', () => {
    expect(sqlstateOf({ code: '23505' })).toBe('23505');
    expect(sqlstateOf({ code: 'P0001' })).toBe('P0001');
    // Classes with a letter in second place are SQLSTATEs too.
    for (const code of ['2BP01', '0A000', '3F000', '2D000', '42P07'])
      expect(sqlstateOf({ code })).toBe(code);
    expect(
      sqlstateOf({ code: 'DATABASE_ERROR', cause: { code: '42P01' } }),
    ).toBe('42P01');
    for (const code of ['EPIPE', 'EBUSY', 'EPERM', 'SQLITE_CONSTRAINT', 'X'])
      expect(sqlstateOf({ code })).toBeNull();
  });

  it('heads the stack with the closed reason and keeps no original error', () => {
    const failure = new MigrationStatementFailure(
      Object.assign(new Error(`boom ${CANARY}`), { code: '42601' }),
      { phase: 'regular', ordinal: 2, sql: 'ALTER TABLE t ADD COLUMN c TEXT' },
    ).bindMigration('0001_stack');
    expect(failure.message).toBe(
      'Migration 0001_stack: statement 2 (alter-table) failed in the regular phase (SQLSTATE 42601; database message withheld)',
    );
    expect(failure.stack?.split('\n')[0]).toBe(
      `MigrationStatementFailure: ${failure.message}`,
    );
    expect(failure.cause).toBeUndefined();
    expect(everyRendering(failure)).not.toContain(CANARY);
    expect(isMigrationStatementFailure(failure)).toBe(true);
    expect(isMigrationStatementFailure(new Error('x'))).toBe(false);
  });

  it('reports a framework guard only for its own failure, as a fresh error', async () => {
    const reason = 'smrt guard reason 41d2: rows differ';
    const pgGuard = frameworkGuardStatement(
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM t) THEN RAISE EXCEPTION 41d2 USING ERRCODE = 'P0' || 'S01'; END IF; END $$",
      'postgres',
      [reason],
    );
    // The adapter strips the RAISE literal; the guard's registered reason is
    // reported instead, with none of the database's text.
    const own = Object.assign(new Error(`[redacted] ${CANARY}`), {
      code: FRAMEWORK_GUARD_SQLSTATE,
      context: { originalError: new Error(CANARY) },
    });
    const raised = await runStatementClosed(() => Promise.reject(own), {
      phase: 'regular',
      sql: pgGuard,
    }).catch((error: unknown) => error);
    expect(raised).not.toBeInstanceOf(MigrationStatementFailure);
    expect(raised).not.toBe(own);
    expect((raised as Error).message).toBe(reason);
    expect((raised as { code?: unknown }).code).toBe(FRAMEWORK_GUARD_SQLSTATE);
    expect(everyRendering(raised)).not.toContain(CANARY);
    // A P0001 (a function an authored expression calls) is not the guard's.
    const authoredRaise = await runStatementClosed(
      () => Promise.reject(Object.assign(new Error(CANARY), { code: 'P0001' })),
      { phase: 'regular', sql: pgGuard },
    ).catch((error: unknown) => error);
    expect(authoredRaise).toBeInstanceOf(MigrationStatementFailure);
    expect((authoredRaise as Error).message).not.toContain(reason);
    // The same guard cancelled by a statement timeout is not its own failure.
    const timeout = Object.assign(
      new Error(`${reason} canceling statement due to statement timeout`),
      { code: '57014' },
    );
    const closed = await runStatementClosed(() => Promise.reject(timeout), {
      phase: 'regular',
      sql: pgGuard,
    }).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(MigrationStatementFailure);
    expect((closed as Error).message).toContain('SQLSTATE 57014');
    expect((closed as Error).message).not.toContain(reason);

    // DuckDB: a finding is reported by its registered fixed part only; the
    // values it lists and any other row text are dropped with the driver's
    // error.
    const duckReason = 'table rebuild check failed: "t41d2" has columns';
    const duckGuard = frameworkGuardStatement(
      'SELECT error(CAST(list(problem) AS VARCHAR)) FROM temp."_g41d2" HAVING count(*) > 0',
      'duckdb',
      [duckReason],
    );
    const finding = Object.assign(
      new Error(
        `Invalid Input Error: [${duckReason} [a, ${CANARY}], the plan built [a]]`,
      ),
      {
        context: { originalError: new Error(CANARY) },
        cause: new Error(CANARY),
      },
    );
    const duckRaised = await runStatementClosed(() => Promise.reject(finding), {
      phase: 'regular',
      sql: duckGuard,
    }).catch((error: unknown) => error);
    expect(duckRaised).not.toBe(finding);
    expect((duckRaised as Error).message).toBe(duckReason);
    expect(everyRendering(duckRaised)).not.toContain(CANARY);
    const other = await runStatementClosed(
      () => Promise.reject(new Error(`Catalog Error: ${CANARY}`)),
      { phase: 'regular', sql: duckGuard },
    ).catch((error: unknown) => error);
    expect(other).toBeInstanceOf(MigrationStatementFailure);
    expect((other as Error).message).not.toContain(CANARY);
  });

  it('keeps every reason registered for one guard text and names only the one that failed', async () => {
    const sql = 'INSERT INTO temp."_g5a5" ("v") SELECT 0';
    frameworkGuardStatement(sql, 'sqlite', [
      'smrt guard 5a5: table "one" changed',
    ]);
    frameworkGuardStatement(sql, 'sqlite', [
      'smrt guard 5a5: table "two" changed',
    ]);
    const first = await runStatementClosed(
      () =>
        Promise.reject(
          new Error(
            'SQLITE_CONSTRAINT: CHECK constraint failed: smrt guard 5a5: table "one" changed',
          ),
        ),
      { phase: 'regular', sql },
    ).catch((error: unknown) => error);
    expect((first as Error).message).toBe(
      'smrt guard 5a5: table "one" changed',
    );
    // A constraint named by a reason plus more text is not the guard's.
    const longer = await runStatementClosed(
      () =>
        Promise.reject(
          new Error(
            `SQLITE_CONSTRAINT: CHECK constraint failed: smrt guard 5a5: table "two" changed ${CANARY}`,
          ),
        ),
      { phase: 'regular', sql },
    ).catch((error: unknown) => error);
    expect(longer).toBeInstanceOf(MigrationStatementFailure);
    expect(everyRendering(longer)).not.toContain(CANARY);
  });

  it('reads every defined SQLSTATE class through nested and cyclic wrappers', () => {
    expect(sqlstateOf({ code: '72000' })).toBe('72000');
    for (const code of ['6Z000', '1A000', '59000', 'ZZ000'])
      expect(sqlstateOf({ code })).toBeNull();
    let nested: Record<string, unknown> = { code: '40001' };
    for (let depth = 0; depth < 8; depth++)
      nested = { code: 'DATABASE_ERROR', cause: nested };
    expect(sqlstateOf(nested)).toBe('40001');
    const cyclic: Record<string, unknown> = { code: 'DATABASE_ERROR' };
    cyclic.cause = cyclic;
    cyclic.originalError = { code: '23505' };
    expect(sqlstateOf(cyclic)).toBe('23505');
  });

  it('classifies a statement without reading its literals', () => {
    expect(
      statementKindOf(
        "ALTER TABLE t ADD COLUMN c TEXT DEFAULT 'VALIDATE CONSTRAINT'",
      ),
    ).toBe('alter-table');
    expect(statementKindOf('ALTER TABLE t VALIDATE CONSTRAINT t_fk')).toBe(
      'validate-constraint',
    );
  });

  it('keeps replacement tokens in a migration id literal in the stack', () => {
    const failure = new MigrationStatementFailure(
      { code: '42601' },
      { phase: 'regular', ordinal: 1, sql: 'SELECT 1' },
    ).bindMigration("0001_$&_$1_$'");
    expect(failure.stack?.split('\n')[0]).toBe(
      `MigrationStatementFailure: ${failure.message}`,
    );
  });
});

describe('migration failures are closed reasons (sqlite)', () => {
  let db: DatabaseInterface;
  let tracker: MigrationTracker;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    tracker = new MigrationTracker({ db });
    await tracker.initialize();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close?.();
  });

  // A driver that echoes the statement and its literal, as PostgreSQL can.
  const echoingDriver = () => {
    const echo =
      (original: (sql: string, ...v: unknown[]) => Promise<unknown>) =>
      async (sql: string, ...params: unknown[]) => {
        if (sql.includes(CANARY)) {
          throw Object.assign(
            new Error(`syntax error at or near "${CANARY}" in: ${sql}`),
            { code: '42601' },
          );
        }
        return original(sql, ...params);
      };
    const query = echo(db.query.bind(db));
    const transaction = db.transaction?.bind(db);
    (db as { query: unknown }).query = query;
    (db as { transaction: unknown }).transaction = (
      callback: (tx: DatabaseInterface) => Promise<unknown>,
    ) =>
      transaction?.((tx) => {
        const wrapped = Object.create(tx) as DatabaseInterface;
        (wrapped as { query: unknown }).query = echo(tx.query.bind(tx));
        return callback(wrapped);
      });
  };

  // A transaction whose COMMIT fails with the database's text, after every
  // statement of the body ran.
  const failingCommit = () => {
    const transaction = db.transaction?.bind(db);
    (db as { transaction: unknown }).transaction = async (
      callback: (tx: DatabaseInterface) => Promise<unknown>,
    ) => {
      await transaction?.(callback);
      throw Object.assign(
        new Error(
          `insert or update violates foreign key constraint: Key (owner)=(${CANARY}) is not present in table "owners"`,
        ),
        { code: '23503' },
      );
    };
  };

  it('keeps the authored literal out of the error, the logs and the tracking table', async () => {
    const output = captureOutput();
    echoingDriver();

    const result = await tracker.apply(
      definition('0001_echo', [
        'CREATE TABLE echo_probe (a TEXT)',
        `ALTER TABLE echo_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`,
      ]),
    );

    expect(result.success).toBe(false);
    const error = result.error as Error;
    expect(error.message).not.toContain('syntax error');
    expect(everyRendering(error)).not.toContain(CANARY);
    expect(output()).not.toContain(CANARY);

    const row = (
      await db.query(
        `SELECT error_message FROM _smrt_schema_migrations WHERE name = ?`,
        '0001_echo',
      )
    ).rows[0] as { error_message: string };
    expect(row.error_message).not.toContain(CANARY);
    expect(row.error_message).toBe(error.message);
  });

  it('names the migration, ordinal, kind, phase and SQLSTATE', async () => {
    echoingDriver();

    const result = await tracker.apply(
      definition('0002_closed', [
        'CREATE TABLE closed_probe (a TEXT)',
        `ALTER TABLE closed_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`,
      ]),
    );

    const error = result.error as MigrationStatementFailure;
    expect(error).toBeInstanceOf(MigrationStatementFailure);
    expect(error.message).toBe(
      'Migration 0002_closed: statement 2 (alter-table) failed in the regular phase (SQLSTATE 42601; database message withheld)',
    );
    expect(error.statementOrdinal).toBe(2);
    expect(error.statementKind).toBe('alter-table');
    expect(error.code).toBe('42601');
    expect(error.cause).toBeUndefined();
    expect(error.stack?.split('\n')[0]).toBe(
      `MigrationStatementFailure: ${error.message}`,
    );
  });

  it('counts the ordinal in the authored list, executor markers included', async () => {
    echoingDriver();

    const result = await tracker.apply(
      definition('0003_authored', [
        SQLITE_RELAX_REBUILD_MARKER,
        'CREATE TABLE authored_probe (a TEXT)',
        `ALTER TABLE authored_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`,
      ]),
    );

    expect((result.error as MigrationStatementFailure).statementOrdinal).toBe(
      3,
    );
  });

  it('closes a failure at commit and persists only the closed reason', async () => {
    const output = captureOutput();
    failingCommit();

    const result = await tracker.apply(
      definition('0004_commit', ['CREATE TABLE commit_probe (a TEXT)']),
    );

    expect(result.success).toBe(false);
    const error = result.error as MigrationStatementFailure;
    expect(error.message).toBe(
      'Migration 0004_commit: the migration failed in the commit phase (SQLSTATE 23503; database message withheld)',
    );
    expect(everyRendering(error)).not.toContain(CANARY);
    expect(everyRendering(error)).not.toContain('is not present in table');
    expect(output()).not.toContain(CANARY);
    const row = (
      await db.query(
        `SELECT error_message FROM _smrt_schema_migrations WHERE name = ?`,
        '0004_commit',
      )
    ).rows[0] as { error_message: string };
    expect(row.error_message).toBe(error.message);
  });

  it('closes a failure at commit of an atomic batch', async () => {
    failingCommit();

    const thrown = await tracker
      .applyAll(
        [definition('0005_atomic', ['CREATE TABLE atomic_probe (a TEXT)'])],
        {
          atomic: true,
        },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(MigrationStatementFailure);
    expect((thrown as Error).message).toBe(
      'Migration 0005_atomic: the migration failed in the commit phase (SQLSTATE 23503; database message withheld)',
    );
    expect(everyRendering(thrown)).not.toContain(CANARY);
  });

  it('closes a failed rollback with the migration named', async () => {
    await tracker.apply(
      definition(
        '0006_down',
        ['CREATE TABLE down_probe (a TEXT)'],
        [`ALTER TABLE down_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`],
      ),
    );
    echoingDriver();

    const result = await tracker.rollback(
      '0006_down',
      definition(
        '0006_down',
        ['CREATE TABLE down_probe (a TEXT)'],
        [`ALTER TABLE down_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`],
      ),
    );

    expect(result.success).toBe(false);
    expect((result.error as Error).message).toBe(
      'Migration 0006_down: statement 1 (alter-table) failed in the regular phase (SQLSTATE 42601; database message withheld)',
    );
    expect(everyRendering(result.error)).not.toContain(CANARY);
  });

  it('closes an authored CHECK failure that imitates a framework guard', async () => {
    const result = await tracker.apply(
      definition('0007_imitation', [
        `CREATE TEMP TABLE imitation_guard ("v" INTEGER CONSTRAINT "smrt guard ${CANARY}" CHECK ("v" = 0))`,
        'INSERT INTO temp.imitation_guard ("v") SELECT 1',
      ]),
    );

    expect(result.error).toBeInstanceOf(MigrationStatementFailure);
    expect(everyRendering(result.error)).not.toContain(CANARY);
  });

  it('does not name a table from database text that imitates the plan guard', async () => {
    const result = await tracker.apply(
      definition('0008_stale_imitation', [
        `CREATE TEMP TABLE stale_imitation ("v" INTEGER CONSTRAINT "${REBUILD_PLAN_STALE_MARKER}: ""${CANARY}""" CHECK ("v" = 1))`,
        'INSERT INTO temp.stale_imitation ("v") SELECT 0',
      ]),
    );

    expect(result.error).toBeInstanceOf(MigrationStatementFailure);
    expect(everyRendering(result.error)).not.toContain(CANARY);
  });

  it('closes database text that imitates the plan guard outside any statement', async () => {
    // The completion write runs outside the migration's statements and its
    // transaction; its failure is closed before anything reads its text.
    const query = db.query.bind(db);
    (db as { query: unknown }).query = async (
      sql: string,
      ...values: unknown[]
    ) => {
      if (sql.includes("SET status = 'completed'"))
        throw new Error(`${REBUILD_PLAN_STALE_MARKER}: "${CANARY}"`);
      return query(sql, ...values);
    };

    const result = await tracker.apply(
      definition('0008b_stale_outside', [
        'CREATE TABLE stale_outside (a TEXT)',
      ]),
    );

    expect(result.error).toBeInstanceOf(MigrationStatementFailure);
    expect((result.error as Error).message).toContain(
      'failed in the unknown phase',
    );
    expect(everyRendering(result.error)).not.toContain(CANARY);
  });

  it('keeps a framework guard message when the guard fails for its own reason', async () => {
    const reason = 'smrt sqlite guard 7c1e: a stored value differs';
    await db.query(
      `CREATE TEMP TABLE own_guard ("differing" INTEGER CONSTRAINT "${reason}" CHECK ("differing" = 0))`,
    );
    const guard = frameworkGuardStatement(
      'INSERT INTO temp.own_guard ("differing") SELECT 1',
      'sqlite',
      [reason],
    );

    const own = await tracker.apply(definition('0009_own_guard', [guard]));
    expect(own.error).not.toBeInstanceOf(MigrationStatementFailure);
    // A fresh error carrying only the registered reason: no driver text,
    // `context` or `cause`.
    expect((own.error as Error).message).toBe(reason);
    expect((own.error as Error).cause).toBeUndefined();
    expect(everyRendering(own.error)).not.toContain('CHECK constraint failed');
    expect(everyRendering(own.error)).not.toContain('SQLITE_CONSTRAINT');

    // The same guard failing for another reason (its table is gone) is closed.
    await db.query('DROP TABLE temp.own_guard');
    const other = await tracker.apply(
      definition('0010_other_guard_failure', [guard]),
    );
    expect(other.error).toBeInstanceOf(MigrationStatementFailure);
    expect((other.error as Error).message).not.toContain(reason);
  });

  it('closes a registered guard statement whose constraint carries more than the reason', async () => {
    const reason = 'smrt sqlite guard 3b8f: a stored value differs';
    await db.query(
      `CREATE TEMP TABLE mimic_guard ("differing" INTEGER CONSTRAINT "${reason} ${CANARY}" CHECK ("differing" = 0))`,
    );
    const guard = frameworkGuardStatement(
      'INSERT INTO temp.mimic_guard ("differing") SELECT 1',
      'sqlite',
      [reason],
    );

    const result = await tracker.apply(definition('0011_mimic_guard', [guard]));

    expect(result.error).toBeInstanceOf(MigrationStatementFailure);
    expect(everyRendering(result.error)).not.toContain(CANARY);
    const row = (
      await db.query(
        `SELECT error_message FROM _smrt_schema_migrations WHERE name = ?`,
        '0011_mimic_guard',
      )
    ).rows[0] as { error_message: string };
    expect(row.error_message).not.toContain(CANARY);
  });

  it('names a changed table from the registered plan guard reason only', async () => {
    const reason = rebuildPlanStaleMessage('stale_named');
    await db.query(
      `CREATE TEMP TABLE stale_guard ("unchanged" INTEGER CONSTRAINT "${reason.replace(/"/g, '""')}" CHECK ("unchanged" = 1))`,
    );
    const guard = frameworkGuardStatement(
      'INSERT INTO temp.stale_guard ("unchanged") SELECT 0',
      'sqlite',
      [reason],
    );

    const result = await tracker.apply(definition('0012_stale_named', [guard]));

    expect(result.error).toBeInstanceOf(TableChangedSincePlanError);
    expect((result.error as TableChangedSincePlanError).table).toBe(
      'stale_named',
    );
    const text = everyRendering(result.error);
    expect(text).not.toContain('CHECK constraint failed');
    expect(text).not.toContain('SQLITE_CONSTRAINT');
  });

  it('closes a failing tracking write on direct apply and a non-atomic batch', async () => {
    const query = db.query.bind(db);
    (db as { query: unknown }).query = async (
      sql: string,
      ...values: unknown[]
    ) => {
      if (sql.includes('INSERT INTO _smrt_schema_migrations'))
        throw Object.assign(new Error(`trigger refused row (${CANARY})`), {
          context: { originalError: new Error(CANARY) },
        });
      return query(sql, ...values);
    };

    const direct = await tracker
      .apply(definition('0013_tracking', ['CREATE TABLE tracking_a (a TEXT)']))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(direct).toBeInstanceOf(MigrationStatementFailure);
    expect((direct as Error).message).toBe(
      'Migration 0013_tracking: the migration failed in the unknown phase (SQLSTATE unavailable; database message withheld)',
    );
    expect(everyRendering(direct)).not.toContain(CANARY);

    const batch = await new MigrationTracker({ db })
      .applyAll([
        definition('0014_tracking', ['CREATE TABLE tracking_b (a TEXT)']),
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(batch).toBeInstanceOf(MigrationStatementFailure);
    expect(everyRendering(batch)).not.toContain(CANARY);
  });

  it('closes a failing history read before a rollback', async () => {
    const query = db.query.bind(db);
    (db as { query: unknown }).query = async (
      sql: string,
      ...values: unknown[]
    ) => {
      if (/SELECT \* FROM _smrt_schema_migrations WHERE name/.test(sql))
        throw new Error(`history read failed ${CANARY}`);
      return query(sql, ...values);
    };
    const thrown = await tracker
      .rollback('0015_gone', definition('0015_gone', [], ['DROP TABLE x']))
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(thrown).toBeInstanceOf(MigrationStatementFailure);
    expect(everyRendering(thrown)).not.toContain(CANARY);
  });

  it('keeps the statement failure when restoring SQLite settings also fails', async () => {
    echoingDriver();
    const query = db.query.bind(db);
    (db as { query: unknown }).query = async (
      sql: string,
      ...values: unknown[]
    ) => {
      if (sql.startsWith('PRAGMA legacy_alter_table = '))
        throw new Error(`restore failed ${CANARY}`);
      return query(sql, ...values);
    };

    const result = await tracker.apply(
      definition('0016_restore', [
        SQLITE_RELAX_REBUILD_MARKER,
        'CREATE TABLE restore_probe (a TEXT)',
        `ALTER TABLE restore_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`,
      ]),
    );

    expect(result.error).toBeInstanceOf(MigrationStatementFailure);
    expect((result.error as MigrationStatementFailure).statementOrdinal).toBe(
      3,
    );
    expect((result.error as MigrationStatementFailure).code).toBe('42601');
    expect(everyRendering(result.error)).not.toContain(CANARY);
  });

  it('keeps the statement failure and refuses further work while foreign keys stay off', async () => {
    await db.query('PRAGMA foreign_keys = ON');
    echoingDriver();
    const query = db.query.bind(db);
    let swallowRestore = true;
    (db as { query: unknown }).query = async (
      sql: string,
      ...values: unknown[]
    ) => {
      // The restore of foreign key enforcement does not take effect.
      if (swallowRestore && sql === 'PRAGMA foreign_keys = 1')
        return { rows: [] };
      return query(sql, ...values);
    };

    const result = await tracker.apply(
      definition('0016b_fk_restore', [
        SQLITE_RELAX_REBUILD_MARKER,
        'CREATE TABLE fk_restore_probe (a TEXT)',
        `ALTER TABLE fk_restore_probe ADD COLUMN b TEXT DEFAULT '${CANARY}'`,
      ]),
    );

    // The primary failure is kept; the failed restore is beside it, closed.
    const error = result.error as MigrationStatementFailure;
    expect(error).toBeInstanceOf(MigrationStatementFailure);
    expect(error.statementOrdinal).toBe(3);
    expect(error.cleanupFailure).toBeInstanceOf(Error);
    expect(error.message).toContain('cleanup also failed');
    expect(everyRendering(error)).not.toContain(CANARY);
    expect(
      Number((await query('PRAGMA foreign_keys')).rows[0]?.foreign_keys),
    ).toBe(0);

    // Further work on this connection is refused until enforcement is back.
    const refused = await tracker
      .apply(definition('0016c_after', ['CREATE TABLE after_probe (a TEXT)']))
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect((refused as Error).message).toContain(
      'SQLite foreign key enforcement was not restored',
    );
    swallowRestore = false;
    await query('PRAGMA foreign_keys = ON');
    const after = await tracker.apply(
      definition('0016c_after', ['CREATE TABLE after_probe (a TEXT)']),
    );
    expect(after.success).toBe(true);
  });

  it('refuses a retry without repeating the stored failure text', async () => {
    await db.query(
      `INSERT INTO _smrt_schema_migrations (id, name, version, checksum, status, attempts, is_reversible, error_message)
       VALUES ('r-1', '0017_old', '1.0.0', 'x', 'failed', 1, 0, ?)`,
      `driver said: ${CANARY}`,
    );

    const result = await tracker.apply(
      definition('0017_old', ['CREATE TABLE old_probe (a TEXT)']),
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('previously failed');
    expect(String(result.error)).not.toContain(CANARY);
    const row = (
      await db.query(
        `SELECT error_message FROM _smrt_schema_migrations WHERE name = ?`,
        '0017_old',
      )
    ).rows[0] as { error_message: string };
    expect(row.error_message).toContain(CANARY);
  });
});

describe.skipIf(process.env.SMRT_TEST_PGLITE !== '1')(
  'migration failures are closed reasons (PostgreSQL)',
  () => {
    let db: DatabaseInterface;
    let runs = 0;

    beforeEach(async () => {
      db = await getTestDatabase({
        type: 'pglite',
        classes: [],
        includeSystemTables: false,
      });
      await db.query('CREATE TABLE jobs (id INT, status TEXT)');
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await db.close?.();
    });

    const migrate = (up: string[]) =>
      new MigrationTracker({ db, engineHint: 'postgres' }).applyAll(
        [definition(`closed_pg_${++runs}`, up)],
        { atomic: true, postgresSafe: true },
      );

    it('closes a failed concurrent index build and its persisted message', async () => {
      const output = captureOutput();
      await db.query(
        `INSERT INTO jobs (id, status) VALUES (1, 'dup'), (2, 'dup')`,
      );

      const [result] = await migrate([
        'ALTER TABLE jobs ADD COLUMN note TEXT',
        `CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_uq ON jobs (status) WHERE status <> '${CANARY}'`,
      ]);

      expect(result.success).toBe(false);
      const message = (result.error as Error).message;
      // The create is the second authored statement, though the first of
      // the concurrent phase.
      expect(message).toContain(`Migration closed_pg_${runs}: statement 2`);
      expect(message).toContain('SQLSTATE 23505');
      expect(message).toContain('(create-index)');
      expect(message).not.toContain('duplicate');
      expect(everyRendering(result.error)).not.toContain(CANARY);
      expect(output()).not.toContain(CANARY);

      const row = (
        await db.query(
          `SELECT error_message FROM _smrt_schema_migrations WHERE name = ?`,
          `closed_pg_${runs}`,
        )
      ).rows[0] as { error_message: string };
      expect(row.error_message).toContain('SQLSTATE 23505');
      expect(row.error_message).not.toContain(CANARY);
      expect(row.error_message).not.toContain('duplicate');
    });

    it('reports the authored position of a regular statement after a deferred index', async () => {
      const result = await new MigrationTracker({
        db,
        engineHint: 'postgres',
      }).apply(
        definition('closed_pg_regular', [
          'CREATE INDEX IF NOT EXISTS jobs_id_idx ON jobs (id)',
          `ALTER TABLE jobs ADD COLUMN flag INT DEFAULT '${CANARY}'`,
        ]),
        { postgresSafe: true },
      );

      const error = result.error as MigrationStatementFailure;
      expect(error).toBeInstanceOf(MigrationStatementFailure);
      expect(error.statementOrdinal).toBe(2);
      expect(error.statementKind).toBe('alter-table');
      expect(everyRendering(error)).not.toContain(CANARY);
    });

    it('reports a failed unique-index swap close at the authored drop', async () => {
      await db.query('CREATE UNIQUE INDEX jobs_id_uq ON jobs (id)');
      const query = db.query.bind(db);
      (db as { query: unknown }).query = async (
        sql: string,
        ...values: unknown[]
      ) => {
        if (
          /^DROP INDEX CONCURRENTLY IF EXISTS "public"\."jobs_id_uq"$/.test(sql)
        )
          throw Object.assign(new Error(`lock timeout ${CANARY}`), {
            code: '55P03',
          });
        return query(sql, ...values);
      };

      const [result] = await migrate([
        'ALTER TABLE jobs ADD COLUMN tag TEXT',
        'DROP INDEX IF EXISTS jobs_id_uq',
        'CREATE UNIQUE INDEX IF NOT EXISTS jobs_id_uq ON jobs (id, status)',
      ]);

      const error = result.error as MigrationStatementFailure;
      expect(error).toBeInstanceOf(MigrationStatementFailure);
      expect(error.message).toContain(
        'statement 2 (generated swap close, drop-index) failed in the concurrent-index phase (SQLSTATE 55P03',
      );
      expect(everyRendering(error)).not.toContain(CANARY);
    });

    it('redacts a failure inside the expression check probe', async () => {
      const output = captureOutput();

      const failure = await migrate([
        `CREATE INDEX IF NOT EXISTS jobs_probe_idx ON jobs ((lower(missing_col) || '${CANARY}'))`,
      ]).then(
        (results) => results[0]?.error as Error,
        (error: Error) => error,
      );

      // A closed failure of the check, named for its migration.
      expect(failure).toBeInstanceOf(MigrationStatementFailure);
      const closed = failure as MigrationStatementFailure;
      expect(closed.code).toBe('42703');
      expect(closed.phase).toBe('index-check');
      expect(closed.statementOrdinal).toBe(1);
      expect(closed.message).toMatch(
        new RegExp(`^Migration closed_pg_${runs}: `),
      );
      const text = everyRendering(failure);
      expect(text).toContain('cannot be checked');
      expect(text).toContain('SQLSTATE 42703');
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain('missing_col');
      expect(text).not.toContain('does not exist');
      expect(output()).not.toContain(CANARY);
    });

    it('closes a failed expression check on direct apply, named for its migration', async () => {
      const result = await new MigrationTracker({
        db,
        engineHint: 'postgres',
      }).apply(
        definition('probe_direct', [
          `CREATE INDEX IF NOT EXISTS jobs_probe2_idx ON jobs ((lower(missing_col) || '${CANARY}'))`,
        ]),
        { postgresSafe: true },
      );

      const closed = result.error as MigrationStatementFailure;
      expect(closed).toBeInstanceOf(MigrationStatementFailure);
      expect(closed.code).toBe('42703');
      expect(closed.phase).toBe('index-check');
      expect(closed.message).toMatch(
        /^Migration probe_direct: statement 1 \(create-index\)/,
      );
      expect(everyRendering(closed)).not.toContain(CANARY);
    });

    it('reports a failed INVALID-index repair at the CREATE that needed it', async () => {
      const query = db.query.bind(db);
      (db as { query: unknown }).query = async (
        sql: string,
        ...values: unknown[]
      ) => {
        if (/WHERE i\.indisvalid = false/.test(sql))
          return {
            rows: [{ schema_name: 'public', index_name: 'jobs_rep_idx' }],
          };
        if (
          sql.startsWith(
            'DROP INDEX CONCURRENTLY IF EXISTS "public"."jobs_rep_idx"',
          )
        )
          throw Object.assign(new Error(`lock ${CANARY}`), { code: '55P03' });
        return query(sql, ...values);
      };

      const result = await new MigrationTracker({
        db,
        engineHint: 'postgres',
      }).apply(
        definition('repair_ordinal', [
          'ALTER TABLE jobs ADD COLUMN rep INT',
          'CREATE INDEX IF NOT EXISTS jobs_rep_idx ON jobs (id)',
        ]),
        { postgresSafe: true },
      );

      const closed = result.error as MigrationStatementFailure;
      expect(closed).toBeInstanceOf(MigrationStatementFailure);
      expect(closed.statementOrdinal).toBe(2);
      expect(closed.statementKind).toBe('drop-index');
      expect(closed.code).toBe('55P03');
      expect(everyRendering(closed)).not.toContain(CANARY);
    });

    it('keeps the primary failure when releasing the session also fails', async () => {
      await db.query(`INSERT INTO jobs (id, status) VALUES (1, 'd'), (2, 'd')`);
      const query = db.query.bind(db);
      (db as { acquireSession?: unknown }).acquireSession = async () => ({
        query: (sql: string, ...values: unknown[]) => query(sql, ...values),
        release: async () => {
          throw new Error(`release failed ${CANARY}`);
        },
      });

      const result = await new MigrationTracker({
        db,
        engineHint: 'postgres',
      }).apply(
        definition('release_primary', [
          'CREATE UNIQUE INDEX IF NOT EXISTS jobs_status_rel_uq ON jobs (status)',
        ]),
        { postgresSafe: true },
      );

      const closed = result.error as MigrationStatementFailure;
      expect(closed).toBeInstanceOf(MigrationStatementFailure);
      expect(closed.code).toBe('23505');
      expect(everyRendering(closed)).not.toContain(CANARY);

      // A release that fails alone is closed too.
      const alone = await new MigrationTracker({
        db,
        engineHint: 'postgres',
      }).apply(
        definition('release_alone', [
          'CREATE INDEX IF NOT EXISTS jobs_id_rel_idx ON jobs (id)',
        ]),
        { postgresSafe: true },
      );
      expect(alone.error).toBeInstanceOf(MigrationStatementFailure);
      expect(everyRendering(alone.error)).not.toContain(CANARY);
    });

    describe('a deferred foreign key violated at commit', () => {
      beforeEach(async () => {
        await db.query('CREATE TABLE owners (id TEXT PRIMARY KEY)');
        await db.query(
          'CREATE TABLE pets (owner TEXT REFERENCES owners (id) DEFERRABLE INITIALLY DEFERRED)',
        );
      });
      const violating = (id: string) =>
        definition(id, [`INSERT INTO pets (owner) VALUES ('${CANARY}')`]);

      it('persists and returns only the closed reason (apply)', async () => {
        const output = captureOutput();
        const tracker = new MigrationTracker({ db, engineHint: 'postgres' });

        const result = await tracker.apply(violating('deferred_apply'));

        expect(result.success).toBe(false);
        expect((result.error as Error).message).toBe(
          'Migration deferred_apply: the migration failed in the commit phase (SQLSTATE 23503; database message withheld)',
        );
        const row = (
          await db.query(
            `SELECT error_message FROM _smrt_schema_migrations WHERE name = ?`,
            'deferred_apply',
          )
        ).rows[0] as { error_message: string };
        const text = [
          everyRendering(result.error),
          row.error_message,
          output(),
        ].join('\n');
        expect(row.error_message).toBe((result.error as Error).message);
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain('is not present in table');
      });

      it('throws only the closed reason (atomic applyAll)', async () => {
        const output = captureOutput();
        const tracker = new MigrationTracker({ db, engineHint: 'postgres' });

        const thrown = await tracker
          .applyAll([violating('deferred_atomic')], { atomic: true })
          .then(
            () => null,
            (error: unknown) => error,
          );

        expect(thrown).toBeInstanceOf(MigrationStatementFailure);
        const error = thrown as Error & {
          context?: { originalError?: unknown };
        };
        expect(error.message).toBe(
          'Migration deferred_atomic: the migration failed in the commit phase (SQLSTATE 23503; database message withheld)',
        );
        // What `db:migrate` prints for a failed atomic batch.
        console.error(`  ✗ atomic schema migration failed: ${error.message}`);
        if (error.context?.originalError)
          console.error(`     Cause: ${String(error.context.originalError)}`);
        console.error(error);
        const text = [everyRendering(error), output()].join('\n');
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain('is not present in table');
      });
    });

    describe('guards', () => {
      it('closes an authored DO block that imitates a framework guard', async () => {
        const result = await new MigrationTracker({
          db,
          engineHint: 'postgres',
        }).apply(
          definition('imitation_do', [
            `DO $$ BEGIN IF true THEN RAISE EXCEPTION '${CANARY}'; END IF; END $$`,
          ]),
        );

        const error = result.error as MigrationStatementFailure;
        expect(error).toBeInstanceOf(MigrationStatementFailure);
        expect(error.code).toBe('P0001');
        expect(everyRendering(error)).not.toContain(CANARY);
      });

      it('keeps a framework guard message raised by the guard itself', async () => {
        const reason = 'smrt pg guard 5b0d: a stored value differs';
        const guard = frameworkGuardStatement(
          `DO $$ BEGIN IF true THEN RAISE EXCEPTION '${reason}' USING ERRCODE = ${FRAMEWORK_GUARD_ERRCODE_SQL}; END IF; END $$`,
          'postgres',
          [reason],
        );

        const result = await new MigrationTracker({
          db,
          engineHint: 'postgres',
        }).apply(definition('own_do', [guard]));

        expect(result.error).not.toBeInstanceOf(MigrationStatementFailure);
        expect((result.error as Error).message).toBe(reason);
        expect((result.error as { code?: unknown }).code).toBe(
          FRAMEWORK_GUARD_SQLSTATE,
        );
      });

      it('closes a P0001 raised inside a framework guard by an authored function', async () => {
        const reason = 'smrt pg guard 77aa: a stored value differs';
        await db.query(
          `CREATE FUNCTION raise_inside() RETURNS boolean LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION '${CANARY}'; END $f$`,
        );
        const guard = frameworkGuardStatement(
          `DO $$ BEGIN IF raise_inside() THEN RAISE EXCEPTION '${reason}' USING ERRCODE = ${FRAMEWORK_GUARD_ERRCODE_SQL}; END IF; END $$`,
          'postgres',
          [reason],
        );

        const result = await new MigrationTracker({
          db,
          engineHint: 'postgres',
        }).apply(definition('inner_raise', [guard]));

        const error = result.error as MigrationStatementFailure;
        expect(error).toBeInstanceOf(MigrationStatementFailure);
        expect(error.code).toBe('P0001');
        expect(error.message).not.toContain(reason);
        expect(everyRendering(error)).not.toContain(CANARY);
      });

      it('closes a framework guard that fails evaluating its condition', async () => {
        const reason = 'smrt pg guard 9e44: a stored value differs';
        await db.query(`INSERT INTO jobs (id, status) VALUES (0, '${CANARY}')`);
        const guard = frameworkGuardStatement(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM jobs WHERE 1 / id = 1 OR status::int = 1) THEN RAISE EXCEPTION '${reason}'; END IF; END $$`,
          'postgres',
          [reason],
        );

        const result = await new MigrationTracker({
          db,
          engineHint: 'postgres',
        }).apply(definition('eval_do', [guard]));

        const error = result.error as MigrationStatementFailure;
        expect(error).toBeInstanceOf(MigrationStatementFailure);
        expect(error.code).not.toBe('P0001');
        expect(everyRendering(error)).not.toContain(CANARY);
        expect(error.message).not.toContain(reason);
      });
    });
  },
);
