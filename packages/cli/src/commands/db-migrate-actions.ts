export interface MigrationAction {
  type: 'add_column' | 'add_index' | 'type_mismatch' | 'type_upgrade';
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
  mismatch?: {
    column: string;
    expected: string;
    actual: string;
  };
  sql?: string;
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

    case 'add_index':
      return action.index ? `add_index_${action.index.name}` : null;

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
      return indexName ? `add_index_${indexName}` : null;
    }

    case 'type_upgrade':
      return change.name ? `type_upgrade_${change.table}_${change.name}` : null;

    default:
      return null;
  }
}

export function classifyFailedMigration(
  migrationName: string,
  unresolvedSyntheticMigrationNames: Set<string>,
): FailedMigrationClassification {
  if (
    !migrationName.startsWith('add_column_') &&
    !migrationName.startsWith('add_index_')
  ) {
    return 'other';
  }

  return unresolvedSyntheticMigrationNames.has(migrationName)
    ? 'unresolved'
    : 'superseded';
}

export function getUnresolvedAdditiveMigrationNames(
  changes: SchemaChangeLike[],
): Set<string> {
  const names = new Set<string>();

  for (const change of changes) {
    if (change.type !== 'add_column' && change.type !== 'add_index') {
      continue;
    }

    const migrationName = getSyntheticMigrationNameForChange(change);
    if (migrationName) {
      names.add(migrationName);
    }
  }

  return names;
}

export function getFailedMigrationRecommendation(
  classification: FailedMigrationClassification,
  liveSchemaCompared: boolean = true,
): string {
  switch (classification) {
    case 'unresolved':
      return 'Run `smrt db:migrate` to reconcile the live schema, then confirm this failed additive migration no longer appears as unresolved.';
    case 'superseded':
      return 'No current live-schema drift maps to this failed additive migration. Keep the row for audit history, but it no longer blocks the current schema.';
    default:
      return liveSchemaCompared
        ? 'Inspect this failed migration directly. It is not a superseded additive repair and may still need manual attention.'
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
