import type {
  SchemaChange,
  SchemaDiff,
  SchemaMigrationRecord,
} from '@happyvertical/smrt-core/migrations';
import { classifyTypeUpgradeSql } from './db-migrate-actions.js';

export type FailedMigrationResolution =
  | 'action_required'
  | 'superseded'
  | 'manual_review';

export interface FailedMigrationAssessment {
  name: string;
  resolution: FailedMigrationResolution;
  kind: 'add_column' | 'add_index' | 'type_upgrade' | 'other';
  reason: string;
  errorMessage: string | null;
}

function getGeneratedMigrationName(change: SchemaChange): string | null {
  if (change.type === 'add_column' && change.name) {
    return `add_column_${change.table}_${change.name}`;
  }

  if (change.type === 'add_index') {
    const indexName = change.index?.name || change.name;
    return indexName ? `add_index_${indexName}` : null;
  }

  if (change.type === 'type_upgrade' && change.name) {
    if (classifyTypeUpgradeSql(change.sql) === 'noop') {
      return null;
    }
    return `type_upgrade_${change.table}_${change.name}`;
  }

  return null;
}

export function getActionableFailedMigrationNames(
  diff: SchemaDiff,
): Set<string> {
  const names = new Set<string>();

  for (const change of diff.changes) {
    const name = getGeneratedMigrationName(change);
    if (name) {
      names.add(name);
    }
  }

  return names;
}

function classifyKind(name: string): FailedMigrationAssessment['kind'] {
  if (name.startsWith('add_column_')) return 'add_column';
  if (name.startsWith('add_index_')) return 'add_index';
  if (name.startsWith('type_upgrade_')) return 'type_upgrade';
  return 'other';
}

export function assessFailedMigrations(
  failedMigrations: SchemaMigrationRecord[],
  diff: SchemaDiff | null,
): FailedMigrationAssessment[] {
  const actionableNames = diff ? getActionableFailedMigrationNames(diff) : null;

  return failedMigrations.map((migration) => {
    const kind = classifyKind(migration.name);

    if (actionableNames?.has(migration.name)) {
      return {
        name: migration.name,
        resolution: 'action_required',
        kind,
        reason:
          'Current manifests still require this schema change in the live database.',
        errorMessage: migration.error_message,
      };
    }

    if (!actionableNames) {
      return {
        name: migration.name,
        resolution: 'manual_review',
        kind,
        reason:
          'Live schema comparison was unavailable, so SMRT could not determine whether this failed migration is still required.',
        errorMessage: migration.error_message,
      };
    }

    if (kind !== 'other') {
      return {
        name: migration.name,
        resolution: 'superseded',
        kind,
        reason:
          'Current manifests no longer require this generated schema change, so the failed row is retained history rather than active drift.',
        errorMessage: migration.error_message,
      };
    }

    return {
      name: migration.name,
      resolution: 'manual_review',
      kind,
      reason:
        'This failed migration is not a generated additive schema change. Review it directly before clearing or retrying it.',
      errorMessage: migration.error_message,
    };
  });
}
