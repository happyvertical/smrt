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
import {
  mapWithConcurrency,
  POSTGRES_INTROSPECTION_CONCURRENCY,
  POSTGRES_PROBE_CONCURRENCY,
} from './bounded-concurrency.js';
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

/** Live table schema as returned by `db.getTableSchema()`. */
type LiveTableSchema = Awaited<
  ReturnType<NonNullable<DatabaseInterface['getTableSchema']>>
>;

export interface CollectForeignKeyOrphanCountsOptions {
  /** Explicit engine hint for adapters whose URL is empty or ambiguous. */
  engineHint?: string;
  /**
   * Live table schemas already read in this command over the same
   * connection (e.g. `SchemaComparer.getLiveSchemaSnapshot()` after
   * `compare()`), used instead of re-introspecting those tables. Tables
   * absent from the map are introspected as before.
   */
  liveSchemas?: ReadonlyMap<string, LiveTableSchema | undefined>;
  /**
   * Maximum concurrent live-table introspections. Default:
   * {@link POSTGRES_INTROSPECTION_CONCURRENCY} on PostgreSQL, 1 elsewhere.
   */
  introspectionConcurrency?: number;
  /**
   * Maximum concurrent orphan `COUNT(*)` probes. These scan table data, so
   * the default is lower: {@link POSTGRES_PROBE_CONCURRENCY} on PostgreSQL,
   * 1 elsewhere.
   */
  probeConcurrency?: number;
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
  const isPostgres = engine === 'postgres';
  const introspectionConcurrency =
    options.introspectionConcurrency ??
    (isPostgres ? POSTGRES_INTROSPECTION_CONCURRENCY : 1);
  const probeConcurrency =
    options.probeConcurrency ?? (isPostgres ? POSTGRES_PROBE_CONCURRENCY : 1);
  const liveTables = await listLiveTables(db, engine);
  // One live-schema read per table for the whole report: several foreign
  // keys can share a child table, the uuid cast-side check reads both the
  // child and the parent, and `db.getTableSchema` is several catalog round
  // trips. Both shipped adapters throw on a failed schema lookup rather than
  // returning `null` (review finding, #2748: an unguarded call here aborted
  // the whole report, one bad child table taking down every other
  // relationship's count) — so a failed lookup is cached as `undefined`:
  // this introspection failing is not the orphan probe itself failing, so
  // the relationship still gets counted (falling back to manifest-only
  // nullability and the manifest-declared uuid signal) or lands in
  // `skipped` via the probe's own `catch`.
  const liveSchemaCache = new Map<string, LiveTableSchema | undefined>(
    options.liveSchemas ?? [],
  );
  const fetchLiveSchema = async (
    tableName: string,
  ): Promise<LiveTableSchema | undefined> => {
    try {
      return await db.getTableSchema?.(tableName);
    } catch {
      return undefined;
    }
  };

  interface PlannedProbe {
    base: Omit<ForeignKeyOrphanSkipped, 'reason' | 'kind'>;
    childTable: string;
    foreignKey: ReturnType<typeof schemaForeignKeysForEngine>[number];
    manifestNullable: boolean;
    declaredUuidComparison: boolean;
  }
  type PlanEntry =
    | { kind: 'skip'; skip: ForeignKeyOrphanSkipped }
    | { kind: 'probe'; probe: PlannedProbe };

  // Phase 1 (no queries): decide, in manifest order, which relationships can
  // be probed at all and which live schemas those probes need.
  const plan: PlanEntry[] = [];
  const tablesToIntrospect = new Set<string>();
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
        plan.push({
          kind: 'skip',
          skip: {
            ...base,
            kind: 'missing_table',
            reason: `Child table \`${childTable}\` does not exist in the live database.`,
          },
        });
        continue;
      }
      if (!liveTables.has(parentTable)) {
        plan.push({
          kind: 'skip',
          skip: {
            ...base,
            kind: 'missing_table',
            reason: `Parent table \`${parentTable}\` does not exist in the live database.`,
          },
        });
        continue;
      }

      const childColumnDefinition = schema.columns[foreignKey.column];
      const parentColumnDefinition =
        schemas[parentTable]?.columns[foreignKey.referencesColumn];
      const declaredUuidComparison =
        childColumnDefinition?.type === 'UUID' &&
        (parentColumnDefinition === undefined ||
          parentColumnDefinition.type === 'UUID');

      tablesToIntrospect.add(childTable);
      if (
        declaredUuidComparison &&
        isPostgres &&
        typeof db.getTableSchema === 'function'
      ) {
        tablesToIntrospect.add(parentTable);
      }

      plan.push({
        kind: 'probe',
        probe: {
          base,
          childTable,
          foreignKey,
          manifestNullable: childColumnDefinition?.notNull !== true,
          declaredUuidComparison,
        },
      });
    }
  }

  // Phase 2: introspect every needed table once, with bounded concurrency.
  if (typeof db.getTableSchema === 'function') {
    const pending = [...tablesToIntrospect].filter(
      (tableName) => !liveSchemaCache.has(tableName),
    );
    const fetched = await mapWithConcurrency(
      pending,
      introspectionConcurrency,
      fetchLiveSchema,
    );
    pending.forEach((tableName, index) => {
      liveSchemaCache.set(tableName, fetched[index]);
    });
  }
  const readLiveSchema = (tableName: string): LiveTableSchema | undefined =>
    liveSchemaCache.get(tableName);

  // Phase 3: run the COUNT(*) probes with bounded concurrency, collecting
  // each outcome at its plan position so the report order is independent of
  // completion order.
  const outcomes = await mapWithConcurrency(
    plan,
    probeConcurrency,
    async (
      entry,
    ): Promise<
      | { kind: 'count'; count: ForeignKeyOrphanCount }
      | { kind: 'skip'; skip: ForeignKeyOrphanSkipped }
    > => {
      if (entry.kind === 'skip') return entry;
      const {
        base,
        childTable,
        foreignKey,
        manifestNullable,
        declaredUuidComparison,
      } = entry.probe;

      // Nullable only when BOTH the manifest and the live column agree
      // (review finding, #2748): a manifest relaxed to nullable while the
      // live column is still physically NOT NULL (relaxation pending, not
      // yet applied) is exactly the drift `db:migrate --null-orphans`
      // refuses to null out — this report must say the same thing, or an
      // operator reading `db:orphans`'s "null-out possible" summary and
      // then running `--null-orphans` hits an unconditional refusal for a
      // relationship this report told them was nullable. Mirrors
      // `SchemaComparer.getForeignKeyOrphanOptions()` in
      // `migrations/differ.ts`.
      const liveNotNull =
        readLiveSchema(childTable)?.columns[foreignKey.column]?.notNull ===
        true;
      const nullable = manifestNullable && !liveNotNull;

      // The manifest declaring UUID on both sides is not proof the live
      // columns are actually native uuid yet — #2608 tolerates a legacy
      // component that is still `text` on every side until it converges.
      // Mirror the migration gate's live-type cast-side selection
      // (`SchemaComparer.getForeignKeyOrphanOptions` in migrations/differ.ts)
      // instead of guessing from the manifest alone, or a legacy text/text or
      // text/uuid relationship either errors (`operator does not exist: text
      // = uuid`) or silently mismatches instead of being counted.
      const { uuidComparison, uuidCastSide } = resolveUuidCastSide(db, {
        engine,
        declaredUuidComparison,
        childType: liveColumnType(
          readLiveSchema(childTable),
          foreignKey.column,
        ),
        parentType: liveColumnType(
          readLiveSchema(base.parentTable),
          foreignKey.referencesColumn,
        ),
      });

      const sql = renderForeignKeyOrphanDetector(childTable, foreignKey, {
        engine,
        countOnly: true,
        uuidComparison,
        uuidCastSide,
      });

      try {
        const result = await db.query(sql);
        const rows = normalizeQueryRows(result);
        const raw = rows[0]?.orphan_count;
        const orphanCount = Number(raw);
        return {
          kind: 'count',
          count: {
            ...base,
            orphanCount: Number.isFinite(orphanCount) ? orphanCount : 0,
            nullable,
          },
        };
      } catch (error) {
        return {
          kind: 'skip',
          skip: {
            ...base,
            kind: 'probe_failed',
            reason: `Could not probe for orphan rows: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }
    },
  );

  const counts: ForeignKeyOrphanCount[] = [];
  const skipped: ForeignKeyOrphanSkipped[] = [];
  for (const outcome of outcomes) {
    if (outcome.kind === 'count') counts.push(outcome.count);
    else skipped.push(outcome.skip);
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
function resolveUuidCastSide(
  db: DatabaseInterface,
  options: {
    engine: DatabaseEngine;
    declaredUuidComparison: boolean;
    childType: string | undefined;
    parentType: string | undefined;
  },
): { uuidComparison: boolean; uuidCastSide?: ForeignKeyUuidCastSide } {
  const { engine, declaredUuidComparison, childType, parentType } = options;
  if (!declaredUuidComparison || engine !== 'postgres') {
    return { uuidComparison: false };
  }
  if (typeof db.getTableSchema !== 'function') {
    // No live-type introspection available on this adapter; fall back to
    // the manifest-declared signal with the builder's own default cast side
    // ('child') rather than refusing to count anything.
    return { uuidComparison: true };
  }

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

/**
 * A live column's type from an already-read table schema. A missing table,
 * column, or failed introspection (cached as `undefined`) yields `undefined`,
 * and the caller falls back to the manifest-declared signal — the COUNT(*)
 * probe itself still runs and can report its own failure.
 */
function liveColumnType(
  schema: LiveTableSchema | undefined,
  columnName: string,
): string | undefined {
  const type = schema?.columns?.[columnName]?.type;
  return type === undefined || type === null ? undefined : String(type);
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

/**
 * Normalize a `db.query()` result to a row array. Adapters disagree on the
 * envelope: most return `{ rows }`, but some (per the same normalization in
 * `migrations/differ.ts`'s `getExistingTables()`) return a bare array. A
 * caller that only checks `.rows` reads every row as absent on the latter,
 * which for `listLiveTables()` means every relationship looks like it has a
 * `missing_table` — a silent false negative, not a thrown error.
 */
function normalizeQueryRows(result: unknown): Record<string, unknown>[] {
  return (
    Array.isArray(result)
      ? result
      : ((result as { rows?: unknown[] })?.rows ?? [])
  ) as Record<string, unknown>[];
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
  const rows = normalizeQueryRows(result) as {
    name?: string;
    table_name?: string;
  }[];
  return new Set(
    rows.map((row) => row.name || row.table_name || '').filter(Boolean),
  );
}
