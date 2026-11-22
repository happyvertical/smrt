/**
 * Real databases for the dispatch bus tests. SQLite (file) and DuckDB always;
 * PGlite when the lane sets `SMRT_TEST_PGLITE=1` (`pnpm test:pglite`);
 * PostgreSQL only from `*-postgres.optional.test.ts` files through
 * {@link openPostgresDispatchDatabase}. Never mocks the database.
 */

import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { createDispatchBus, type DispatchBus } from '../../dispatch/bus';
import {
  dispatchPatternDialect,
  dispatchPatternSql,
  matchesDispatchPattern,
} from '../../dispatch/pattern';
import type { DispatchBusOptions } from '../../dispatch/types';
import { getSystemTableDDLForEngine } from '../../system/schema';
import { getTestDatabase } from '../../testing/database';

export type DispatchTestEngine = 'sqlite' | 'duckdb' | 'pglite' | 'postgres';

/** Engines every dispatch suite runs on in the default and PGlite lanes. */
export const dispatchTestEngines: DispatchTestEngine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

export interface DispatchTestDatabase {
  engine: DispatchTestEngine;
  db: DatabaseInterface;
  bus: DispatchBus;
  close(): Promise<void>;
}

export interface DispatchTestOpenOptions {
  /** Runs on the empty database before the bus initializes it. */
  preload?: (db: DatabaseInterface) => Promise<void>;
  /** Bus options other than the database. */
  bus?: Omit<DispatchBusOptions, 'db' | 'persistence'>;
}

/** Run each `;`-separated statement of `ddl`. */
export async function runStatements(
  db: DatabaseInterface,
  ddl: string,
): Promise<void> {
  for (const statement of ddl.split(';')) {
    if (statement.trim()) await db.query(statement);
  }
}

export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Open an empty database of `engine` with the dispatch tables. */
export async function openDispatchTestDatabase(
  engine: Exclude<DispatchTestEngine, 'postgres'>,
  options: DispatchTestOpenOptions = {},
): Promise<DispatchTestDatabase> {
  let db: DatabaseInterface;
  let file: string | undefined;
  if (engine === 'pglite') {
    db = await getTestDatabase({
      type: 'pglite',
      classes: [],
      includeSystemTables: false,
    });
  } else if (engine === 'sqlite') {
    file = join(tmpdir(), `smrt-dispatch-${randomUUID().slice(0, 8)}.db`);
    db = (await getDatabase({
      type: 'sqlite',
      url: file,
    })) as DatabaseInterface;
  } else {
    db = (await getDatabase({
      type: 'duckdb',
      url: ':memory:',
    })) as DatabaseInterface;
  }
  await options.preload?.(db);
  const bus = await createDispatchBus({ ...options.bus, db });
  return {
    engine,
    db,
    bus,
    async close() {
      await db.close?.();
      if (file) rmSync(file, { force: true });
    },
  };
}

/** PostgreSQL URL of the optional lane, if any. */
export const postgresDispatchUrl = process.env.SMRT_TEST_POSTGRES_URL;

/**
 * Open a PostgreSQL database in a fresh schema of its own (optional lane).
 * `close()` drops the schema. `options.timeZone` sets the session
 * `TimeZone` of every pooled connection (through the connection `options`).
 */
export async function openPostgresDispatchDatabase(
  label: string,
  options: DispatchTestOpenOptions & { timeZone?: string } = {},
): Promise<DispatchTestDatabase> {
  const url = postgresDispatchUrl;
  if (!url) throw new Error('SMRT_TEST_POSTGRES_URL is not set');
  const schema = `dispatch_${label}_${randomUUID().slice(0, 8)}`.replace(
    /[^a-z0-9_]/g,
    '_',
  );
  const admin = (await getDatabase({
    type: 'postgres',
    url,
    dbid: `smrt-test-dispatch-admin-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const separator = url.includes('?') ? '&' : '?';
  const connectionOptions = [
    `-c search_path=${schema}`,
    ...(options.timeZone ? [`-c TimeZone=${options.timeZone}`] : []),
  ].join(' ');
  const db = (await getDatabase({
    type: 'postgres',
    url: `${url}${separator}options=${encodeURIComponent(connectionOptions)}`,
    dbid: `smrt-test-dispatch-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  await options.preload?.(db);
  const bus = await createDispatchBus({ ...options.bus, db });
  return {
    engine: 'postgres',
    db,
    bus,
    async close() {
      await db.close?.();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.close?.();
    },
  };
}

/** Insert a raw `_smrt_dispatch` row (legacy or malformed shapes included). */
export async function insertRawDispatch(
  db: DatabaseInterface,
  row: {
    id: string;
    type: string;
    status?: string;
    attempts?: number | null;
    targetSubscriber?: string | null;
    tenantId?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
    lastError?: string | null;
    leaseToken?: string | null;
    claimedUntil?: string | null;
    maxAttempts?: number | null;
  },
): Promise<void> {
  if (
    row.leaseToken !== undefined ||
    row.claimedUntil !== undefined ||
    row.maxAttempts !== undefined
  ) {
    await insertRawDispatch(db, {
      ...row,
      leaseToken: undefined,
      claimedUntil: undefined,
      maxAttempts: undefined,
    });
    await db.query(
      `UPDATE _smrt_dispatch
          SET lease_token = $1, claimed_until = $2, max_attempts = $3
        WHERE id = $4`,
      row.leaseToken ?? null,
      row.claimedUntil ?? null,
      row.maxAttempts ?? null,
      row.id,
    );
    return;
  }
  await db.query(
    `INSERT INTO _smrt_dispatch
       (id, type, source, payload, status, attempts, last_error,
        target_subscriber, tenant_id, metadata, created_at, updated_at)
     VALUES ($1, $2, 'test', '{}', $3, $4, $5, $6, $7, '{}', $8, $9)`,
    row.id,
    row.type,
    row.status ?? 'pending',
    row.attempts === undefined ? 0 : row.attempts,
    row.lastError ?? null,
    row.targetSubscriber ?? null,
    row.tenantId ?? null,
    row.createdAt === undefined ? new Date().toISOString() : row.createdAt,
    row.updatedAt === undefined ? new Date().toISOString() : row.updatedAt,
  );
}

/** Patterns of the compiler parity table (T22/T24). */
export const PATTERN_PROBE_PATTERNS = [
  'invoice.v*',
  'a*b.c',
  '**',
  '*',
  'campaign.*',
  'Campaign.*',
  'campaign.*.completed',
  '*.done',
  'x.y',
  'weird%_\\.*',
  'g[l]ob?.*',
  'pct.%',
  'under_score.*',
];

/** Signal types of the compiler parity table (T22/T24). */
export const PATTERN_PROBE_TYPES = [
  'invoice.v2',
  'invoice.v',
  'invoice.v2.x',
  'invoice.x2',
  'axb.c',
  'ab.c',
  'axxb.c',
  'ax.yb.c',
  'a',
  'ab',
  'campaign.started',
  'Campaign.X',
  'campaign.X',
  'CAMPAIGN.started',
  'campaign.summer.completed',
  'campaign.a.b.completed',
  'job.done',
  '.done',
  'x.y',
  'X.Y',
  'xzy',
  'weird%_\\.z',
  'weirdAB\\.z',
  'weird%_x.z',
  'g[l]ob?.q',
  'glob?.q',
  'gloob.q',
  'pct.%',
  'pct.x',
  'under_score.a',
  'underXscore.a',
  'a.b',
  'multi\nline',
];

/**
 * Run every probe pattern's compiled SQL over a table of the probe types and
 * return each pattern whose selected set differs from `matches()`.
 */
export async function patternSqlMismatches(
  db: DatabaseInterface,
  engine: DispatchTestEngine,
): Promise<{ pattern: string; selected: string[]; expected: string[] }[]> {
  const table = `pattern_probe_${randomUUID().slice(0, 8)}`;
  await db.query(`CREATE TABLE ${table} (v TEXT)`);
  for (const type of PATTERN_PROBE_TYPES) {
    await db.query(`INSERT INTO ${table} (v) VALUES ($1)`, type);
  }
  const dialect = dispatchPatternDialect(
    engine === 'sqlite' ? 'sqlite' : 'postgres',
  );
  const mismatches: {
    pattern: string;
    selected: string[];
    expected: string[];
  }[] = [];
  for (const pattern of PATTERN_PROBE_PATTERNS) {
    const params: unknown[] = [];
    const where = dispatchPatternSql(pattern, dialect, 'v', (value) => {
      params.push(value);
      return `$${params.length}`;
    });
    const selected = rowsOf(
      await db.query(`SELECT v FROM ${table} WHERE ${where}`, ...params),
    )
      .map((row) => row.v as string)
      .sort();
    const expected = PATTERN_PROBE_TYPES.filter((type) =>
      matchesDispatchPattern(pattern, type),
    ).sort();
    if (JSON.stringify(selected) !== JSON.stringify(expected)) {
      mismatches.push({ pattern, selected, expected });
    }
  }
  return mismatches;
}

/** The `_smrt_dispatch` DDL as shipped in system schema 1.20.0 (pre-lease). */
export const DISPATCH_TABLE_DDL_1_20_0 = `
CREATE TABLE _smrt_dispatch (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  processed_at TIMESTAMP,
  processed_by TEXT,
  target_subscriber TEXT,
  correlation_id TEXT,
  tenant_id TEXT,
  metadata TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smrt_dispatch_status ON _smrt_dispatch(status);
CREATE INDEX idx_smrt_dispatch_status_updated ON _smrt_dispatch(status, updated_at)`;

/** {@link DISPATCH_TABLE_DDL_1_20_0} rendered for `engine` as bootstrap would. */
export function legacyDispatchDdl(engine: DispatchTestEngine): string {
  return getSystemTableDDLForEngine(
    DISPATCH_TABLE_DDL_1_20_0,
    engine === 'sqlite'
      ? 'sqlite'
      : engine === 'duckdb'
        ? 'duckdb'
        : 'postgres',
  );
}

/** Lease columns and indexes the dispatch lease adds to `_smrt_dispatch`. */
export const DISPATCH_LEASE_COLUMNS = [
  'lease_token',
  'claimed_until',
  'max_attempts',
] as const;
export const DISPATCH_LEASE_INDEXES = {
  idx_smrt_dispatch_status_created_id: ['status', 'created_at', 'id'],
  idx_smrt_dispatch_status_claimed_id: ['status', 'claimed_until', 'id'],
  idx_smrt_dispatch_status_updated_id: ['status', 'updated_at', 'id'],
} as const;

/**
 * Column types of `_smrt_dispatch` (lower-cased) and the ordered columns of
 * every index on it, read from the engine catalog.
 */
export async function readDispatchTableShape(
  db: DatabaseInterface,
  engine: DispatchTestEngine,
): Promise<{
  columns: Record<string, string>;
  indexes: Record<string, string[]>;
}> {
  const columns: Record<string, string> = {};
  const indexes: Record<string, string[]> = {};
  if (engine === 'sqlite') {
    for (const row of rowsOf(
      await db.query('PRAGMA table_info(_smrt_dispatch)'),
    )) {
      columns[String(row.name)] = String(row.type).toLowerCase();
    }
    for (const index of rowsOf(
      await db.query('PRAGMA index_list(_smrt_dispatch)'),
    )) {
      const name = String(index.name);
      if (name.startsWith('sqlite_autoindex_')) continue;
      indexes[name] = rowsOf(await db.query(`PRAGMA index_info(${name})`)).map(
        (info) => String(info.name),
      );
    }
    return { columns, indexes };
  }
  if (engine === 'duckdb') {
    for (const row of rowsOf(
      await db.query(
        "SELECT column_name, data_type FROM duckdb_columns() WHERE table_name = '_smrt_dispatch'",
      ),
    )) {
      columns[String(row.column_name)] = String(row.data_type).toLowerCase();
    }
    for (const row of rowsOf(
      await db.query(
        "SELECT index_name, expressions FROM duckdb_indexes() WHERE table_name = '_smrt_dispatch'",
      ),
    )) {
      indexes[String(row.index_name)] = parseIndexColumnList(row.expressions);
    }
    return { columns, indexes };
  }
  for (const row of rowsOf(
    await db.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = '_smrt_dispatch'",
    ),
  )) {
    columns[String(row.column_name)] = String(row.data_type).toLowerCase();
  }
  for (const row of rowsOf(
    await db.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = '_smrt_dispatch'",
    ),
  )) {
    const def = String(row.indexdef);
    const list = def.slice(def.lastIndexOf('(') + 1, def.lastIndexOf(')'));
    indexes[String(row.indexname)] = parseIndexColumnList(list);
  }
  return { columns, indexes };
}

/**
 * The lease part of a `_smrt_dispatch` shape: the lease column types and the
 * ordered columns of the lease indexes and of the retention index they sit
 * beside. Two databases agree on the lease schema iff these are equal.
 */
export function leaseShapeOf(shape: {
  columns: Record<string, string>;
  indexes: Record<string, string[]>;
}): Record<string, unknown> {
  return {
    columns: Object.fromEntries(
      DISPATCH_LEASE_COLUMNS.map((name) => [name, shape.columns[name] ?? null]),
    ),
    indexes: Object.fromEntries(
      [
        ...Object.keys(DISPATCH_LEASE_INDEXES),
        'idx_smrt_dispatch_status_updated',
      ].map((name) => [name, shape.indexes[name] ?? null]),
    ),
  };
}

function parseIndexColumnList(value: unknown): string[] {
  const text = Array.isArray(value) ? value.join(',') : String(value ?? '');
  return text
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((part) => part.trim().replace(/^'|'$/g, '').replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Lease-relevant columns of one dispatch row, read directly. */
export async function dispatchLeaseRow(
  db: DatabaseInterface,
  id: string,
): Promise<{
  status: string;
  attempts: number | null;
  leaseToken: string | null;
  claimedUntil: string | null;
  maxAttempts: number | null;
  lastError: string | null;
}> {
  const row = rowsOf(
    await db.query(
      `SELECT status, attempts, lease_token, CAST(claimed_until AS TEXT) AS claimed_until,
              max_attempts, last_error
         FROM _smrt_dispatch WHERE id = $1`,
      id,
    ),
  )[0];
  if (!row) throw new Error(`no dispatch ${id}`);
  const int = (value: unknown) => (value == null ? null : Number(value));
  return {
    status: String(row.status),
    attempts: int(row.attempts),
    leaseToken: (row.lease_token as string | null) ?? null,
    claimedUntil: (row.claimed_until as string | null) ?? null,
    maxAttempts: int(row.max_attempts),
    lastError: (row.last_error as string | null) ?? null,
  };
}

/** Status of one dispatch row, read directly. */
export async function dispatchStatus(
  db: DatabaseInterface,
  id: string,
): Promise<string | undefined> {
  const rows = rowsOf(
    await db.query('SELECT status FROM _smrt_dispatch WHERE id = $1', id),
  );
  return rows[0]?.status as string | undefined;
}
