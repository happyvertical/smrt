/** Explicit, atomic maintenance upgrade of framework-owned nullable conflict indexes. */
import type { DatabaseInterface } from '@happyvertical/sql';
import { parsePostgresTimeoutMs } from '../postgres-timeouts.js';
import { nullableConflictIdentity } from '../schema/conflict-target.js';
import { detectEngine } from '../schema/ddl/index.js';
import { quoteIdentifier } from '../schema/sql-identifiers.js';
import type { SchemaDefinition } from '../schema/types.js';
import { toSafeInteger } from '../utils/safe-integer.js';

export interface NullEqualIndexTarget {
  table: string;
  index: string;
  columns: string[];
}
export interface NullEqualIndexOptions {
  engineHint?: string;
  lockTimeout?: string | number;
  statementTimeout?: string | number;
}
export interface NullEqualIndexReport extends NullEqualIndexTarget {
  state: 'pending' | 'current' | 'blocked';
  reason?: string;
  duplicateGroups: number;
  detectorSql: string;
}
export interface NullEqualIndexPreflight {
  supported: boolean;
  engine: string;
  serverVersion: number | null;
  indexes: NullEqualIndexReport[];
  summary: string;
}

/** Metadata is the authority; optional business UNIQUE indexes are never inferred. */
export function collectNullEqualIndexTargets(
  schemas: Record<string, SchemaDefinition>,
): NullEqualIndexTarget[] {
  const targets = new Map<string, NullEqualIndexTarget>();
  for (const schema of Object.values(schemas)) {
    for (const index of schema.indexes ?? []) {
      if (!index.nullsNotDistinct) continue;
      if (
        !index.unique ||
        index.where ||
        index.jsonPath ||
        !index.columns.length ||
        !index.columns.every((column) => schema.columns[column]) ||
        !nullableConflictIdentity(index.columns, schema.columns)
      ) {
        throw new Error(
          `Invalid framework NULL-equal identity ${schema.tableName}.${index.name}; regenerate manifests.`,
        );
      }
      const target = {
        table: schema.tableName,
        index: index.name,
        columns: [...index.columns],
      };
      const key = `${target.table}\0${target.index}`;
      const previous = targets.get(key);
      if (
        previous &&
        JSON.stringify(previous.columns) !== JSON.stringify(target.columns)
      ) {
        throw new Error(
          `Conflicting framework identity definitions for ${target.table}.${target.index}.`,
        );
      }
      targets.set(key, target);
    }
  }
  return [...targets.values()].sort(
    (a, b) => a.table.localeCompare(b.table) || a.index.localeCompare(b.index),
  );
}

const qualified = (name: string) =>
  `${quoteIdentifier('public')}.${quoteIdentifier(name)}`;

export function nullEqualDuplicateDetector(
  target: NullEqualIndexTarget,
): string {
  const columns = target.columns.map(quoteIdentifier).join(', ');
  return `SELECT ${columns}, COUNT(*) AS duplicate_count FROM ${qualified(target.table)} GROUP BY ${columns} HAVING COUNT(*) > 1`;
}

export function nullEqualIndexStatements(
  target: NullEqualIndexTarget,
): string[] {
  return [
    `DROP INDEX ${qualified(target.index)}`,
    `CREATE UNIQUE INDEX ${quoteIdentifier(target.index)} ON ${qualified(target.table)} (${target.columns.map(quoteIdentifier).join(', ')}) NULLS NOT DISTINCT`,
  ];
}

/** Read-only; even PostgreSQL 14 never parses the PostgreSQL 15 catalog field. */
export async function preflightNullEqualIndexes(
  db: DatabaseInterface,
  targets: NullEqualIndexTarget[],
  options: NullEqualIndexOptions = {},
): Promise<NullEqualIndexPreflight> {
  const engine = detectEngine(db.url ?? '', options.engineHint);
  let serverVersion: number | null = null;
  if (engine === 'postgres') {
    const result = await db.query('SHOW server_version_num');
    serverVersion = toSafeInteger(
      result.rows[0]?.server_version_num,
      'PostgreSQL server version',
    );
  }
  if (
    engine !== 'postgres' ||
    serverVersion === null ||
    serverVersion < 150000
  ) {
    return {
      supported: false,
      engine,
      serverVersion,
      indexes: [],
      summary:
        'NULL-equal conflict-index migration requires PostgreSQL 15+. Existing adapter fallback remains unchanged; no migration is applied.',
    };
  }
  const indexes: NullEqualIndexReport[] = [];
  for (const target of targets) {
    const detectorSql = nullEqualDuplicateDetector(target);
    const report: NullEqualIndexReport = {
      ...target,
      state: 'blocked',
      duplicateGroups: 0,
      detectorSql,
    };
    // Exact named standalone index, ordered keys, default btree semantics only.
    // Refuse constraint ownership and all reverse dependencies; never CASCADE.
    const result = await db.query(
      `
      SELECT i.indisunique, i.indisvalid, i.indisready, i.indnullsnotdistinct,
        i.indpred IS NULL AS full_index, i.indexprs IS NULL AS plain_columns,
        i.indnkeyatts = i.indnatts AS no_includes, am.amname,
        ARRAY(SELECT a.attname FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ord)::text[] AS columns,
        EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid = x.oid) AS constraint_owned,
        EXISTS(SELECT 1 FROM pg_depend d WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = x.oid) AS depended_on,
        EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = x.oid AND d.deptype IN ('e', 'i')) AS managed_dependency,
        NOT EXISTS(SELECT 1 FROM unnest(i.indoption) AS opt WHERE opt <> 0) AS default_order,
        NOT EXISTS(SELECT 1 FROM unnest(i.indclass) AS op JOIN pg_opclass c ON c.oid = op WHERE NOT c.opcdefault) AS default_ops,
        NOT EXISTS(SELECT 1 FROM unnest(i.indkey, i.indcollation) AS k(attnum, coll)
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum WHERE k.coll <> a.attcollation) AS default_collation,
        x.reloptions IS NULL AND x.reltablespace = 0 AS default_storage,
        t.relkind
      FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_index i ON i.indrelid = t.oid JOIN pg_class x ON x.oid = i.indexrelid
      JOIN pg_am am ON am.oid = x.relam
      WHERE n.nspname = 'public' AND t.relname = $1 AND x.relname = $2`,
      [target.table, target.index],
    );
    const row = result.rows[0];
    if (!row) {
      report.reason =
        'Expected framework index is missing. Ordinary db:migrate may treat a differently named equivalent index as already satisfied. Inspect pg_indexes and verify framework ownership, exact ordered keys, uniqueness and dependencies. In a separate maintenance transaction, rename a verified owned equivalent with ALTER INDEX ... RENAME TO the expected name, or create the expected framework index from the generated schema; then repeat preflight. Never rename an arbitrary business index.';
    } else if (
      !row.indisunique ||
      !row.indisvalid ||
      !row.indisready ||
      !row.full_index ||
      !row.plain_columns ||
      !row.no_includes ||
      !row.default_order ||
      !row.default_ops ||
      !row.default_collation ||
      !row.default_storage ||
      row.amname !== 'btree' ||
      row.relkind !== 'r' ||
      JSON.stringify(row.columns) !== JSON.stringify(target.columns)
    ) {
      report.reason =
        'Live index shape differs from the framework identity (or table is partitioned). Resolve schema drift before this migration.';
    } else if (
      row.constraint_owned ||
      row.depended_on ||
      row.managed_dependency
    ) {
      report.reason =
        'Index has constraint ownership or unmanaged dependencies. Arrange a separate dependency-aware migration; this command never drops constraints or uses CASCADE.';
    } else {
      const duplicates = await db.query(
        `SELECT COUNT(*) AS groups FROM (${detectorSql}) AS duplicate_groups`,
      );
      report.duplicateGroups = toSafeInteger(
        duplicates.rows[0]?.groups ?? 0,
        'NULL-equal duplicate groups',
      );
      if (report.duplicateGroups) {
        report.reason = `${report.duplicateGroups} duplicate NULL-equal identity group(s). Inspect detectorSql and resolve identities explicitly; no rows are changed.`;
      } else {
        report.state = row.indnullsnotdistinct ? 'current' : 'pending';
      }
    }
    indexes.push(report);
  }
  return {
    supported: true,
    engine,
    serverVersion,
    indexes,
    summary: `NULL-equal conflict indexes: ${indexes.filter((r) => r.state === 'pending').length} pending, ${indexes.filter((r) => r.state === 'current').length} current, ${indexes.filter((r) => r.state === 'blocked').length} blocked.`,
  };
}

function assertReady(preflight: NullEqualIndexPreflight): void {
  const blocked = preflight.indexes.filter(
    (index) => index.state === 'blocked',
  );
  if (blocked.length)
    throw new Error(
      blocked
        .map(
          (index) =>
            `${index.table}.${index.index}: ${index.reason}\nDetector: ${index.detectorSql}`,
        )
        .join('\n'),
    );
}

/** Locks all targets before rechecking; any failure restores every original index. */
export async function migrateNullEqualIndexes(
  db: DatabaseInterface,
  targets: NullEqualIndexTarget[],
  options: NullEqualIndexOptions = {},
): Promise<{ preflight: NullEqualIndexPreflight; statements: string[] }> {
  const preflight = await preflightNullEqualIndexes(db, targets, options);
  if (!preflight.supported) return { preflight, statements: [] };
  assertReady(preflight);
  if (!preflight.indexes.some((index) => index.state === 'pending'))
    return { preflight, statements: [] };
  if (!db.transaction)
    throw new Error(
      'NULL-equal conflict-index migration requires an owning transaction.',
    );
  const lockTimeout = parsePostgresTimeoutMs(options.lockTimeout, 30_000);
  const statementTimeout = parsePostgresTimeoutMs(
    options.statementTimeout,
    60_000,
  );
  const statements: string[] = [];
  await db.transaction(async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${lockTimeout}ms'`);
    await tx.query(`SET LOCAL statement_timeout = '${statementTimeout}ms'`);
    for (const table of [
      ...new Set(targets.map((target) => target.table)),
    ].sort()) {
      await tx.query(`LOCK TABLE ${qualified(table)} IN ACCESS EXCLUSIVE MODE`);
    }
    const locked = await preflightNullEqualIndexes(
      tx as DatabaseInterface,
      targets,
      { ...options, engineHint: 'postgres' },
    );
    assertReady(locked);
    for (const target of locked.indexes.filter(
      (index) => index.state === 'pending',
    )) {
      for (const statement of nullEqualIndexStatements(target)) {
        await tx.query(statement);
        statements.push(statement);
      }
    }
  });
  return { preflight, statements };
}
