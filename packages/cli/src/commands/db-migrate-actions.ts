import { createHash } from 'node:crypto';

export interface MigrationAction {
  type:
    | 'add_column'
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
  mismatch?: {
    column: string;
    expected: string;
    actual: string;
  };
  sql?: string;
  sqlStatements?: string[];
}

export interface SchemaChangeLike {
  type:
    | 'add_table'
    | 'drop_table'
    | 'add_column'
    | 'drop_column'
    | 'add_index'
    | 'drop_index'
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
  sql?: string;
  sqlStatements?: string[];
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

export function getSyntheticMigrationNameForAction(
  action: MigrationAction,
): string | null {
  switch (action.type) {
    case 'add_column':
      return action.column
        ? `add_column_${action.tableName}_${action.column.name}`
        : null;

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

    case 'drop_index': {
      if (!action.indexName) return null;
      const fingerprint = sqlShapeFingerprint(action);
      return fingerprint
        ? `drop_index_${action.indexName}_${fingerprint}`
        : `drop_index_${action.indexName}`;
    }

    case 'type_upgrade':
      return action.column
        ? `type_upgrade_${action.tableName}_${action.column.name}`
        : null;

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

    case 'type_upgrade':
      return change.name ? `type_upgrade_${change.table}_${change.name}` : null;

    default:
      return null;
  }
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

    const migrationName = getSyntheticMigrationNameForChange(change);
    if (migrationName) {
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
} {
  const migrations: MigrationAction[] = [];
  const manualInterventions: MigrationAction[] = [];

  for (const change of changes) {
    const className = getClassForTable(change.table);

    switch (change.type) {
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

  return { migrations, manualInterventions };
}
