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
          reason: `Child table \`${childTable}\` does not exist in the live database.`,
        });
        continue;
      }
      if (!liveTables.has(parentTable)) {
        skipped.push({
          ...base,
          reason: `Parent table \`${parentTable}\` does not exist in the live database.`,
        });
        continue;
      }

      const childColumnDefinition = schema.columns[foreignKey.column];
      const nullable = childColumnDefinition?.notNull !== true;
      const parentColumnDefinition =
        schemas[parentTable]?.columns[foreignKey.referencesColumn];
      const uuidComparison =
        childColumnDefinition?.type === 'UUID' &&
        (parentColumnDefinition === undefined ||
          parentColumnDefinition.type === 'UUID');

      const sql = renderForeignKeyOrphanDetector(childTable, foreignKey, {
        engine,
        countOnly: true,
        uuidComparison,
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
          reason: `Could not probe for orphan rows: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  counts.sort((a, b) => b.orphanCount - a.orphanCount);

  return { engine, counts, skipped };
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
