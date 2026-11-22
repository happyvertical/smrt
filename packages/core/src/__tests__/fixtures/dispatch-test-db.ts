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

export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Open an empty database of `engine` with the dispatch tables. */
export async function openDispatchTestDatabase(
  engine: Exclude<DispatchTestEngine, 'postgres'>,
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
  const bus = await createDispatchBus({ db });
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
 * `close()` drops the schema. `timeZone` sets the session `TimeZone` of
 * every pooled connection (through the connection `options`).
 */
export async function openPostgresDispatchDatabase(
  label: string,
  session: { timeZone?: string } = {},
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
  const options = [
    `-c search_path=${schema}`,
    ...(session.timeZone ? [`-c TimeZone=${session.timeZone}`] : []),
  ].join(' ');
  const db = (await getDatabase({
    type: 'postgres',
    url: `${url}${separator}options=${encodeURIComponent(options)}`,
    dbid: `smrt-test-dispatch-${randomUUID()}`,
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  const bus = await createDispatchBus({ db });
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
  },
): Promise<void> {
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
