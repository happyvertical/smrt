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
  type: 'add_column' | 'add_index' | 'type_mismatch' | 'type_upgrade';
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
