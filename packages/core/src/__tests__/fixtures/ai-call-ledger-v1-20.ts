/**
 * The 1.20.0 shape of `_smrt_ai_run_events` and `_smrt_ai_usage`, and the
 * statements a 1.20.0 core runs against them, copied as written from
 * origin/main `b23f1fd466` (#5516 cutover tests, test contract T14 actor
 * A6). A 1.20.0 database is made by replacing those two tables on a fresh
 * database and stamping 1.20.0; "an older core" is these statements.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getSystemTableDDLForEngine } from '../../system/schema';
import { rowsOf } from './ai-run-test-db';

export const V1_20_USAGE_DDL = `
CREATE TABLE IF NOT EXISTS _smrt_ai_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost REAL,
  duration INTEGER NOT NULL,
  class_name TEXT,
  tenant_id TEXT,
  tags TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  prompt_key TEXT,
  tier_requested TEXT,
  tier_resolved TEXT,
  run_id TEXT,
  call_id TEXT,
  entry_call_id TEXT,
  template_hash TEXT,
  step_index INTEGER,
  step_name TEXT,
  step_instance_id TEXT,
  attempt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_created ON _smrt_ai_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_class ON _smrt_ai_usage(class_name);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_tenant ON _smrt_ai_usage(tenant_id);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_provider_model ON _smrt_ai_usage(provider, model);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_tenant_created ON _smrt_ai_usage(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_prompt_key ON _smrt_ai_usage(prompt_key, created_at);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_run ON _smrt_ai_usage(run_id);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_usage_entry_call ON _smrt_ai_usage(entry_call_id)
`;

export const V1_20_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS _smrt_ai_run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_event_id TEXT,
  type TEXT NOT NULL,
  call_id TEXT,
  step_index INTEGER,
  name TEXT,
  status TEXT,
  duration INTEGER,
  payload TEXT,
  payload_ref TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  child_run_id TEXT,
  reservation TEXT,
  reserved_tokens INTEGER,
  reserved_cost DOUBLE PRECISION,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_call ON _smrt_ai_run_events(call_id);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_child ON _smrt_ai_run_events(child_run_id);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_sweep ON _smrt_ai_run_events(type, reservation, created_at);
CREATE INDEX IF NOT EXISTS idx_smrt_ai_run_events_payload_ref ON _smrt_ai_run_events(payload_ref)
`;

type Engine = 'sqlite' | 'duckdb' | 'pglite' | 'postgres';

function ddlEngine(engine: Engine): 'sqlite' | 'duckdb' | 'postgres' {
  return engine === 'pglite' ? 'postgres' : engine;
}

async function run(db: DatabaseInterface, ddl: string, engine: Engine) {
  for (const statement of getSystemTableDDLForEngine(ddl, ddlEngine(engine))
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.query(statement);
  }
}

/**
 * Turn a freshly bootstrapped database into a 1.20.0 one: both tables
 * recreated in their 1.20.0 shape, the newer stamp removed and 1.20.0's
 * written.
 */
export async function downgradeToV120(
  db: DatabaseInterface,
  engine: Engine,
): Promise<void> {
  await db.query('DROP TABLE IF EXISTS _smrt_ai_run_events');
  await db.query('DROP TABLE IF EXISTS _smrt_ai_usage');
  await run(db, V1_20_EVENTS_DDL, engine);
  await run(db, V1_20_USAGE_DDL, engine);
  await db.query("DELETE FROM _smrt_migrations WHERE version <> '1.20.0'");
  const stamped = rowsOf(
    await db.query(
      "SELECT 1 AS x FROM _smrt_migrations WHERE version = '1.20.0'",
    ),
  );
  if (stamped.length === 0) {
    await db.query(
      "INSERT INTO _smrt_migrations (id, version, description) VALUES ('v120', '1.20.0', 'fixture')",
    );
  }
}

/**
 * 1.20.0's bootstrap as it touches these tables when it finds no stamp of
 * its own version: its column additions (all already present on a newer
 * table, so none adds `duration`) and its DDL replay, then its stamp.
 */
export async function runV120Bootstrap(
  db: DatabaseInterface,
  engine: Engine,
): Promise<void> {
  await run(db, V1_20_EVENTS_DDL, engine);
  await run(db, V1_20_USAGE_DDL, engine);
  await db.query(
    "INSERT INTO _smrt_migrations (id, version, description) VALUES ('v120-again', '1.20.0', 'fixture') ON CONFLICT (version) DO NOTHING",
  );
}

/** A 1.20.0 call reservation, as `reserveAiCalls` inserted it. */
export async function insertV120Reservation(
  db: DatabaseInterface,
  input: {
    runId: string;
    callId: string;
    createdAt: Date;
    reservedTokens?: number;
  },
): Promise<string> {
  const id = `evt-${input.callId}`;
  await db.query(
    `INSERT INTO _smrt_ai_run_events
       (id, run_id, seq, parent_event_id, type, call_id, step_index, name,
        status, duration, payload, payload_ref, truncated, child_run_id,
        reservation, reserved_tokens, reserved_cost, created_at)
     SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17
       FROM _smrt_ai_run_events
      WHERE run_id = $2
     ON CONFLICT (run_id, seq) DO NOTHING
     RETURNING seq`,
    id,
    input.runId,
    null,
    'call',
    input.callId,
    null,
    null,
    'pending',
    null,
    null,
    null,
    0,
    null,
    'reserved',
    input.reservedTokens ?? 10,
    0,
    input.createdAt.toISOString(),
  );
  await db.query(
    `UPDATE _smrt_ai_runs SET reserved_calls = reserved_calls + 1,
            reserved_tokens = reserved_tokens + $2 WHERE id = $1`,
    input.runId,
    input.reservedTokens ?? 10,
  );
  return id;
}

/** Each accounting and usage statement of 1.20.0, runnable against a database. */
export const V1_20_WRITERS: Record<
  string,
  (
    db: DatabaseInterface,
    ids: { runId: string; callId: string },
  ) => Promise<unknown>
> = {
  'event insert': (db, ids) =>
    insertV120Reservation(db, {
      runId: ids.runId,
      callId: `${ids.callId}-new`,
      createdAt: new Date(),
    }),
  moveReservation: (db, ids) =>
    db.query(
      `UPDATE _smrt_ai_run_events
          SET reservation = $3, status = COALESCE($4, status)
        WHERE run_id = $1 AND call_id = $2 AND type = 'call'
          AND reservation IN ($5)
        RETURNING reserved_tokens, reserved_cost`,
      ids.runId,
      ids.callId,
      'settled',
      'ok',
      'reserved',
    ),
  'sweep select': (db) =>
    db.query(
      `SELECT run_id, call_id, created_at FROM _smrt_ai_run_events
        WHERE type = 'call' AND reservation = 'reserved' AND created_at < $1
        ORDER BY created_at, id LIMIT $2 OFFSET $3`,
      new Date().toISOString(),
      500,
      0,
    ),
  'trajectory prune': (db, ids) =>
    db.query(
      `SELECT 1 AS x FROM _smrt_ai_run_events
        WHERE run_id = $1 AND type = 'call' AND reservation = 'reserved'
        LIMIT 1`,
      ids.runId,
    ),
  'usage-row insert': (db, ids) =>
    db.query(
      `INSERT INTO _smrt_ai_usage
        (id, provider, model, operation, prompt_tokens, completion_tokens,
         total_tokens, estimated_cost, duration, class_name, tenant_id, tags, created_at,
         prompt_key, tier_requested, tier_resolved, run_id, call_id,
         entry_call_id, template_hash, step_index, step_name, step_instance_id,
         attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               $16, $17, $18, $19, $20, $21, $22, $23, $24)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      `${ids.callId}-row`,
      'openai',
      'gpt-4o',
      'message',
      1,
      1,
      2,
      null,
      5,
      null,
      null,
      null,
      new Date().toISOString(),
      null,
      null,
      null,
      ids.runId,
      `${ids.callId}-row`,
      `${ids.callId}-row`,
      null,
      null,
      null,
      null,
      null,
    ),
  'external-agent insert': (db, ids) =>
    db.query(
      `INSERT INTO _smrt_ai_usage (id,call_id,entry_call_id,provider,model,operation,prompt_tokens,completion_tokens,total_tokens,estimated_cost,duration,class_name,tenant_id,tags,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING RETURNING id`,
      `external-agent:${ids.callId}`,
      `external-agent:${ids.callId}`,
      `external-agent:${ids.callId}`,
      'claude-code',
      'unknown',
      'external-agent',
      1,
      1,
      2,
      null,
      0,
      'stream',
      null,
      '{}',
      new Date().toISOString(),
    ),
};

/** The column names of a table, sorted. */
export async function columnsOf(
  db: DatabaseInterface,
  table: string,
  engine: Engine,
): Promise<Array<{ name: string; type: string; notnull: boolean }>> {
  if (engine === 'sqlite' || engine === 'duckdb') {
    return rowsOf(await db.query(`PRAGMA table_info(${table})`))
      .map((row) => ({
        name: String(row.name),
        type: String(row.type).toUpperCase(),
        notnull: Number(row.notnull) === 1 || row.notnull === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return rowsOf(
    await db.query(
      `SELECT column_name AS name, data_type AS type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`,
      table,
    ),
  )
    .map((row) => ({
      name: String(row.name),
      type: String(row.type).toUpperCase(),
      notnull: String(row.is_nullable) === 'NO',
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The index names on a table, sorted. */
export async function indexesOf(
  db: DatabaseInterface,
  table: string,
  engine: Engine,
): Promise<string[]> {
  const rows =
    engine === 'sqlite'
      ? rowsOf(
          await db.query(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = $1 AND name NOT LIKE 'sqlite_autoindex%'",
            table,
          ),
        )
      : engine === 'duckdb'
        ? rowsOf(
            await db.query(
              'SELECT index_name AS name FROM duckdb_indexes() WHERE table_name = $1',
              table,
            ),
          )
        : rowsOf(
            await db.query(
              `SELECT indexname AS name FROM pg_indexes
                WHERE schemaname = current_schema() AND tablename = $1
                  AND indexname NOT LIKE '%_pkey' AND indexname NOT LIKE '%_key'`,
              table,
            ),
          );
  return rows.map((row) => String(row.name)).sort();
}
