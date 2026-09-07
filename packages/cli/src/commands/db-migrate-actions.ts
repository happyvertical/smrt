import { createHash } from 'node:crypto';

/**
 * Which column property an `alter_column` change repairs (mirrors
 * `ColumnAlteration` in @happyvertical/smrt-core).
 */
export type ColumnAlterationLike =
  | 'set_not_null'
  | 'drop_not_null'
  | 'set_default'
  | 'drop_default';

/**
 * Report-only detail attached to a change the differ surfaces but does not
 * execute (mirrors `SchemaChangeAdvisory` in @happyvertical/smrt-core).
 */
export interface SchemaChangeAdvisoryLike {
  severity: 'warning' | 'info';
  message: string;
  suggestedSql?: string[];
}

/** Mirrors core's `ForeignKeyAction` (see `@happyvertical/smrt-core/schema`). */
export type ForeignKeyActionLike =
  | 'CASCADE'
  | 'SET NULL'
  | 'RESTRICT'
  | 'NO ACTION';

/**
 * Local mirror of core's `ForeignKeyDefinition` — just enough shape for
 * dependency analysis (#2748) and for rebuilding the `ADD CONSTRAINT`
 * statements after an orphan-FK disposition repairs the blocking rows.
 */
export interface ForeignKeyDefinitionLike {
  column: string;
  referencesTable: string;
  referencesColumn: string;
  onDelete?: ForeignKeyActionLike;
  onUpdate?: ForeignKeyActionLike;
}

export interface MigrationAction {
  type:
    | 'add_column'
    | 'drop_column'
    | 'alter_column'
    | 'add_foreign_key'
    | 'drop_foreign_key'
    | 'add_index'
    | 'drop_index'
    | 'type_mismatch'
    | 'type_upgrade';
  tableName: string;
  className: string;
  column?: {
    name: string;
    type: string;
    notNull?: boolean;
    defaultValue?: unknown;
    unique?: boolean;
  };
  index?: {
    name: string;
    columns: string[];
    unique?: boolean;
  };
  /**
   * Set on `drop_index` actions — the index name being dropped. We track
   * this separately from `index` because the differ does not (and cannot,
   * for the orphan-drop case) always know the original column list of a
   * DB-side index that's being removed.
   */
  indexName?: string;
  /**
   * Set on `drop_column` / `alter_column` actions — the live column name.
   * `column` is only populated when the differ had a manifest definition.
   */
  columnName?: string;
  /** Set on `alter_column` actions (#2369). */
  alteration?: ColumnAlterationLike;
  /**
   * Ordering phase carried through from `SchemaChange.phase` (#2608).
   * `pre_foreign_key` marks the pre-R11 `text` -> `uuid` convergence, which
   * must run before every `CREATE TABLE` (an acyclic new child keeps its
   * foreign key inline) and before every foreign-key statement in the batch.
   */
  phase?: 'pre_foreign_key';
  mismatch?: {
    column: string;
    expected: string;
    actual: string;
  };
  sql?: string;
  sqlStatements?: string[];
  advisory?: SchemaChangeAdvisoryLike;
  /** Set on `add_foreign_key` / `drop_foreign_key` actions (#2748). */
  foreignKey?: ForeignKeyDefinitionLike;
  /** See `SchemaChangeLike.orphanBlocked` (#2748). */
  orphanBlocked?: boolean;
  /** See `SchemaChangeLike.orphanNullable` (#2748). */
  orphanNullable?: boolean;
  /** See `SchemaChangeLike.engineUnsupported` (#2748). */
  engineUnsupported?: boolean;
}

/**
 * A change the differ reports but does not execute: orphan columns/indexes
 * and relaxations not opted into (#2369). Surfaced by db:migrate/db:diff/
 * db:status; never turned into a tracker migration.
 */
export interface SchemaAdvisory {
  type:
    | 'orphan_column'
    | 'orphan_index'
    | 'alter_column'
    | 'type_upgrade'
    | 'rename_data_pending';
  tableName: string;
  className: string;
  name: string;
  alteration?: ColumnAlterationLike;
  actual?: string;
  advisory: SchemaChangeAdvisoryLike;
}

export interface SchemaChangeLike {
  type:
    | 'add_table'
    | 'drop_table'
    | 'add_column'
    | 'drop_column'
    | 'alter_column'
    | 'orphan_column'
    | 'add_foreign_key'
    | 'drop_foreign_key'
    | 'add_index'
    | 'drop_index'
    | 'orphan_index'
    | 'type_mismatch'
    | 'type_upgrade'
    | 'rename_data_pending';
  table: string;
  name?: string;
  column?: {
    type: string;
    notNull?: boolean;
    defaultValue?: unknown;
    unique?: boolean;
  };
  index?: {
    name: string;
    columns: string[];
    unique?: boolean;
  };
  mismatch?: {
    expected: string;
    actual: string;
  };
  alteration?: ColumnAlterationLike;
  /** See `MigrationAction.phase` (#2608). */
  phase?: 'pre_foreign_key';
  advisory?: SchemaChangeAdvisoryLike;
  sql?: string;
  sqlStatements?: string[];
  /** Set on `add_foreign_key` / `drop_foreign_key` changes (#2748). */
  foreignKey?: ForeignKeyDefinitionLike;
  /**
   * True on an advisory-only `add_foreign_key` change specifically blocked
   * by live orphan child rows (#2748), as opposed to any other manual-repair
   * reason. Mirrors core's `SchemaChange.orphanBlocked`.
   */
  orphanBlocked?: boolean;
  /**
   * Present alongside `orphanBlocked: true`: whether the child column
   * allows NULL. Mirrors core's `SchemaChange.orphanNullable`.
   */
  orphanNullable?: boolean;
  /**
   * True on an advisory-only `add_foreign_key` change blocked because this
   * engine cannot express the constraint at all (SQLite/DuckDB), as opposed
   * to a data or type problem with the column itself. Mirrors core's
   * `SchemaChange.engineUnsupported`.
   */
  engineUnsupported?: boolean;
}

/** True when a change carries an advisory and no executable statement. */
export function isAdvisoryOnlyChangeLike(change: {
  advisory?: SchemaChangeAdvisoryLike;
  sql?: string;
  sqlStatements?: string[];
}): boolean {
  if (!change.advisory) return false;
  const statements = change.sqlStatements ?? (change.sql ? [change.sql] : []);
  return statements.length === 0;
}

export type TypeUpgradeExecutionKind = 'executable' | 'manual' | 'noop';
export type FailedMigrationClassification =
  | 'unresolved'
  | 'superseded'
  | 'other';
export interface FailedMigrationLike {
  name: string;
  error_message?: string | null;
}

export interface FailedMigrationSummaryItem {
  name: string;
  classification: FailedMigrationClassification;
  recommendation: string;
  errorMessage: string | null;
}

export interface FailedMigrationBuckets {
  unresolved: FailedMigrationSummaryItem[];
  superseded: FailedMigrationSummaryItem[];
  other: FailedMigrationSummaryItem[];
}

export interface DbMigrateFailureState {
  manualInterventionCount?: number;
  tableErrorCount?: number;
  migrationErrorCount?: number;
  stiErrorCount?: number;
  dryRun?: boolean;
}

/**
 * Short stable fingerprint of the SQL we'd execute for an action, used
 * to disambiguate index synthetic ids when an index's shape changes
 * across migrations.
 *
 * Issue #1165: when shape-drift repair recreates an index under the same
 * name (e.g., `tenants_slug_context_meta_type_idx` flipped non-unique →
 * unique), the new `add_index_<name>` migration carries different SQL
 * than the previous run's record. The MigrationTracker rejects "Already
 * applied with different checksum" even under `reconcile: true`. By
 * including this fingerprint in the synthetic id, each distinct shape
 * gets its own tracker row and the repair always applies cleanly.
 */
function sqlShapeFingerprint(action: {
  sql?: string;
  sqlStatements?: string[];
  index?: { name: string; columns: string[]; unique?: boolean };
}): string {
  const parts: string[] = [];
  if (action.sqlStatements && action.sqlStatements.length > 0) {
    parts.push(...action.sqlStatements);
  } else if (action.sql) {
    parts.push(action.sql);
  } else if (action.index) {
    // Fallback: derive a fingerprint from the structural index shape so
    // callers without SQL still get distinct ids for distinct shapes.
    parts.push(
      `${action.index.name}|${(action.index.unique ?? false) ? 'U' : 'N'}|${action.index.columns.join(',')}`,
    );
  }
  if (parts.length === 0) {
    return '';
  }
  // Normalize whitespace so trivial reformatting doesn't churn the hash.
  const normalized = parts.map((s) => s.replace(/\s+/g, ' ').trim()).join(';');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}

/**
 * Keep type-upgrade tracker identities tied to the specific conversion, not
 * merely the table and column. A column may legitimately undergo multiple
 * upgrades over its lifetime; reusing the old bare id would make
 * MigrationTracker compare different SQL checksums against applied history.
 *
 * Include the differ's source/target types as well as the normalized SQL
 * shape. The type data keeps fallback identities meaningful when SQL is not
 * available, while the SQL fingerprint distinguishes conversions with the
 * same endpoints but different semantics (for example a UTC interpretation).
 */
function typeUpgradeFingerprint(action: {
  sql?: string;
  sqlStatements?: string[];
  column?: { type: string };
  mismatch?: { expected: string; actual: string };
}): string {
  const source = action.mismatch?.actual ?? '';
  const target = action.mismatch?.expected ?? action.column?.type ?? '';
  const conversion = sqlShapeFingerprint(action);

  if (!source && !target && !conversion) {
    return '';
  }

  return createHash('sha256')
    .update(`source:${source};target:${target};conversion:${conversion}`)
    .digest('hex')
    .slice(0, 8);
}

export function classifyTypeUpgradeSql(sql?: string): TypeUpgradeExecutionKind {
  const trimmed = sql?.trim();

  if (!trimmed) {
    return 'manual';
  }

  if (!trimmed.startsWith('--')) {
    return 'executable';
  }

  if (
    /no change needed/i.test(trimmed) ||
    /already stores .* as /i.test(trimmed)
  ) {
    return 'noop';
  }

  return 'manual';
}

/**
 * `alter_column` identities embed the alteration kind and the SQL shape so a
 * column that is tightened, relaxed, and tightened again over its lifetime
 * never reuses an applied tracker id with a different checksum (#2369).
 */
function alterColumnMigrationName(
  tableName: string,
  columnName: string,
  alteration: ColumnAlterationLike | undefined,
  action: { sql?: string; sqlStatements?: string[] },
): string {
  const kind = alteration ?? 'alter';
  const fingerprint = sqlShapeFingerprint(action);
  return fingerprint
    ? `alter_column_${tableName}_${columnName}_${kind}_${fingerprint}`
    : `alter_column_${tableName}_${columnName}_${kind}`;
}

export function getSyntheticMigrationNameForAction(
  action: MigrationAction,
): string | null {
  switch (action.type) {
    case 'add_column':
      return action.column
        ? `add_column_${action.tableName}_${action.column.name}`
        : null;

    case 'drop_column': {
      const columnName = action.columnName ?? action.column?.name;
      return columnName
        ? `drop_column_${action.tableName}_${columnName}`
        : null;
    }

    case 'alter_column': {
      const columnName = action.columnName ?? action.column?.name;
      return columnName
        ? alterColumnMigrationName(
            action.tableName,
            columnName,
            action.alteration,
            action,
          )
        : null;
    }

    case 'add_index': {
      if (!action.index) return null;
      // The 8-char fingerprint dodges checksum collisions when the same
      // index name is recreated with a different shape across migrate
      // runs. Issue #1165.
      const fingerprint = sqlShapeFingerprint(action);
      return fingerprint
        ? `add_index_${action.index.name}_${fingerprint}`
        : `add_index_${action.index.name}`;
    }

    case 'add_foreign_key': {
      const fingerprint = sqlShapeFingerprint(action);
      return fingerprint
        ? `add_foreign_key_${action.tableName}_${fingerprint}`
        : null;
    }

    case 'drop_foreign_key': {
      const fingerprint = sqlShapeFingerprint(action);
      return fingerprint
        ? `drop_foreign_key_${action.tableName}_${fingerprint}`
        : null;
    }

    case 'drop_index': {
      if (!action.indexName) return null;
      const fingerprint = sqlShapeFingerprint(action);
      return fingerprint
        ? `drop_index_${action.indexName}_${fingerprint}`
        : `drop_index_${action.indexName}`;
    }

    case 'type_upgrade': {
      if (!action.column) return null;
      // Issue #2111: conversions for the same column must never reuse an
      // applied tracker id with different SQL/checksum.
      const fingerprint = typeUpgradeFingerprint(action);
      return fingerprint
        ? `type_upgrade_${action.tableName}_${action.column.name}_${fingerprint}`
        : `type_upgrade_${action.tableName}_${action.column.name}`;
    }

    default:
      return null;
  }
}

export function getSyntheticMigrationNameForChange(
  change: SchemaChangeLike,
): string | null {
  switch (change.type) {
    case 'add_column':
      return change.name ? `add_column_${change.table}_${change.name}` : null;

    case 'drop_column':
      return change.name ? `drop_column_${change.table}_${change.name}` : null;

    case 'alter_column':
      return change.name && !isAdvisoryOnlyChangeLike(change)
        ? alterColumnMigrationName(
            change.table,
            change.name,
            change.alteration,
            change,
          )
        : null;

    case 'add_index': {
      const indexName = change.index?.name ?? change.name;
      if (!indexName) return null;
      const fingerprint = sqlShapeFingerprint({
        sql: change.sql,
        sqlStatements: change.sqlStatements,
        index: change.index,
      });
      return fingerprint
        ? `add_index_${indexName}_${fingerprint}`
        : `add_index_${indexName}`;
    }

    case 'add_foreign_key': {
      const fingerprint = sqlShapeFingerprint(change);
      return fingerprint
        ? `add_foreign_key_${change.table}_${fingerprint}`
        : null;
    }

    case 'drop_foreign_key': {
      const fingerprint = sqlShapeFingerprint(change);
      return fingerprint
        ? `drop_foreign_key_${change.table}_${fingerprint}`
        : null;
    }

    case 'drop_index': {
      if (!change.name) return null;
      const fingerprint = sqlShapeFingerprint({
        sql: change.sql,
        sqlStatements: change.sqlStatements,
      });
      return fingerprint
        ? `drop_index_${change.name}_${fingerprint}`
        : `drop_index_${change.name}`;
    }

    case 'type_upgrade': {
      if (!change.name) return null;
      const fingerprint = typeUpgradeFingerprint(change);
      return fingerprint
        ? `type_upgrade_${change.table}_${change.name}_${fingerprint}`
        : `type_upgrade_${change.table}_${change.name}`;
    }

    default:
      return null;
  }
}

/**
 * Return every tracker name that can represent the current schema change.
 *
 * New type upgrades use a fingerprinted id, but releases before #2111 wrote
 * failures under the bare table-and-column id. Keep that old id as a
 * classification alias only: execution always uses the fingerprinted id, so
 * no applied migration record is rewritten or reused for a new conversion.
 */
export function getSyntheticMigrationNamesForChange(
  change: SchemaChangeLike,
): string[] {
  const migrationName = getSyntheticMigrationNameForChange(change);
  if (!migrationName) {
    return [];
  }

  if (change.type === 'type_upgrade' && change.name) {
    const legacyName = `type_upgrade_${change.table}_${change.name}`;
    return migrationName === legacyName
      ? [migrationName]
      : [migrationName, legacyName];
  }

  return [migrationName];
}

export function shouldFailDbMigrate(state: DbMigrateFailureState): boolean {
  return (
    (state.tableErrorCount ?? 0) > 0 ||
    (state.migrationErrorCount ?? 0) > 0 ||
    (state.stiErrorCount ?? 0) > 0 ||
    (!state.dryRun && (state.manualInterventionCount ?? 0) > 0)
  );
}

export function shouldApplySchemaMigrations(state: {
  dryRun?: boolean;
}): boolean {
  return !state.dryRun;
}

export function classifyFailedMigration(
  migrationName: string,
  unresolvedSyntheticMigrationNames: Set<string>,
): FailedMigrationClassification {
  if (
    !migrationName.startsWith('add_column_') &&
    !migrationName.startsWith('drop_column_') &&
    !migrationName.startsWith('alter_column_') &&
    !migrationName.startsWith('add_foreign_key_') &&
    !migrationName.startsWith('drop_foreign_key_') &&
    !migrationName.startsWith('add_index_') &&
    !migrationName.startsWith('drop_index_') &&
    !migrationName.startsWith('type_upgrade_')
  ) {
    return 'other';
  }

  return unresolvedSyntheticMigrationNames.has(migrationName)
    ? 'unresolved'
    : 'superseded';
}

export function getUnresolvedGeneratedMigrationNames(
  changes: SchemaChangeLike[],
): Set<string> {
  const names = new Set<string>();

  for (const change of changes) {
    if (
      change.type !== 'add_column' &&
      change.type !== 'drop_column' &&
      change.type !== 'alter_column' &&
      change.type !== 'add_foreign_key' &&
      change.type !== 'drop_foreign_key' &&
      change.type !== 'add_index' &&
      change.type !== 'drop_index' &&
      change.type !== 'type_upgrade'
    ) {
      continue;
    }

    if (
      change.type === 'type_upgrade' &&
      classifyTypeUpgradeSql(change.sql) === 'noop'
    ) {
      continue;
    }

    // Report-only relaxations and refused convergences (#2608) never become
    // tracker migrations.
    if (
      (change.type === 'alter_column' || change.type === 'type_upgrade') &&
      isAdvisoryOnlyChangeLike(change)
    ) {
      continue;
    }

    for (const migrationName of getSyntheticMigrationNamesForChange(change)) {
      names.add(migrationName);
    }
  }

  return names;
}

export const getUnresolvedAdditiveMigrationNames =
  getUnresolvedGeneratedMigrationNames;

export function getFailedMigrationRecommendation(
  classification: FailedMigrationClassification,
  liveSchemaCompared: boolean = true,
): string {
  switch (classification) {
    case 'unresolved':
      return 'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed generated schema repair no longer appears as unresolved.';
    case 'superseded':
      return 'No current live-schema drift maps to this failed generated schema repair. Keep the row for audit history, but it no longer blocks the current schema.';
    default:
      return liveSchemaCompared
        ? 'Inspect this failed migration directly. It is not a superseded generated schema repair and may still need manual attention.'
        : 'Inspect this failed migration directly. Live schema comparison was unavailable, so SMRT could not determine whether it has been superseded.';
  }
}

export function summarizeFailedMigrations(
  failedMigrations: FailedMigrationLike[],
  unresolvedSyntheticMigrationNames: Set<string> | null,
): FailedMigrationBuckets {
  const liveSchemaCompared = unresolvedSyntheticMigrationNames !== null;
  const buckets: FailedMigrationBuckets = {
    unresolved: [],
    superseded: [],
    other: [],
  };

  for (const migration of failedMigrations) {
    const classification = unresolvedSyntheticMigrationNames
      ? classifyFailedMigration(
          migration.name,
          unresolvedSyntheticMigrationNames,
        )
      : 'other';
    const summary: FailedMigrationSummaryItem = {
      name: migration.name,
      classification,
      recommendation: getFailedMigrationRecommendation(
        classification,
        liveSchemaCompared,
      ),
      errorMessage: migration.error_message ?? null,
    };

    buckets[classification].push(summary);
  }

  return buckets;
}

export function partitionSchemaChanges(
  changes: SchemaChangeLike[],
  getClassForTable: (tableName: string) => string,
): {
  migrations: MigrationAction[];
  manualInterventions: MigrationAction[];
  /**
   * Report-only findings (#2369): orphan columns/indexes and relaxations the
   * operator has not opted into. Printed, never executed, and they never
   * fail db:migrate on their own.
   */
  advisories: SchemaAdvisory[];
} {
  const migrations: MigrationAction[] = [];
  const manualInterventions: MigrationAction[] = [];
  const advisories: SchemaAdvisory[] = [];

  for (const change of changes) {
    const className = getClassForTable(change.table);

    switch (change.type) {
      case 'orphan_column':
      case 'orphan_index':
      case 'rename_data_pending': {
        if (!change.name || !change.advisory) continue;
        advisories.push({
          type: change.type,
          tableName: change.table,
          className,
          name: change.name,
          actual: change.mismatch?.actual,
          advisory: change.advisory,
        });
        break;
      }

      case 'drop_column': {
        if (!change.name) continue;
        migrations.push({
          type: 'drop_column',
          tableName: change.table,
          className,
          columnName: change.name,
          mismatch: change.mismatch
            ? {
                column: change.name,
                expected: change.mismatch.expected,
                actual: change.mismatch.actual,
              }
            : undefined,
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
        });
        break;
      }

      case 'alter_column': {
        if (!change.name) continue;
        if (isAdvisoryOnlyChangeLike(change) && change.advisory) {
          advisories.push({
            type: 'alter_column',
            tableName: change.table,
            className,
            name: change.name,
            alteration: change.alteration,
            actual: change.mismatch?.actual,
            advisory: change.advisory,
          });
          break;
        }
        const action: MigrationAction = {
          type: 'alter_column',
          tableName: change.table,
          className,
          columnName: change.name,
          alteration: change.alteration,
          ...(change.column
            ? {
                column: {
                  name: change.name,
                  type: change.column.type,
                  notNull: change.column.notNull,
                  defaultValue: change.column.defaultValue,
                  unique: change.column.unique,
                },
              }
            : {}),
          mismatch: change.mismatch
            ? {
                column: change.name,
                expected: change.mismatch.expected,
                actual: change.mismatch.actual,
              }
            : undefined,
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
        };
        // Same executable / manual split as type upgrades: comment-only SQL
        // means the engine cannot alter the column in place (SQLite) or the
        // differ found live data that blocks the repair.
        if (classifyTypeUpgradeSql(change.sql) === 'executable') {
          migrations.push(action);
        } else {
          manualInterventions.push(action);
        }
        break;
      }

      case 'add_column': {
        const col = change.column;
        if (!change.name || !col) continue;
        migrations.push({
          type: 'add_column',
          tableName: change.table,
          className,
          column: {
            name: change.name,
            type: col.type,
            notNull: col.notNull,
            defaultValue: col.defaultValue,
            unique: col.unique,
          },
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
        });
        break;
      }

      case 'add_index': {
        const idx = change.index;
        if (!idx) continue;
        migrations.push({
          type: 'add_index',
          tableName: change.table,
          className,
          index: {
            name: idx.name,
            columns: idx.columns,
            unique: idx.unique,
          },
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
        });
        break;
      }

      case 'add_foreign_key':
      case 'drop_foreign_key': {
        const action: MigrationAction = {
          type: change.type,
          tableName: change.table,
          className,
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
          advisory: change.advisory,
          ...(change.foreignKey ? { foreignKey: change.foreignKey } : {}),
          ...(change.orphanBlocked !== undefined
            ? { orphanBlocked: change.orphanBlocked }
            : {}),
          ...(change.orphanNullable !== undefined
            ? { orphanNullable: change.orphanNullable }
            : {}),
          ...(change.engineUnsupported !== undefined
            ? { engineUnsupported: change.engineUnsupported }
            : {}),
        };
        if (isAdvisoryOnlyChangeLike(change)) {
          manualInterventions.push(action);
        } else {
          migrations.push(action);
        }
        break;
      }

      case 'drop_index': {
        // Issue #1165: shape-drift repair pushes `drop_index` then
        // `add_index` for the same name in change-order. We preserve that
        // order in `migrations` by pushing here, so the drop runs before
        // the add and the recreate actually happens (otherwise the add's
        // `IF NOT EXISTS` silently no-ops against the wrong-shape index).
        // Orphan-index drops (opt-in via includeDroppedIndexes) flow
        // through the same path.
        if (!change.name) continue;
        migrations.push({
          type: 'drop_index',
          tableName: change.table,
          className,
          indexName: change.name,
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
        });
        break;
      }

      case 'type_mismatch': {
        const mm = change.mismatch;
        if (!change.name || !mm) continue;
        manualInterventions.push({
          type: 'type_mismatch',
          tableName: change.table,
          className,
          mismatch: {
            column: change.name,
            expected: mm.expected,
            actual: mm.actual,
          },
        });
        break;
      }

      case 'type_upgrade': {
        const mm = change.mismatch;
        const col = change.column;
        // #2608: a refused uuid convergence is report-only — it carries an
        // advisory and no SQL. Surfacing it as a manual intervention would
        // claim `db:migrate` can fix it; it belongs with the other blocked
        // findings so the operator sees the reason and the manual repair.
        if (isAdvisoryOnlyChangeLike(change) && change.advisory) {
          if (!change.name) continue;
          advisories.push({
            type: 'type_upgrade',
            tableName: change.table,
            className,
            name: change.name,
            actual: mm?.actual,
            advisory: change.advisory,
          });
          break;
        }
        if (!change.name || !mm || !col) continue;
        const action: MigrationAction = {
          type: 'type_upgrade',
          tableName: change.table,
          className,
          column: {
            name: change.name,
            type: col.type,
            notNull: col.notNull,
            defaultValue: col.defaultValue,
            unique: col.unique,
          },
          ...(change.phase ? { phase: change.phase } : {}),
          mismatch: {
            column: change.name,
            expected: mm.expected,
            actual: mm.actual,
          },
          sql: change.sql,
          ...(change.sqlStatements
            ? { sqlStatements: change.sqlStatements }
            : {}),
        };
        const executionKind = classifyTypeUpgradeSql(change.sql);

        if (executionKind === 'executable') {
          migrations.push(action);
        } else if (executionKind === 'manual') {
          manualInterventions.push(action);
        }
        break;
      }
    }
  }

  return { migrations, manualInterventions, advisories };
}

/**
 * Print report-only schema findings (#2369) in a stable order: warnings
 * first (an orphan NOT NULL column that breaks inserts, a stale unique
 * constraint, a relaxation not opted into), then info, then orphan tables
 * (verbose only — shared databases legitimately hold tables from other
 * apps). Shared by db:migrate and db:diff so both commands report the same
 * findings the same way.
 */
export function printSchemaAdvisories(
  advisories: SchemaAdvisory[],
  options: {
    orphanTables?: string[];
    verbose?: boolean;
    log?: (line: string) => void;
  } = {},
): void {
  const log = options.log ?? ((line: string) => console.log(line));
  const warnings = advisories.filter((a) => a.advisory.severity === 'warning');
  const infos = advisories.filter((a) => a.advisory.severity !== 'warning');

  if (warnings.length > 0) {
    log(
      '⚠️  Live schema findings that need an operator decision (not applied):\n',
    );
    for (const item of warnings) {
      log(`   ${describeAdvisory(item)}`);
      log(`     ${item.advisory.message}`);
      for (const suggestion of item.advisory.suggestedSql ?? []) {
        log(`     ↳ ${suggestion}`);
      }
    }
    log('');
  }

  if (infos.length > 0) {
    log(`ℹ️  Live schema notes (${infos.length}, not applied):`);
    for (const item of infos) {
      log(`   ${describeAdvisory(item)}`);
      if (options.verbose) {
        log(`     ${item.advisory.message}`);
        for (const suggestion of item.advisory.suggestedSql ?? []) {
          log(`     ↳ ${suggestion}`);
        }
      }
    }
    log('');
  }

  const orphanTables = options.orphanTables ?? [];
  if (orphanTables.length > 0 && options.verbose) {
    log(
      `ℹ️  Tables in the database that no loaded manifest declares (${orphanTables.length}): ${orphanTables.join(', ')}`,
    );
    log('   Not dropped; remove them manually if they are stale.\n');
  }
}

function describeAdvisory(item: SchemaAdvisory): string {
  switch (item.type) {
    case 'orphan_column':
      return `${item.tableName}.${item.name}: orphan column${item.actual ? ` (${item.actual})` : ''}`;
    case 'orphan_index':
      return `${item.tableName}.${item.name}: unique constraint not in manifest${item.actual ? ` (${item.actual})` : ''}`;
    case 'type_upgrade':
      return `${item.tableName}.${item.name}: type upgrade blocked${item.actual ? ` (live: ${item.actual})` : ''}`;
    case 'rename_data_pending':
      return `${item.tableName}.${item.name}: rename data pending${item.actual ? ` (${item.actual})` : ''}`;
    default:
      return `${item.tableName}.${item.name}: ${item.alteration ?? 'alter_column'}${item.actual ? ` (live: ${item.actual})` : ''}`;
  }
}

// ---------------------------------------------------------------------------
// #2748: `db:migrate --apply-unblocked` partial-apply partition.
// ---------------------------------------------------------------------------

/** `table.column` identity used to key a blocked column across actions. */
function blockedColumnKey(tableName: string, columnName: string): string {
  return `${tableName}.${columnName}`;
}

/**
 * Column that a manual-intervention action blocks, if any. `type_mismatch`,
 * a manual `type_upgrade`, and a manual `alter_column` each name exactly one
 * live column via `mismatch.column`; a blocked `add_foreign_key` names its
 * child column via `foreignKey.column` — unless the block reason is
 * `engineUnsupported` (this engine cannot express `ALTER TABLE ADD
 * CONSTRAINT` at all, e.g. SQLite/DuckDB): that says nothing about the
 * column's own state, no rerun on this engine ever resolves it, and
 * treating it as a blocked column would withhold unrelated dependent DDL
 * on that column permanently (review finding, #2748). That case blocks no
 * column identity and is excluded from dependency analysis.
 */
function blockedColumnForAction(action: MigrationAction): string | undefined {
  if (
    action.type === 'add_foreign_key' &&
    action.foreignKey &&
    !action.engineUnsupported
  ) {
    return blockedColumnKey(action.tableName, action.foreignKey.column);
  }
  const column =
    action.mismatch?.column ?? action.columnName ?? action.column?.name;
  return column ? blockedColumnKey(action.tableName, column) : undefined;
}

/**
 * Every column a manual intervention blocks, keyed `table.column`, with the
 * human-readable reason (the action's advisory message, or a description of
 * the type mismatch) a dependent change is withheld for. `advisories`
 * includes only report-only `type_upgrade` findings (the #2608 refused
 * uuid convergence) — that shape is a genuine, permanent column-state block
 * that names a column just as concretely as a manual intervention does, so
 * omitting it let `--apply-unblocked` apply an index/alter/drop against a
 * column whose type convergence is itself blocked (review finding, #2748).
 *
 * `alter_column` advisories are deliberately excluded even though the type
 * exists on `SchemaAdvisory`: an advisory-only `alter_column` is produced
 * only by an un-opted-into relaxation (`drop_default`/`drop_not_null` when
 * `--relax-columns` was not passed) — it says the live column is *stricter*
 * than the manifest, not that the column's state blocks anything, and it
 * reappears on every run regardless of `--apply-unblocked`. Treating it as
 * a blocked column reproduced the exact defect this function's
 * `engineUnsupported` exclusion fixed for `add_foreign_key`: permanently
 * withholding unrelated executable DDL on that column (review finding,
 * #2748, second pass). A genuinely blocked `alter_column` (e.g. NOT NULL
 * required with live NULLs and no default) carries executable-looking SQL
 * as a comment and already reaches `manualInterventions` instead, where it
 * is covered by the loop above via `columnName`.
 */
export function computeBlockedColumns(
  manualInterventions: MigrationAction[],
  advisories: SchemaAdvisory[] = [],
): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const action of manualInterventions) {
    const key = blockedColumnForAction(action);
    if (!key || blocked.has(key)) continue;
    blocked.set(key, describeBlockedReason(action));
  }
  for (const advisory of advisories) {
    if (advisory.type !== 'type_upgrade') continue;
    const key = blockedColumnKey(advisory.tableName, advisory.name);
    if (blocked.has(key)) continue;
    blocked.set(
      key,
      advisory.advisory.message ??
        `${advisory.type} requires manual intervention`,
    );
  }
  return blocked;
}

function describeBlockedReason(action: MigrationAction): string {
  if (action.advisory?.message) return action.advisory.message;
  if (action.mismatch) {
    return `expected ${action.mismatch.expected}, found ${action.mismatch.actual}`;
  }
  return `${action.type} requires manual intervention`;
}

/** One migration withheld under `--apply-unblocked` and why. */
export interface WithheldMigration {
  action: MigrationAction;
  /** `table.column` of the blocked change this one depends on. */
  dependsOn: string;
  reason: string;
}

/**
 * Column(s) an executable migration action reads or writes, for dependency
 * analysis against `computeBlockedColumns()`. An `add_index` depends on
 * every indexed column; an `add_foreign_key` depends on its own child
 * column AND the parent column it references (a parent whose type upgrade
 * is blocked is just as unsafe to reference); `alter_column`/`drop_column`
 * depend on the single column they touch. `add_column`/`type_upgrade`/
 * `drop_index` never depend on another column's state — they are either the
 * fix itself or fully self-contained.
 */
function actionColumnDependencies(
  action: MigrationAction,
): { tableName: string; columnName: string }[] {
  switch (action.type) {
    case 'add_index':
      return (action.index?.columns ?? []).map((columnName) => ({
        tableName: action.tableName,
        columnName,
      }));
    case 'add_foreign_key': {
      if (!action.foreignKey) return [];
      return [
        { tableName: action.tableName, columnName: action.foreignKey.column },
        {
          tableName: action.foreignKey.referencesTable,
          columnName: action.foreignKey.referencesColumn,
        },
      ];
    }
    case 'alter_column':
    case 'drop_column': {
      const columnName = action.columnName ?? action.column?.name;
      return columnName ? [{ tableName: action.tableName, columnName }] : [];
    }
    default:
      return [];
  }
}

/**
 * Partition executable migrations (the differ's "safe DDL" bucket) into
 * those independent of every blocked column and those that depend on one
 * (#2748's dependency rule): an index or foreign key on a column whose type
 * upgrade is blocked, or a foreign key whose orphan rows block it, stays
 * withheld; everything else is applied. Pure and order-preserving so a
 * dry-run preview and a real apply partition identically.
 *
 * A `drop_index` carries no column list of its own (a DB-side index being
 * removed; see `MigrationAction.indexName`'s doc comment), so it is never
 * itself a dependency target — EXCEPT when it is the drop half of the
 * #1165 shape-drift recreate pair (`drop_index` then `add_index` for the
 * SAME name, in that order, in the same batch). Withholding the `add_index`
 * half alone while letting its paired `drop_index` proceed would remove the
 * existing index/uniqueness enforcement with no replacement — reachable and
 * unsafe (review, #2748) — so a `drop_index` withholds together with any
 * `add_index` of the same name that this partition withheld.
 */
export function partitionUnblockedMigrations(
  migrations: MigrationAction[],
  blockedColumns: Map<string, string>,
): { applied: MigrationAction[]; withheld: WithheldMigration[] } {
  const directDependency = (
    action: MigrationAction,
  ): { dependsOn: string; reason: string } | undefined => {
    const dependency = actionColumnDependencies(action).find((dep) =>
      blockedColumns.has(blockedColumnKey(dep.tableName, dep.columnName)),
    );
    if (!dependency) return undefined;
    const dependsOn = blockedColumnKey(
      dependency.tableName,
      dependency.columnName,
    );
    return {
      dependsOn,
      reason: blockedColumns.get(dependsOn) ?? 'depends on a blocked change',
    };
  };

  // First pass: every directly-dependent action, and which add_index names
  // were withheld (so a same-named drop_index can be paired with it below).
  const withheldAddIndexDependency = new Map<
    string,
    { dependsOn: string; reason: string }
  >();
  const direct = migrations.map((action) => {
    const dependency = directDependency(action);
    if (dependency && action.type === 'add_index' && action.index?.name) {
      withheldAddIndexDependency.set(action.index.name, dependency);
    }
    return { action, dependency };
  });

  const applied: MigrationAction[] = [];
  const withheld: WithheldMigration[] = [];

  for (const { action, dependency } of direct) {
    if (dependency) {
      withheld.push({ action, ...dependency });
      continue;
    }
    const paired =
      action.type === 'drop_index' && action.indexName
        ? withheldAddIndexDependency.get(action.indexName)
        : undefined;
    if (paired) {
      withheld.push({
        action,
        dependsOn: paired.dependsOn,
        reason: `paired with the withheld rebuild of index ${action.indexName} (${paired.reason})`,
      });
      continue;
    }
    applied.push(action);
  }

  return { applied, withheld };
}

// ---------------------------------------------------------------------------
// #2748: `db:migrate --null-orphans` opt-in orphan-FK disposition.
// ---------------------------------------------------------------------------

/** One orphan-blocked FK the child column allows nulling out. */
export interface OrphanDispositionPlanItem {
  action: MigrationAction;
  tableName: string;
  column: string;
  /** `SELECT ... orphan_key ...` probe the differ generated (read-only). */
  detectorSql: string;
  /** Executable `UPDATE ... SET <column> = NULL WHERE ...` statement. */
  repairSql: string;
}

/**
 * Split `manualInterventions` into orphan-blocked `add_foreign_key` actions
 * whose child column is nullable (an opt-in `--null-orphans` disposition can
 * null the references and proceed) and every other manual intervention,
 * including orphan-blocked FKs on a NOT NULL child column, which keep the
 * existing "Manual repair required" refusal (#2748) unconditionally — a
 * caller must never delete rows to make room for one of these.
 *
 * Reuses the differ's own rendered `advisory.suggestedSql` (detector at
 * index 0, repair at index 1) rather than re-deriving the orphan probe's
 * uuid-cast options, so the disposition always runs exactly the SQL the
 * differ already decided on.
 */
export function planOrphanDispositions(
  manualInterventions: MigrationAction[],
): {
  nullable: OrphanDispositionPlanItem[];
  notNullable: MigrationAction[];
} {
  const nullable: OrphanDispositionPlanItem[] = [];
  const notNullable: MigrationAction[] = [];

  for (const action of manualInterventions) {
    if (action.type !== 'add_foreign_key' || !action.orphanBlocked) continue;
    if (!action.orphanNullable) {
      notNullable.push(action);
      continue;
    }
    const suggested = action.advisory?.suggestedSql ?? [];
    const [detectorSql, repairSql] = suggested;
    if (!action.foreignKey || !detectorSql || !repairSql) {
      // Fail closed: an orphan-blocked, nullable FK without the expected
      // shape (missing foreign key definition or suggested SQL) is a
      // differ-side contract violation, not a case this disposition can
      // safely guess its way through. Report and withhold rather than
      // fabricate SQL.
      notNullable.push(action);
      continue;
    }
    nullable.push({
      action,
      tableName: action.tableName,
      column: action.foreignKey.column,
      detectorSql,
      repairSql,
    });
  }

  return { nullable, notNullable };
}

/**
 * Wrap an orphan-probe `SELECT` (the differ's `renderForeignKeyOrphanDetector`
 * output, a bare `SELECT ... orphan_key ...` with no `LIMIT`) as a
 * `COUNT(*)` so `--null-orphans` can report before/after counts without
 * re-deriving the probe's own uuid-cast options.
 */
export function orphanCountSql(detectorSql: string): string {
  return `SELECT COUNT(*) AS orphan_count FROM (${detectorSql}) AS smrt_orphan_probe`;
}
