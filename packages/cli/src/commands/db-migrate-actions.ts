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
}

/**
 * A change the differ reports but does not execute: orphan columns/indexes
 * and relaxations not opted into (#2369). Surfaced by db:migrate/db:diff/
 * db:status; never turned into a tracker migration.
 */
export interface SchemaAdvisory {
  type: 'orphan_column' | 'orphan_index' | 'alter_column' | 'type_upgrade';
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
    | 'type_upgrade';
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
      case 'orphan_index': {
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
    default:
      return `${item.tableName}.${item.name}: ${item.alteration ?? 'alter_column'}${item.actual ? ` (live: ${item.actual})` : ''}`;
  }
}
