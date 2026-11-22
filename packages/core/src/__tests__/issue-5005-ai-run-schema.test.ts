/**
 * The AI run schema upgrade (#5005): a 1.16.0 database holding the fusion-only
 * `_smrt_ai_runs`, the label table `_smrt_ai_usage_outcomes` and an
 * `_smrt_ai_usage` with the shared call id ends, unattended, in exactly the
 * shape a fresh install has, with its rows carried across; and every step is
 * idempotent.
 *
 * Runs on real in-memory SQLite and DuckDB; PGlite joins when the lane sets
 * `SMRT_TEST_PGLITE=1` (`pnpm test:pglite`). Never mocks the database.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listAiEvaluations,
  recordAiEvaluation,
} from '../system/ai-usage-observability';
import { ensureSystemTables } from '../system/bootstrap';
import {
  ensureBootstrapSystemTableCompatibility,
  getDatabaseEngine,
} from '../system/compatibility';
import {
  CREATE_SMRT_AI_RUN_EVENTS_TABLE,
  CREATE_SMRT_AI_RUNS_TABLE,
  getSystemTableDDLForEngine,
  SMRT_SCHEMA_VERSION,
} from '../system/schema';
import { getTestDatabase } from '../testing/database';
import {
  LEGACY_AI_RUN_DDL,
  seedLegacyAiRunRows,
} from './fixtures/ai-run-legacy-schema';

type Engine = 'sqlite' | 'duckdb' | 'pglite';

const engines: Engine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

const AI_TABLES = [
  '_smrt_ai_usage',
  '_smrt_ai_runs',
  '_smrt_ai_run_events',
  '_smrt_ai_run_checkpoints',
  '_smrt_ai_evaluations',
  '_smrt_ai_usage_outcomes',
  '_smrt_ai_transcripts',
];

const open: DatabaseInterface[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) await db.close?.();
});

async function newDatabase(engine: Engine): Promise<DatabaseInterface> {
  const db =
    engine === 'pglite'
      ? await getTestDatabase({
          type: 'pglite',
          classes: [],
          includeSystemTables: false,
        })
      : ((await getDatabase({
          type: engine,
          url: ':memory:',
        })) as DatabaseInterface);
  open.push(db);
  return db;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function engineOf(engine: Engine): 'sqlite' | 'duckdb' | 'postgres' {
  return engine === 'pglite' ? 'postgres' : engine;
}

async function createLegacy(
  db: DatabaseInterface,
  engine: Engine,
): Promise<void> {
  for (const statement of LEGACY_AI_RUN_DDL) {
    await db.query(getSystemTableDDLForEngine(statement, engineOf(engine)));
  }
}

async function bootstrap(db: DatabaseInterface, engine: Engine) {
  await ensureSystemTables(db, engineOf(engine));
}

interface TableShape {
  columns: string[];
  indexes: string[];
}

/** Columns (`name:type:notnull`) and named indexes of each AI system table. */
async function readShape(
  db: DatabaseInterface,
  engine: Engine,
): Promise<Record<string, TableShape>> {
  const shape: Record<string, TableShape> = {};
  for (const table of AI_TABLES) {
    let columns: string[];
    let indexes: string[];
    if (engine === 'pglite') {
      columns = rowsOf(
        await db.query(
          `SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = $1`,
          table,
        ),
      ).map(
        (row) =>
          `${row.column_name}:${row.data_type}:${row.is_nullable === 'NO' ? 1 : 0}`,
      );
      indexes = rowsOf(
        await db.query(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = current_schema() AND tablename = $1`,
          table,
        ),
      ).map((row) => String(row.indexname));
    } else if (
      !(await db.query(`SELECT 1 FROM ${table} LIMIT 1`).then(
        () => true,
        () => false,
      ))
    ) {
      columns = [];
      indexes = [];
    } else {
      columns = rowsOf(await db.query(`PRAGMA table_info(${table})`)).map(
        (row) => {
          // SQLite keeps a column's declared type text, but REAL and DOUBLE
          // PRECISION are the same 8-byte float there (schema 1.21.0).
          const type = String(row.type).toUpperCase();
          return `${row.name}:${engine === 'sqlite' && type === 'REAL' ? 'DOUBLE PRECISION' : type}:${Number(row.notnull)}:${row.dflt_value ?? ''}`;
        },
      );
      if (engine === 'sqlite') {
        indexes = rowsOf(await db.query(`PRAGMA index_list(${table})`))
          .map((row) => String(row.name))
          .filter((name) => !name.startsWith('sqlite_autoindex_'));
      } else {
        indexes = rowsOf(
          await db.query(
            `SELECT index_name FROM duckdb_indexes() WHERE table_name = '${table}'`,
          ),
        ).map((row) => String(row.index_name));
      }
    }
    shape[table] = { columns: columns.sort(), indexes: indexes.sort() };
  }
  return shape;
}

describe.each(engines)('AI run schema upgrade on %s (#5005)', (engine) => {
  it('ends a 1.16.0 database in the fresh-install shape', async () => {
    const fresh = await newDatabase(engine);
    await bootstrap(fresh, engine);
    const freshShape = await readShape(fresh, engine);

    const upgraded = await newDatabase(engine);
    await createLegacy(upgraded, engine);
    await seedLegacyAiRunRows(upgraded);
    await bootstrap(upgraded, engine);
    const upgradedShape = await readShape(upgraded, engine);

    // The old label table is gone; the new tables exist on both.
    expect(freshShape._smrt_ai_usage_outcomes?.columns).toEqual([]);
    for (const table of AI_TABLES) {
      expect(upgradedShape[table], `${table} differs`).toEqual(
        freshShape[table],
      );
    }
    for (const table of [
      '_smrt_ai_run_events',
      '_smrt_ai_run_checkpoints',
      '_smrt_ai_evaluations',
    ]) {
      expect(freshShape[table]?.columns.length).toBeGreaterThan(0);
    }
    expect(freshShape._smrt_ai_runs?.columns).not.toContain(
      expect.stringMatching(/^fusion_key:/),
    );
    expect(
      freshShape._smrt_ai_usage?.indexes.some((name) =>
        name.endsWith('_usage_call'),
      ),
    ).toBe(false);
  });

  it('carries usage rows across: id is the call id, the shared id moves to entry_call_id', async () => {
    const db = await newDatabase(engine);
    await createLegacy(db, engine);
    await seedLegacyAiRunRows(db);
    await bootstrap(db, engine);

    const usage = rowsOf(
      await db.query(
        'SELECT id, call_id, entry_call_id FROM _smrt_ai_usage ORDER BY id',
      ),
    );
    const byId = Object.fromEntries(usage.map((row) => [String(row.id), row]));
    for (const row of usage) expect(row.call_id).toBe(row.id);
    expect(byId['u-seat-1']?.entry_call_id).toBe('fusion-call');
    expect(byId['u-seat-3']?.entry_call_id).toBe('fusion-call');
    expect(byId['u-solo']?.entry_call_id).toBe('solo-call');
    // A row that had no call id is its own entry call.
    expect(byId['u-none']?.entry_call_id).toBe('u-none');
    // Step columns arrive empty.
    const step = rowsOf(
      await db.query(
        'SELECT step_index, step_name, step_instance_id, attempt, template_hash FROM _smrt_ai_usage WHERE id = $1',
        'u-solo',
      ),
    );
    expect(step).toEqual([
      {
        step_index: null,
        step_name: null,
        step_instance_id: null,
        attempt: null,
        template_hash: null,
      },
    ]);
  });

  it('maps fusion runs to the run vocabulary', async () => {
    const db = await newDatabase(engine);
    await createLegacy(db, engine);
    await seedLegacyAiRunRows(db);
    await bootstrap(db, engine);

    const runs = rowsOf(
      await db.query(
        `SELECT id, type, definition_key, status, degraded, stop_reason, mode,
                seats, degraded_seats, duration, started_at, finished_at, created_at,
                tokens, inclusive_calls, retain
           FROM _smrt_ai_runs ORDER BY id`,
      ),
    );
    const byId = Object.fromEntries(runs.map((row) => [String(row.id), row]));
    expect(byId['run-ok']).toMatchObject({
      type: 'fusion',
      definition_key: 'review',
      status: 'done',
      stop_reason: null,
      mode: 'pair',
      seats: 3,
      degraded_seats: 1,
      duration: 4000,
      tokens: 0,
      inclusive_calls: 0,
      retain: 0,
    });
    expect(Number(byId['run-ok']?.degraded)).toBe(0);
    expect(byId['run-deg']).toMatchObject({ status: 'done' });
    expect(Number(byId['run-deg']?.degraded)).toBe(1);
    expect(byId['run-bad']).toMatchObject({
      status: 'failed',
      stop_reason: 'error',
    });
    const at = (value: unknown) =>
      value instanceof Date
        ? value.getTime()
        : new Date(String(value)).getTime();
    for (const [id, duration] of [
      ['run-ok', 4000],
      ['run-deg', 500],
      ['run-bad', 0],
    ] as const) {
      const row = byId[id];
      expect(at(row?.finished_at)).toBe(at(row?.created_at));
      expect(at(row?.created_at) - at(row?.started_at)).toBe(duration);
    }
  });

  it('carries outcome labels into evaluations', async () => {
    const db = await newDatabase(engine);
    await createLegacy(db, engine);
    await seedLegacyAiRunRows(db);
    await bootstrap(db, engine);

    const rows = rowsOf(
      await db.query(
        `SELECT id, call_id, run_id, metric, value, value_type, scale, label,
                evidence, evaluator, tenant_id FROM _smrt_ai_evaluations ORDER BY id`,
      ),
    );
    const byId = Object.fromEntries(rows.map((row) => [String(row.id), row]));
    expect(rows).toHaveLength(7);
    expect(byId['l-usage']).toMatchObject({
      call_id: 'u-solo',
      run_id: null,
      metric: 'outcome',
      value: '0.5',
      value_type: 'number',
      scale: null,
      label: 'accepted',
      evidence: '{"why":"x"}',
      evaluator: 'reviewer',
      tenant_id: 't1',
    });
    // A label naming a usage row and a run judges the row.
    expect(byId['l-usage-and-run']).toMatchObject({
      call_id: 'u-seat-1',
      run_id: null,
      value: null,
    });
    expect(byId['l-run']).toMatchObject({ call_id: null, run_id: 'run-f' });
    // An entry call with one call: that call.
    expect(byId['l-solo-call']).toMatchObject({
      call_id: 'u-solo',
      run_id: null,
    });
    // An entry call with several calls sharing a run: that run.
    expect(byId['l-fusion-call']).toMatchObject({
      call_id: null,
      run_id: 'run-f',
    });
    // Several calls and no run: the latest call.
    expect(byId['l-chain-call']?.run_id).toBeNull();
    expect(['u-chain-1', 'u-chain-2']).toContain(byId['l-chain-call']?.call_id);
    // Usage already pruned: the entry call id is kept as the target.
    expect(byId['l-pruned-call']).toMatchObject({
      call_id: 'gone-call',
      run_id: null,
    });
  });

  it('is idempotent: every step run again changes nothing', async () => {
    const db = await newDatabase(engine);
    await createLegacy(db, engine);
    await seedLegacyAiRunRows(db);
    await bootstrap(db, engine);
    // A row an older writer added after the upgrade (the external-agent
    // insert once left both ids NULL): the next pass splits it, once.
    await db.query(
      `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration)
       VALUES ('external-agent:late', 'openai', 'gpt-4o', 'external-agent', 0)`,
    );
    await db.query(
      'DELETE FROM _smrt_migrations WHERE version = $1',
      SMRT_SCHEMA_VERSION,
    );
    await bootstrap(db, engine);
    expect(
      rowsOf(
        await db.query(
          "SELECT call_id, entry_call_id FROM _smrt_ai_usage WHERE id = 'external-agent:late'",
        ),
      )[0],
    ).toEqual({
      call_id: 'external-agent:late',
      entry_call_id: 'external-agent:late',
    });

    const snapshot = async () => ({
      shape: await readShape(db, engine),
      usage: rowsOf(await db.query('SELECT * FROM _smrt_ai_usage ORDER BY id')),
      runs: rowsOf(await db.query('SELECT * FROM _smrt_ai_runs ORDER BY id')),
      evaluations: rowsOf(
        await db.query('SELECT * FROM _smrt_ai_evaluations ORDER BY id'),
      ),
    });
    const first = await snapshot();

    // The compatibility steps alone, twice.
    await ensureBootstrapSystemTableCompatibility(db, engineOf(engine));
    await ensureBootstrapSystemTableCompatibility(db, engineOf(engine));
    expect(await snapshot()).toEqual(first);

    // A full bootstrap again, as after the stamp was lost.
    await db.query(
      'DELETE FROM _smrt_migrations WHERE version = $1',
      SMRT_SCHEMA_VERSION,
    );
    await bootstrap(db, engine);
    expect(await snapshot()).toEqual(first);
    expect(getDatabaseEngine(db, engineOf(engine))).toBe(engineOf(engine));
  });

  it('finishes a rebuild interrupted after the old run table was dropped', async () => {
    const db = await newDatabase(engine);
    await createLegacy(db, engine);
    await seedLegacyAiRunRows(db);
    // The rebuild's first steps, stopping before the rename.
    await db.query(
      getSystemTableDDLForEngine(
        (CREATE_SMRT_AI_RUNS_TABLE.split(';')[0] ?? '').replace(
          '_smrt_ai_runs',
          '_smrt_ai_runs_new',
        ),
        engineOf(engine),
      ),
    );
    await db.query(
      `INSERT INTO _smrt_ai_runs_new
        (id, type, definition_key, status, mode, seats, degraded_seats,
         duration, created_at)
       SELECT id, 'fusion', fusion_key, status, mode, seats, degraded_seats,
              duration, created_at FROM _smrt_ai_runs`,
    );
    await db.query('DROP TABLE _smrt_ai_runs');

    await bootstrap(db, engine);

    const runs = rowsOf(
      await db.query('SELECT id, status FROM _smrt_ai_runs ORDER BY id'),
    );
    expect(runs).toEqual([
      { id: 'run-bad', status: 'failed' },
      { id: 'run-deg', status: 'done' },
      { id: 'run-ok', status: 'done' },
    ]);
    expect(
      rowsOf(
        await db.query(
          "SELECT stop_reason FROM _smrt_ai_runs WHERE id = 'run-bad'",
        ),
      ),
    ).toEqual([{ stop_reason: 'error' }]);
    const fresh = await newDatabase(engine);
    await bootstrap(fresh, engine);
    expect((await readShape(db, engine))._smrt_ai_runs).toEqual(
      (await readShape(fresh, engine))._smrt_ai_runs,
    );
  });

  it('ends an early 1.17.0 run table (no stop_detail or retry_of_run_id, REAL costs) in the fresh shape', async () => {
    const early = (ddl: string) =>
      ddl
        .replace(/\s*retry_of_run_id TEXT,/, '')
        .replace(/\s*stop_detail TEXT,/, '')
        .replace(/DOUBLE PRECISION/g, 'REAL')
        .replace(
          /CREATE INDEX IF NOT EXISTS idx_smrt_ai_runs_retry_of\s+ON _smrt_ai_runs\(retry_of_run_id\);/,
          '',
        );
    const db = await newDatabase(engine);
    for (const ddl of [
      CREATE_SMRT_AI_RUNS_TABLE,
      CREATE_SMRT_AI_RUN_EVENTS_TABLE,
    ]) {
      for (const statement of getSystemTableDDLForEngine(
        early(ddl),
        engineOf(engine),
      )
        .split(';')
        .map((value) => value.trim())
        .filter(Boolean)) {
        await db.query(statement);
      }
    }
    await db.query(
      `INSERT INTO _smrt_ai_runs (id, type, status, cost_used, inclusive_cost)
       VALUES ('r1', 'workflow', 'running', 0.1, 0.1)`,
    );
    await bootstrap(db, engine);
    const fresh = await newDatabase(engine);
    await bootstrap(fresh, engine);
    // SQLite keeps a column's declared type text, but REAL and DOUBLE
    // PRECISION are the same 8-byte float there, so only its spelling differs.
    const declared = (value: TableShape | undefined) =>
      engine === 'sqlite'
        ? value?.columns.map((column) =>
            column.replace(':DOUBLE PRECISION:', ':REAL:'),
          )
        : value?.columns;
    const shape = await readShape(db, engine);
    const freshShape = await readShape(fresh, engine);
    for (const table of ['_smrt_ai_runs', '_smrt_ai_run_events']) {
      expect(declared(shape[table])).toEqual(declared(freshShape[table]));
      expect(shape[table]?.indexes).toEqual(freshShape[table]?.indexes);
    }
    expect(
      freshShape._smrt_ai_runs?.columns.some((column) =>
        /^cost_used:(DOUBLE|double precision)/.test(column),
      ),
    ).toBe(true);
    const rows = rowsOf(
      await db.query(
        "SELECT stop_detail, retry_of_run_id FROM _smrt_ai_runs WHERE id = 'r1'",
      ),
    );
    expect(rows).toEqual([{ stop_detail: null, retry_of_run_id: null }]);
  });

  it('upgrades a database with no AI tables at all by creating them', async () => {
    const db = await newDatabase(engine);
    await bootstrap(db, engine);
    const rows = rowsOf(
      await db.query(`SELECT type FROM _smrt_ai_runs WHERE id = 'none'`),
    );
    expect(rows).toEqual([]);
  });
});

describe('recordAiEvaluation (#5005)', () => {
  async function withUsage(): Promise<DatabaseInterface> {
    const db = await newDatabase('sqlite');
    await bootstrap(db, 'sqlite');
    await db.query(
      `INSERT INTO _smrt_ai_usage
        (id, provider, model, operation, duration, tenant_id, run_id, call_id, entry_call_id)
       VALUES ('call-1', 'openai', 'gpt-4o', 'chat', 5, 't1', 'run-1', 'call-1', 'call-1')`,
    );
    return db;
  }

  it('stores a typed value, a scale and a grader evaluator, and reads them back', async () => {
    const db = await withUsage();
    const number = await recordAiEvaluation(db, {
      callId: 'call-1',
      metric: 'faithfulness',
      value: 0.75,
      scale: '0..1',
      evaluator: 'grader:faithfulness@2',
    });
    const flag = await recordAiEvaluation(db, {
      runId: 'run-1',
      metric: 'passed',
      value: false,
      evaluator: 'app',
    });
    const text = await recordAiEvaluation(db, {
      callId: 'call-1',
      metric: 'note',
      value: 'too long',
      label: 'edited',
      evaluator: 'human',
    });
    expect(number).toMatchObject({ valueType: 'number', scale: '0..1' });
    expect(flag).toMatchObject({ valueType: 'boolean', value: false });
    expect(text).toMatchObject({ valueType: 'text', label: 'edited' });

    const read = await listAiEvaluations(db, { tenantId: 't1' });
    const byId = Object.fromEntries(read.map((entry) => [entry.id, entry]));
    expect(byId[number.id]).toMatchObject({
      callId: 'call-1',
      runId: null,
      metric: 'faithfulness',
      value: 0.75,
      valueType: 'number',
      scale: '0..1',
      label: null,
      evaluator: 'grader:faithfulness@2',
    });
    expect(byId[flag.id]).toMatchObject({ runId: 'run-1', value: false });
    expect(byId[text.id]?.value).toBe('too long');
    expect(byId[flag.id]?.usage.map((row) => row.id)).toEqual(['call-1']);
  });

  it('refuses both targets, no target, a bad evaluator and a mistyped value', async () => {
    const db = await withUsage();
    const base = { label: 'x', evaluator: 'human' };
    await expect(
      recordAiEvaluation(db, { ...base, callId: 'call-1', runId: 'run-1' }),
    ).rejects.toThrow(/exactly one of callId or runId/);
    await expect(recordAiEvaluation(db, base)).rejects.toThrow(
      /exactly one of callId or runId/,
    );
    for (const evaluator of ['alice', 'grader:x', 'grader:@2', 'Human']) {
      await expect(
        recordAiEvaluation(db, { ...base, callId: 'call-1', evaluator }),
      ).rejects.toThrow(/evaluator must be/);
    }
    await expect(
      recordAiEvaluation(db, {
        callId: 'call-1',
        evaluator: 'human',
        value: 'high',
        valueType: 'number',
      }),
    ).rejects.toThrow(/number value/);
    await expect(
      recordAiEvaluation(db, { callId: 'call-1', evaluator: 'human' }),
    ).rejects.toThrow(/label or a value/);
  });
});
