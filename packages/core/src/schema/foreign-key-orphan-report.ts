/**
 * Per-foreign-key orphan count report (#2753)
 *
 * `foreign-key-ddl.ts` already builds the orphan probe SQL and the suggested
 * repair the migration differ uses to gate `ADD CONSTRAINT` — deliberately
 * refusing to repair anything, since only the relationship's owner knows
 * whether an orphan should be reassigned, nulled, or deleted. What is
 * missing is the counting: `renderForeignKeyOrphanDetector({ limitOne: true })`
 * makes the probe a gate, not a report.
 *
 * This module runs the same probe as a `COUNT(*)` aggregate (via
 * `renderForeignKeyOrphanDetector({ countOnly: true })`, so the exact
 * FROM/JOIN/WHERE predicate is never duplicated) for every manifest-declared
 * foreign key, and reports child/parent table and column, the orphan count,
 * and whether the child column is nullable — so the two dispositions the
 * repair-SQL builder already distinguishes (manual repair vs. null-out) are
 * visible up front.
 *
 * Strictly read-only and diagnostic: it never repairs, and a relationship
 * whose child or parent table does not exist live is skipped and reported
 * separately rather than failing the whole report.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { detectEngine } from './ddl/index.js';
import type { DatabaseEngine } from './ddl/types.js';
import {
  type ForeignKeyUuidCastSide,
  renderForeignKeyOrphanDetector,
  schemaForeignKeysForEngine,
} from './foreign-key-ddl.js';
import type { SchemaDefinition } from './types.js';

/** One manifest foreign key's live orphan count. */
export interface ForeignKeyOrphanCount {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  /** Number of live child rows whose reference does not resolve. */
  orphanCount: number;
  /** Whether the child column allows NULL (a null-out repair is possible). */
  nullable: boolean;
}

/** A manifest foreign key the report could not probe, and why. */
export interface ForeignKeyOrphanSkipped {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  reason: string;
  /**
   * `missing_table` is benign and expected (a manifest table not yet
   * migrated, or filtered out of this database). `probe_failed` means the
   * `COUNT(*)` query itself errored — a real signal (permissions, a
   * malformed live column, a genuine SQL failure) that a caller should
   * surface distinctly rather than silently treat as "no orphans found".
   */
  kind: 'missing_table' | 'probe_failed';
}

/** Aggregate result of one orphan-count run. */
export interface ForeignKeyOrphanCountReport {
  engine: DatabaseEngine;
  /**
   * Every probed foreign key with a live orphan count, sorted by
   * `orphanCount` descending so the largest problems surface first.
   * Includes relationships with zero orphans.
   */
  counts: ForeignKeyOrphanCount[];
  /** Foreign keys skipped because a table did not exist live, or the probe failed. */
  skipped: ForeignKeyOrphanSkipped[];
}

export interface CollectForeignKeyOrphanCountsOptions {
  /** Explicit engine hint for adapters whose URL is empty or ambiguous. */
  engineHint?: string;
}

/**
 * Probe every manifest-declared foreign key for live orphan rows and report
 * a count per relationship. Read-only: never repairs, never fails the whole
 * report for one bad relationship.
 *
 * @param db Live database connection.
 * @param schemas Manifest schemas, keyed by table name — typically
 *   `ObjectRegistry.getAllSchemasAsDefinitions()`.
 */
export async function collectForeignKeyOrphanCounts(
  db: DatabaseInterface,
  schemas: Record<string, SchemaDefinition>,
  options: CollectForeignKeyOrphanCountsOptions = {},
): Promise<ForeignKeyOrphanCountReport> {
  const engine = resolveEngine(db, options.engineHint);
  const liveTables = await listLiveTables(db, engine);

  const counts: ForeignKeyOrphanCount[] = [];
  const skipped: ForeignKeyOrphanSkipped[] = [];

  for (const [childTable, schema] of Object.entries(schemas)) {
    const foreignKeys = schemaForeignKeysForEngine(schema, engine);

    for (const foreignKey of foreignKeys) {
      const parentTable = foreignKey.referencesTable;
      const base = {
        childTable,
        childColumn: foreignKey.column,
        parentTable,
        parentColumn: foreignKey.referencesColumn,
      };

      if (!liveTables.has(childTable)) {
        skipped.push({
          ...base,
          kind: 'missing_table',
          reason: `Child table \`${childTable}\` does not exist in the live database.`,
        });
        continue;
      }
      if (!liveTables.has(parentTable)) {
        skipped.push({
          ...base,
          kind: 'missing_table',
          reason: `Parent table \`${parentTable}\` does not exist in the live database.`,
        });
        continue;
      }

      const childColumnDefinition = schema.columns[foreignKey.column];
      const nullable = childColumnDefinition?.notNull !== true;
      const parentColumnDefinition =
        schemas[parentTable]?.columns[foreignKey.referencesColumn];
      const declaredUuidComparison =
        childColumnDefinition?.type === 'UUID' &&
        (parentColumnDefinition === undefined ||
          parentColumnDefinition.type === 'UUID');

      // The manifest declaring UUID on both sides is not proof the live
      // columns are actually native uuid yet — #2608 tolerates a legacy
      // component that is still `text` on every side until it converges. Mirror
      // the migration gate's live-type cast-side selection
      // (`SchemaComparer.getForeignKeyOrphanOptions` in migrations/differ.ts)
      // instead of guessing from the manifest alone, or a legacy text/text or
      // text/uuid relationship either errors (`operator does not exist: text
      // = uuid`) or silently mismatches instead of being counted.
      const { uuidComparison, uuidCastSide } = await resolveUuidCastSide(db, {
        engine,
        declaredUuidComparison,
        childTable,
        childColumn: foreignKey.column,
        parentTable,
        parentColumn: foreignKey.referencesColumn,
      });

      const sql = renderForeignKeyOrphanDetector(childTable, foreignKey, {
        engine,
        countOnly: true,
        uuidComparison,
        uuidCastSide,
      });

      try {
        const result = await db.query(sql);
        const rows = (
          Array.isArray(result)
            ? result
            : ((result as { rows?: unknown[] })?.rows ?? [])
        ) as Record<string, unknown>[];
        const raw = rows[0]?.orphan_count;
        const orphanCount = Number(raw);
        counts.push({
          ...base,
          orphanCount: Number.isFinite(orphanCount) ? orphanCount : 0,
          nullable,
        });
      } catch (error) {
        skipped.push({
          ...base,
          kind: 'probe_failed',
          reason: `Could not probe for orphan rows: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  counts.sort((a, b) => b.orphanCount - a.orphanCount);

  return { engine, counts, skipped };
}

/**
 * Resolve whether to guard-cast the probe's join predicate, and which side,
 * from the LIVE column types rather than the manifest's declared types —
 * mirroring `SchemaComparer.getForeignKeyOrphanOptions()` in
 * `migrations/differ.ts` so the diagnostic and the migration gate treat the
 * same relationship the same way. Only PostgreSQL casts at all
 * (`foreignKeyOrphanParts()` ignores `uuidComparison` on every other engine).
 */
async function resolveUuidCastSide(
  db: DatabaseInterface,
  options: {
    engine: DatabaseEngine;
    declaredUuidComparison: boolean;
    childTable: string;
    childColumn: string;
    parentTable: string;
    parentColumn: string;
  },
): Promise<{ uuidComparison: boolean; uuidCastSide?: ForeignKeyUuidCastSide }> {
  const {
    engine,
    declaredUuidComparison,
    childTable,
    childColumn,
    parentTable,
    parentColumn,
  } = options;
  if (!declaredUuidComparison || engine !== 'postgres') {
    return { uuidComparison: false };
  }
  if (typeof db.getTableSchema !== 'function') {
    // No live-type introspection available on this adapter; fall back to
    // the manifest-declared signal with the builder's own default cast side
    // ('child') rather than refusing to count anything.
    return { uuidComparison: true };
  }

  const childType = await readLiveColumnType(db, childTable, childColumn);
  const parentType = await readLiveColumnType(db, parentTable, parentColumn);
  if (!childType || !parentType) {
    return { uuidComparison: true };
  }

  const childIsUuid = isUuidType(childType);
  const parentIsUuid = isUuidType(parentType);
  if (childIsUuid === parentIsUuid) {
    // Both sides already agree (native uuid/uuid, or the #2608-tolerated
    // legacy text/text component) — compare directly, no guarded cast.
    return { uuidComparison: false };
  }
  return {
    uuidComparison: true,
    uuidCastSide: childIsUuid ? 'parent' : 'child',
  };
}

function isUuidType(type: string): boolean {
  return type.toUpperCase().includes('UUID');
}

async function readLiveColumnType(
  db: DatabaseInterface,
  tableName: string,
  columnName: string,
): Promise<string | undefined> {
  try {
    const schema = await db.getTableSchema?.(tableName);
    const type = schema?.columns?.[columnName]?.type;
    return type === undefined || type === null ? undefined : String(type);
  } catch {
    // Introspection failure here is not the probe failing — the caller
    // falls back to the manifest-declared signal, and the COUNT(*) probe
    // itself still runs and can report its own failure.
    return undefined;
  }
}

function resolveEngine(
  db: DatabaseInterface,
  engineHint?: string,
): DatabaseEngine {
  if (typeof (db as { exportTable?: unknown }).exportTable === 'function') {
    return 'json';
  }
  const dbWithConfig = db as DatabaseInterface & { config?: { url?: string } };
  return detectEngine(db.url || dbWithConfig.config?.url || '', engineHint);
}

async function listLiveTables(
  db: DatabaseInterface,
  engine: DatabaseEngine,
): Promise<Set<string>> {
  const sql =
    engine === 'postgres'
      ? `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      : `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;

  const result = await db.query(sql);
  const rows = ((result as { rows?: unknown[] })?.rows ?? []) as {
    name?: string;
    table_name?: string;
  }[];
  return new Set(
    rows.map((row) => row.name || row.table_name || '').filter(Boolean),
  );
}
