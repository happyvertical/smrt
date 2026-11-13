/** Whole-run policy shared by the CLI and application migration wrappers. */
import type { DatabaseEngine } from '../schema/ddl/types.js';
import {
  decideSchemaChange,
  type SchemaChangeInput,
  type SchemaChangeVerdict,
} from './change-kinds.js';

export interface PackagesSeenInput {
  recorded: readonly string[] | null;
  current: readonly string[];
  confirmedRemoved: readonly string[];
}

export interface PackagesSeenCheck {
  state: 'no-record' | 'ok' | 'missing';
  missing: string[];
  unconfirmed: string[];
  ignoredConfirmations: string[];
}

/** Exact recorded names, including app scopes and `<unqualified>`. No writes. */
export function checkPackagesSeen(input: PackagesSeenInput): PackagesSeenCheck {
  const current = new Set(input.current);
  const confirmed = new Set(input.confirmedRemoved);
  const missing = [...new Set(input.recorded ?? [])]
    .filter((name) => !current.has(name))
    .sort();
  const missingSet = new Set(missing);
  const unconfirmed = missing.filter((name) => !confirmed.has(name));
  return {
    state:
      input.recorded === null
        ? 'no-record'
        : unconfirmed.length
          ? 'missing'
          : 'ok',
    missing,
    unconfirmed,
    ignoredConfirmations: [...confirmed]
      .filter((name) => !missingSet.has(name))
      .sort(),
  };
}

export interface MigrationPackageStop {
  packageName: string;
  message: string;
}

export interface MigrationRunStop<T = SchemaChangeInput> {
  change: T;
  kind: SchemaChangeVerdict['kind'];
  reason: NonNullable<SchemaChangeVerdict['stop']>['reason'];
  message: string;
}

export interface HeldBackMigration {
  description: string;
  table: string;
  column?: string;
}

export interface MigrationRunDecision<T = SchemaChangeInput> {
  proceed: boolean;
  packageStops: MigrationPackageStop[];
  notices: string[];
  stops: MigrationRunStop<T>[];
  heldBack: HeldBackMigration[];
}

/**
 * Plan first. One stop refuses every change, including unrelated new tables.
 * Reports never refuse a run. resolvedStops names only changes the caller has
 * explicitly planned to resolve in the same atomic batch (e.g. null orphans).
 * Identity is by reference to the original change, never a guessed column key.
 */
export function decideMigrationRun<T extends SchemaChangeInput>(options: {
  changes: readonly T[];
  addedTables?: readonly { tableName: string }[];
  engine: DatabaseEngine;
  resolvedStops?: ReadonlySet<T>;
  packagesSeen?: PackagesSeenInput;
}): MigrationRunDecision<T> {
  const packages = options.packagesSeen
    ? checkPackagesSeen(options.packagesSeen)
    : undefined;
  const packageStops = (packages?.unconfirmed ?? []).map((packageName) => ({
    packageName,
    message: `Package ${packageName} was seen last time but is missing now. A package that declared required columns may be missing; the migrate could loosen them. Load the package, or pass --confirm-removed-package ${packageName} to confirm its removal.`,
  }));
  const notices = (packages?.ignoredConfirmations ?? []).map(
    (name) =>
      `Ignoring --confirm-removed-package ${name}: this package is not missing.`,
  );
  if (packages?.state === 'no-record')
    notices.unshift(
      'Package comparison skipped because no earlier migrate record exists. The record will be written after this run succeeds (not in dry-run).',
    );
  const stops: MigrationRunStop<T>[] = [];
  const applicable: T[] = [];
  for (const change of options.changes) {
    const verdict = decideSchemaChange(change, options.engine);
    if (verdict.decision === 'stop' && !options.resolvedStops?.has(change)) {
      stops.push({
        change,
        kind: verdict.kind,
        reason: verdict.stop?.reason ?? 'unlisted',
        message: verdict.message,
      });
    } else if (
      verdict.decision === 'apply' ||
      options.resolvedStops?.has(change)
    ) {
      applicable.push(change);
    }
  }
  if (stops.length === 0 && packageStops.length === 0)
    return { proceed: true, stops: [], packageStops, notices, heldBack: [] };

  const addedNames = new Set(
    (options.addedTables ?? []).map((s) => s.tableName),
  );
  const heldBack: HeldBackMigration[] = [...addedNames].map((table) => ({
    table,
    description: `Create table ${table}`,
  }));
  for (const change of applicable) {
    // The differ also represents a new table as an add_table change.
    if (change.type === 'add_table' && addedNames.has(change.table)) continue;
    heldBack.push(describeChange(change));
  }
  return { proceed: false, stops, packageStops, notices, heldBack };
}

function describeChange(change: SchemaChangeInput): HeldBackMigration {
  const column = change.foreignKey?.column ?? change.name;
  const subject = `${change.table}${column ? `.${column}` : ''}`;
  let description: string;
  switch (change.type) {
    case 'add_table':
      description = `Create table ${change.table}`;
      break;
    case 'add_column':
      description = `Add column ${subject}`;
      break;
    case 'drop_column':
      description = `Drop column ${subject}`;
      break;
    case 'alter_column':
      description = `Alter column ${subject} (${change.alteration ?? 'constraints'})`;
      break;
    case 'type_upgrade':
      description = `Convert column ${subject}`;
      break;
    case 'add_index':
      description = `Add index ${subject}`;
      break;
    case 'drop_index':
      description = `Drop index ${subject}`;
      break;
    case 'add_foreign_key':
      description = `Add foreign key ${subject}`;
      break;
    case 'drop_foreign_key':
      description = `Drop foreign key ${subject}`;
      break;
    default:
      description = `${change.type} ${subject}`;
  }
  const isColumn = [
    'add_column',
    'drop_column',
    'alter_column',
    'type_upgrade',
    'add_foreign_key',
    'drop_foreign_key',
  ].includes(change.type);
  return {
    description,
    table: change.table,
    ...(isColumn && column ? { column } : {}),
  };
}
