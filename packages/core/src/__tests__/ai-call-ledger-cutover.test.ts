/**
 * The 1.21.0 cutover of the AI call ledger (#5516, plan sections 3.9 and 7;
 * test contract T14). Two renames close the tables to every older
 * accounting and usage insert; the bootstrap refuses to make them while a
 * live reservation is outstanding, carries stale ones over, is repeatable
 * when interrupted, and can be rolled back by the documented statements.
 * File-backed SQLite and DuckDB (PGlite in its lane; PostgreSQL's table
 * lock in the optional file).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiUsageRecorder } from '../adapters/ai-usage-recorder';
import {
  AI_RUN_CUTOVER_ABANDON_ENV,
  readAiRunCutoverOverride,
} from '../system/ai-call-ledger-schema';
import { ensureSystemTables } from '../system/bootstrap';
import { openAiRun, SMRT_SCHEMA_VERSION } from '../system/browser';
import {
  columnsOf,
  downgradeToV120,
  indexesOf,
  insertV120Reservation,
  runV120Bootstrap,
  V1_20_WRITERS,
} from './fixtures/ai-call-ledger-v1-20';
import { LEGACY_AI_RUN_DDL } from './fixtures/ai-run-legacy-schema';
import {
  type AiRunTestEngine,
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

const dirs: string[] = [];
afterEach(async () => {
  delete process.env[AI_RUN_CUTOVER_ABANDON_ENV];
  vi.restoreAllMocks();
  await closeAiRunTestDatabases();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const MINUTE = 60_000;
const hint = (engine: AiRunTestEngine) =>
  engine === 'pglite' ? 'postgres' : engine;

async function fileDatabase(engine: AiRunTestEngine) {
  if (engine === 'pglite') return newAiRunTestDatabase(engine);
  const dir = mkdtempSync(
    join(process.env.TMPDIR ?? tmpdir(), 'smrt-cutover-'),
  );
  dirs.push(dir);
  return newAiRunTestDatabase(engine, join(dir, `db.${engine}`));
}

async function v120(engine: AiRunTestEngine) {
  const db = await fileDatabase(engine);
  await downgradeToV120(db, engine);
  return db;
}

async function stamps(db: Awaited<ReturnType<typeof v120>>) {
  return rowsOf(
    await db.query('SELECT version FROM _smrt_migrations ORDER BY version'),
  ).map((row) => String(row.version));
}

const columnNames = async (
  db: Awaited<ReturnType<typeof v120>>,
  table: string,
  engine: AiRunTestEngine,
) => (await columnsOf(db, table, engine)).map((column) => column.name);

describe('the cutover override', () => {
  it('is read only where process exists', () => {
    expect(readAiRunCutoverOverride({})).toBeUndefined();
    expect(
      readAiRunCutoverOverride({
        process: { env: { [AI_RUN_CUTOVER_ABANDON_ENV]: 'evt-1' } },
      }),
    ).toBe('evt-1');
  });
});

describe.each(aiRunTestEngines)('1.21.0 cutover on %s', (engine) => {
  it('a live long call blocks the cutover and nothing is altered', async () => {
    const db = await v120(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      {
        type: 'turn',
        budget: { callTimeoutMs: 2 * 60 * MINUTE },
      },
    );
    const eventId = await insertV120Reservation(db, {
      runId: run.id,
      callId: 'live-call',
      createdAt: new Date(Date.now() - 70 * MINUTE),
    });
    const error = await ensureSystemTables(db, hint(engine)).catch((e) => e);
    expect(error).toMatchObject({
      code: 'AI_RUN_CUTOVER_BLOCKED',
      details: expect.objectContaining({ count: 1, oldestEventId: eventId }),
    });
    expect(await columnNames(db, '_smrt_ai_run_events', engine)).toContain(
      'reservation',
    );
    expect(await columnNames(db, '_smrt_ai_usage', engine)).toContain(
      'duration',
    );
    expect(await stamps(db)).toEqual(['1.20.0']);
  });

  it('a reservation past its threshold does not block; it is carried over and counted in a warning', async () => {
    const db = await v120(engine);
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation(
      (...args) => void warnings.push(args.join(' ')),
    );
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      { type: 'turn' },
    );
    await insertV120Reservation(db, {
      runId: run.id,
      callId: 'stale-call',
      createdAt: new Date(Date.now() - 2 * 60 * MINUTE),
    });
    await ensureSystemTables(db, hint(engine));
    const row = rowsOf(
      await db.query(
        "SELECT call_state, call_proof FROM _smrt_ai_run_events WHERE call_id = 'stale-call'",
      ),
    )[0];
    expect(row).toEqual({ call_state: 'reserved', call_proof: null });
    expect(warnings.join('\n')).toMatch(/1 stale AI call reservation/);
    expect(await stamps(db)).toContain(SMRT_SCHEMA_VERSION);
  });

  it('the override naming the oldest live reservation abandons it and proceeds; any other value does not', async () => {
    const db = await v120(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      {
        type: 'turn',
        budget: { callTimeoutMs: 2 * 60 * MINUTE },
      },
    );
    const oldest = await insertV120Reservation(db, {
      runId: run.id,
      callId: 'live-a',
      createdAt: new Date(Date.now() - 30 * MINUTE),
    });
    await insertV120Reservation(db, {
      runId: run.id,
      callId: 'live-b',
      createdAt: new Date(Date.now() - 10 * MINUTE),
    });
    process.env[AI_RUN_CUTOVER_ABANDON_ENV] = 'evt-live-b';
    await expect(ensureSystemTables(db, hint(engine))).rejects.toMatchObject({
      code: 'AI_RUN_CUTOVER_BLOCKED',
    });
    process.env[AI_RUN_CUTOVER_ABANDON_ENV] = oldest;
    await ensureSystemTables(db, hint(engine));
    const states = rowsOf(
      await db.query(
        "SELECT call_id, call_state FROM _smrt_ai_run_events WHERE type = 'call' ORDER BY call_id",
      ),
    );
    expect(states).toEqual([
      { call_id: 'live-a', call_state: 'abandoned' },
      { call_id: 'live-b', call_state: 'abandoned' },
    ]);
    const totals = rowsOf(
      await db.query(
        'SELECT reserved_calls, reserved_tokens FROM _smrt_ai_runs WHERE id = $1',
        run.id,
      ),
    )[0];
    expect(Number(totals?.reserved_calls)).toBe(0);
    expect(Number(totals?.reserved_tokens)).toBe(0);
  });

  it('an upgraded database has the same columns and indexes as a fresh one, and keeps its rows', async () => {
    const fresh = await fileDatabase(engine);
    const db = await v120(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      { type: 'turn' },
    );
    await V1_20_WRITERS['usage-row insert']?.(db, {
      runId: run.id,
      callId: 'kept',
    });
    await ensureSystemTables(db, hint(engine));
    for (const table of [
      '_smrt_ai_run_events',
      '_smrt_ai_usage',
      '_smrt_ai_runs',
    ]) {
      expect(await columnsOf(db, table, engine)).toEqual(
        await columnsOf(fresh, table, engine),
      );
      expect(await indexesOf(db, table, engine)).toEqual(
        await indexesOf(fresh, table, engine),
      );
    }
    const row = rowsOf(
      await db.query(
        "SELECT duration_ms FROM _smrt_ai_usage WHERE id = 'kept-row'",
      ),
    )[0];
    expect(Number(row?.duration_ms)).toBe(5);
  });

  it.each([
    'events renamed only',
    'both renamed, no columns',
    'some columns added',
  ] as const)('an interrupted cutover (%s) converges when rerun', async (step) => {
    const fresh = await fileDatabase(engine);
    const db = await v120(engine);
    if (engine === 'duckdb') {
      for (const row of rowsOf(
        await db.query(
          "SELECT index_name FROM duckdb_indexes() WHERE table_name IN ('_smrt_ai_run_events', '_smrt_ai_usage')",
        ),
      )) {
        await db.query(`DROP INDEX IF EXISTS ${String(row.index_name)}`);
      }
    }
    await db.query(
      'ALTER TABLE _smrt_ai_run_events RENAME COLUMN reservation TO call_state',
    );
    if (step !== 'events renamed only') {
      await db.query(
        'ALTER TABLE _smrt_ai_usage RENAME COLUMN duration TO duration_ms',
      );
    }
    if (step === 'some columns added') {
      await db.query(
        'ALTER TABLE _smrt_ai_run_events ADD COLUMN call_proof TEXT',
      );
    }
    await ensureSystemTables(db, hint(engine));
    for (const table of ['_smrt_ai_run_events', '_smrt_ai_usage']) {
      expect(await columnsOf(db, table, engine)).toEqual(
        await columnsOf(fresh, table, engine),
      );
      expect(await indexesOf(db, table, engine)).toEqual(
        await indexesOf(fresh, table, engine),
      );
    }
  });

  it('a populated pre-1.15 usage table gains every later column', async () => {
    const fresh = await fileDatabase(engine);
    const db = await fileDatabase(engine);
    for (const table of [
      '_smrt_ai_usage',
      '_smrt_ai_runs',
      '_smrt_ai_evaluations',
      '_smrt_ai_run_events',
    ]) {
      await db.query(`DROP TABLE IF EXISTS ${table}`);
    }
    await db.query('DELETE FROM _smrt_migrations');
    for (const statement of LEGACY_AI_RUN_DDL) await db.query(statement);
    await db.query(
      `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration, created_at)
       VALUES ('legacy-1', 'openai', 'gpt-4o', 'message', 9, '2025-01-01T00:00:00.000Z')`,
    );
    await ensureSystemTables(db, hint(engine));
    expect(await columnNames(db, '_smrt_ai_usage', engine)).toEqual(
      await columnNames(fresh, '_smrt_ai_usage', engine),
    );
    const row = rowsOf(
      await db.query(
        "SELECT duration_ms FROM _smrt_ai_usage WHERE id = 'legacy-1'",
      ),
    )[0];
    expect(Number(row?.duration_ms)).toBe(9);
  });

  it.each([
    'stamp removed',
    'stamp left in place',
  ] as const)('the documented rollback lets a 1.20.0 write succeed and the re-upgrade work (%s)', async (variant) => {
    const db = await fileDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      { type: 'turn' },
    );
    if (engine === 'duckdb') {
      for (const row of rowsOf(
        await db.query(
          "SELECT index_name FROM duckdb_indexes() WHERE table_name IN ('_smrt_ai_run_events', '_smrt_ai_usage')",
        ),
      )) {
        await db.query(`DROP INDEX IF EXISTS ${String(row.index_name)}`);
      }
    }
    await db.query(
      'ALTER TABLE _smrt_ai_run_events RENAME COLUMN call_state TO reservation',
    );
    await db.query(
      'ALTER TABLE _smrt_ai_usage RENAME COLUMN duration_ms TO duration',
    );
    if (variant === 'stamp removed') {
      await db.query(
        `DELETE FROM _smrt_migrations WHERE version = '${SMRT_SCHEMA_VERSION}'`,
      );
    }
    for (const writer of [
      'event insert',
      'usage-row insert',
      'external-agent insert',
    ]) {
      await V1_20_WRITERS[writer]?.(db, {
        runId: run.id,
        callId: `rb-${writer.replace(/\W/g, '')}`,
      });
    }
    await ensureSystemTables(db, hint(engine));
    expect(await columnNames(db, '_smrt_ai_run_events', engine)).toContain(
      'call_state',
    );
    expect(await columnNames(db, '_smrt_ai_usage', engine)).toContain(
      'duration_ms',
    );
  });

  it.each(
    Object.keys(V1_20_WRITERS).filter(
      (name) => name !== 'trajectory prune' || true,
    ),
  )('the 1.20.0 %s fails against the new schema', async (name) => {
    const db = await fileDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      { type: 'turn' },
    );
    await expect(
      V1_20_WRITERS[name]?.(db, { runId: run.id, callId: 'old' }),
    ).rejects.toThrow();
  });

  it("1.20.0's bootstrap on a database created at 1.21.0 completes and its inserts still fail", async () => {
    const db = await fileDatabase(engine);
    await runV120Bootstrap(db, engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      { type: 'turn' },
    );
    for (const writer of [
      'event insert',
      'usage-row insert',
      'external-agent insert',
    ]) {
      await expect(
        V1_20_WRITERS[writer]?.(db, { runId: run.id, callId: 'old' }),
      ).rejects.toThrow();
    }
    expect(await columnNames(db, '_smrt_ai_usage', engine)).not.toContain(
      'duration',
    );
  });

  it("a pre-1.21.0 call's delayed event is refused and writes no second row", async () => {
    const db = await v120(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 't' },
      { type: 'turn' },
    );
    await insertV120Reservation(db, {
      runId: run.id,
      callId: 'old-call',
      createdAt: new Date(Date.now() - 2 * 60 * MINUTE),
    });
    await ensureSystemTables(db, hint(engine));
    await createAiUsageRecorder({ db, tenantId: 't' })({
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'message',
      usage: { totalTokens: 9 },
      duration: 1,
      timestamp: new Date(),
      tags: { aiCallId: 'old-call', runId: run.id },
    });
    expect(
      rowsOf(await db.query('SELECT id FROM _smrt_ai_usage')),
    ).toHaveLength(0);
  });
});
