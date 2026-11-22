/**
 * The run id registry on an upgraded database (docs/content/ai-runs.md
 * section 8, "Run identity"; schema 1.20.0): the system-table bootstrap
 * creates `_smrt_ai_run_ids` and, after its compatibility step and DDL
 * replay and before its version stamp, reserves the digest of every run id
 * that still exists or is still referenced. Once stamped, a bootstrap
 * returns at the stamp. Without the table an open fails closed before any
 * write and creates nothing. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap';
import { checkAiRunIdRegistry, openAiRun } from '../system/browser';
import {
  getSystemTableDDLForEngine,
  SMRT_SCHEMA_VERSION,
} from '../system/schema';
import { getTestDatabase } from '../testing/database';
import {
  LEGACY_AI_RUN_DDL,
  seedLegacyAiRunRows,
} from './fixtures/ai-run-legacy-schema';
import { recordStatements, rowsOf } from './fixtures/ai-run-test-db';

type Engine = 'sqlite' | 'duckdb' | 'pglite';

const engines: Engine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
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

const hint = (engine: Engine) => (engine === 'pglite' ? 'postgres' : engine);

async function digestOf(id: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function registered(db: DatabaseInterface): Promise<Set<string>> {
  return new Set(
    rowsOf(await db.query('SELECT id_digest FROM _smrt_ai_run_ids')).map(
      (row) => String(row.id_digest),
    ),
  );
}

/**
 * The database a 1.19.0 core left: today's tables without the registry and
 * without today's stamp (the DDL is otherwise the same).
 */
async function asSchema119(db: DatabaseInterface, engine: Engine) {
  await ensureSystemTables(db, hint(engine));
  await db.query('DROP TABLE IF EXISTS _smrt_ai_run_ids');
  await db.query(
    `DELETE FROM _smrt_migrations WHERE version = $1`,
    SMRT_SCHEMA_VERSION,
  );
}

const T = '2026-01-01T00:00:00.000Z';

async function seedReferences(db: DatabaseInterface) {
  await db.query(
    `INSERT INTO _smrt_ai_runs (id, type, tenant_id, status, parent_run_id,
       retry_of_run_id, stopped_by_run_id, started_at, created_at)
     VALUES ('live-run', 'workflow', 't1', 'failed', 'orphan-parent',
       'orphan-retry', 'orphan-stopper', $1, $1)`,
    T,
  );
  await db.query(
    `INSERT INTO _smrt_ai_run_events (id, run_id, seq, type, child_run_id, created_at)
     VALUES ('e1', 'orphan-event-run', 1, 'handoff', 'orphan-child', $1)`,
    T,
  );
  await db.query(
    `INSERT INTO _smrt_ai_run_checkpoints (run_id, state) VALUES ('orphan-cp', '{}')`,
  );
  await db.query(
    `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration, run_id)
     VALUES ('u1', 'openai', 'gpt-4o', 'chat', 1, 'orphan-usage')`,
  );
  await db.query(
    `INSERT INTO _smrt_ai_evaluations (id, run_id, metric, evaluator)
     VALUES ('ev1', 'orphan-eval', 'outcome', 'grader')`,
  );
  await db.query(
    `INSERT INTO _smrt_ai_transcripts (id, call_id, run_id, operation, bytes)
     VALUES ('tr1', 'c1', 'orphan-transcript', 'chat', 0)`,
  );
}

const REFERENCED = [
  'live-run',
  'orphan-parent',
  'orphan-retry',
  'orphan-stopper',
  'orphan-event-run',
  'orphan-child',
  'orphan-cp',
  'orphan-usage',
  'orphan-eval',
  'orphan-transcript',
];

describe.each(engines)('run id registry upgrade on %s', (engine) => {
  it('reserves every referenced id when a 1.19.0 database bootstraps, after the DDL replay', async () => {
    const db = await newDatabase(engine);
    await asSchema119(db, engine);
    await seedReferences(db);
    // More distinct ids than one backfill chunk.
    for (let i = 0; i < 1100; i++) {
      await db.query(
        `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration, run_id)
         VALUES ($1, 'openai', 'gpt-4o', 'chat', 1, $2)`,
        `bulk-u-${i}`,
        `bulk-run-${String(i).padStart(4, '0')}`,
      );
    }
    await ensureSystemTables(db, hint(engine));
    const digests = await registered(db);
    for (const id of REFERENCED) {
      expect(digests.has(await digestOf(id)), id).toBe(true);
    }
    for (const i of [0, 499, 500, 1000, 1099]) {
      const id = `bulk-run-${String(i).padStart(4, '0')}`;
      expect(digests.has(await digestOf(id)), id).toBe(true);
    }
    expect(digests.size).toBe(REFERENCED.length + 1100);
    // Every reserved id is refused.
    for (const id of ['orphan-parent', 'orphan-usage', 'live-run']) {
      await expect(
        openAiRun(
          { db, usageTracking: true, tenantId: 't2' },
          { id, type: 'turn' },
        ),
      ).rejects.toMatchObject({ code: 'AI_RUN_ID_USED' });
    }
  });

  it('reserves the ids of a 1.16.0 database, including labels that became evaluations', async () => {
    const db = await newDatabase(engine);
    for (const ddl of LEGACY_AI_RUN_DDL) {
      await db.query(
        getSystemTableDDLForEngine(
          ddl,
          engine === 'pglite' ? 'postgres' : engine,
        ),
      );
    }
    await seedLegacyAiRunRows(db);
    await ensureSystemTables(db, hint(engine));
    const digests = await registered(db);
    for (const id of ['run-ok', 'run-deg', 'run-bad', 'run-f']) {
      expect(digests.has(await digestOf(id)), id).toBe(true);
    }
  });

  it('runs the backfill again idempotently while unstamped', async () => {
    const db = await newDatabase(engine);
    await asSchema119(db, engine);
    await seedReferences(db);
    await ensureSystemTables(db, hint(engine));
    const first = await registered(db);
    // An interrupted bootstrap leaves no stamp; the next one runs it again.
    await db.query(
      `DELETE FROM _smrt_migrations WHERE version = $1`,
      SMRT_SCHEMA_VERSION,
    );
    await ensureSystemTables(db, hint(engine));
    expect(await registered(db)).toEqual(first);
  });

  it('a second bootstrap returns at the stamp and does not rerun the backfill', async () => {
    const db = await newDatabase(engine);
    await asSchema119(db, engine);
    await seedReferences(db);
    await ensureSystemTables(db, hint(engine));
    expect(
      rowsOf(
        await db.query(
          'SELECT version FROM _smrt_migrations WHERE version = $1',
          SMRT_SCHEMA_VERSION,
        ),
      ),
    ).toHaveLength(1);
    // The backfill arrived in 1.20.0; any later stamp also covers it.
    expect(
      SMRT_SCHEMA_VERSION.localeCompare('1.20.0', undefined, { numeric: true }),
    ).toBeGreaterThanOrEqual(0);
    const statements: string[] = [];
    const restore = recordStatements(db, (sql) => statements.push(sql));
    await ensureSystemTables(db, hint(engine));
    restore();
    expect(
      statements.filter((sql) => sql.includes('_smrt_ai_run_ids')),
    ).toEqual([]);
  });

  it('an open fails closed before any write without the registry table, and creates nothing', async () => {
    const db = await newDatabase(engine);
    await ensureSystemTables(db, hint(engine));
    await db.query('DROP TABLE IF EXISTS _smrt_ai_run_ids');
    const statements: string[] = [];
    const restore = recordStatements(db, (sql) => statements.push(sql));
    await expect(
      openAiRun(
        { db, usageTracking: true },
        { id: 'no-registry', type: 'turn' },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    restore();
    expect(
      statements.filter((sql) =>
        /^(INSERT|UPDATE|DELETE|CREATE|ALTER)\b/.test(sql),
      ),
    ).toEqual([]);
    expect(
      rowsOf(
        await db.query("SELECT id FROM _smrt_ai_runs WHERE id = 'no-registry'"),
      ),
    ).toEqual([]);
  });

  it('doctor counts referenced ids with neither row and children older than their parent', async () => {
    const db = await newDatabase(engine);
    await ensureSystemTables(db, hint(engine));
    expect(await checkAiRunIdRegistry(db)).toEqual({
      unregisteredIds: 0,
      childrenOlderThanParent: 0,
    });
    // An older core wrote a usage row for a run it never registered, and a
    // run whose parent id was reused (the parent row is newer than its child).
    await db.query(
      `INSERT INTO _smrt_ai_usage (id, provider, model, operation, duration, run_id)
       VALUES ('u-old', 'openai', 'gpt-4o', 'chat', 1, 'never-registered')`,
    );
    await db.query(
      `INSERT INTO _smrt_ai_runs (id, type, tenant_id, status, started_at, created_at)
       VALUES ('reused-parent', 'turn', 't1', 'running', $1, $1)`,
      '2026-03-01T00:00:00.000Z',
    );
    await db.query(
      `INSERT INTO _smrt_ai_runs (id, type, tenant_id, status, parent_run_id, started_at, created_at)
       VALUES ('old-child', 'turn', 't1', 'running', 'reused-parent', $1, $1)`,
      '2026-01-01T00:00:00.000Z',
    );
    expect(await checkAiRunIdRegistry(db)).toEqual({
      unregisteredIds: 1,
      childrenOlderThanParent: 1,
    });
  });
});
