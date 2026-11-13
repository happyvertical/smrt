/** Whole-run policy shared by the CLI and application migration wrappers. */

import type { DatabaseEngine } from '../schema/ddl/types.js';
import {
  decideSchemaChange,
  type SchemaChangeInput,
  type SchemaChangeVerdict,
} from './change-kinds.js';
import { checkOldestSupportedRelease } from './oldest-supported.js';

export interface PackagesSeenInput {
  recorded: readonly string[] | null;
  current: readonly string[];
  confirmedRemoved: readonly string[];
  /**
   * How this run compares with the app's build (`collectMigrateRecordInput().build`).
   * A build package whose tables this run has not planned is a stop that a
   * confirmation cannot clear: the package was forgotten, not removed.
   */
  build?: {
    fingerprint?: string;
    /** Two project manifests disagree: names the one used and why. */
    notice?: string;
    planned: string;
    unloaded: readonly { packageName: string; tables: readonly string[] }[];
  };
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
  /**
   * `removed`: seen last time, missing now (a confirmation clears it).
   * `unloaded`: part of the build, tables not loaded by this run (none does).
   */
  kind: 'removed' | 'unloaded';
  /** The build tables this run did not load (`unloaded` only). */
  tables?: string[];
  message: string;
}

/** A release stop; the parts are structured so a writer can word it for its reader. */
export interface MigrationReleaseStop {
  message: string;
  recorded?: string;
  oldest?: string;
  firstHop?: string;
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
  releaseStop: MigrationReleaseStop | null;
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
  recordedRelease?: string | null;
}): MigrationRunDecision<T> {
  const releaseCheck = checkOldestSupportedRelease(
    options.recordedRelease ?? null,
  );
  const releaseStop: MigrationReleaseStop | null = releaseCheck.ok
    ? null
    : {
        message: releaseCheck.message,
        recorded: releaseCheck.recorded,
        oldest: releaseCheck.oldest,
        ...(releaseCheck.firstHop ? { firstHop: releaseCheck.firstHop } : {}),
      };
  const packages = options.packagesSeen
    ? checkPackagesSeen(options.packagesSeen)
    : undefined;
  const packageStops: MigrationPackageStop[] = (
    packages?.unconfirmed ?? []
  ).map((packageName) => ({
    packageName,
    kind: 'removed' as const,
    message: `Package ${packageName} was seen last time but is missing now. A package that declared required columns may be missing; the migrate could loosen them. Load the package, or pass --confirm-removed-package ${packageName} to confirm its removal.`,
  }));
  const build = options.packagesSeen?.build;
  for (const { packageName, tables } of build?.unloaded ?? []) {
    packageStops.push({
      packageName,
      kind: 'unloaded',
      tables: [...tables],
      message: `Package ${packageName} is part of this build, but this run has not loaded its tables (${tables.join(', ')}). Load every model before migrating, or run smrt db:migrate in the app's project.`,
    });
  }
  const notices = (packages?.ignoredConfirmations ?? []).map(
    (name) =>
      `Ignoring --confirm-removed-package ${name}: this package is not missing.`,
  );
  if (build?.notice) notices.unshift(build.notice);
  if (
    build?.fingerprint &&
    !build.unloaded.length &&
    build.fingerprint !== build.planned
  )
    notices.push(
      `The schema this run applies to the build's tables (${build.planned.slice(0, 12)}) differs from the build's stamp (${build.fingerprint.slice(0, 12)}): the installed packages are not the ones the build was made with. Rebuild the app and migrate again, or the build will be refused at startup.`,
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
  if (stops.length === 0 && packageStops.length === 0 && !releaseStop)
    return {
      proceed: true,
      releaseStop,
      stops: [],
      packageStops,
      notices,
      heldBack: [],
    };

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
  return {
    proceed: false,
    releaseStop,
    stops,
    packageStops,
    notices,
    heldBack,
  };
}

/** The refused part of a {@link MigrationRunDecision}, in plain words. */
export interface MigrationRefusalText {
  /** One line: what stopped the run. */
  headline: string;
  /** One indented line per release stop, package stop and schema stop. */
  stopLines: string[];
  /** Heading for the held-back list. */
  heldBackHeading: string;
  /** One indented line per change that was held back. */
  heldBackLines: string[];
}

/**
 * Describe a refused run: what stopped it (table, column, reason, and any row
 * counts the stop message carries), any package or release stop, and what was
 * held back. The one wording `smrt db:migrate` prints and an application that
 * migrates itself (the local runtime) shows, so the two never disagree.
 * `repairSql` adds the suggested repair statements under each stop (the CLI
 * prints them; an app's end user cannot run them).
 */
export function describeMigrationRefusal(
  decision: Pick<
    MigrationRunDecision,
    'releaseStop' | 'packageStops' | 'stops' | 'heldBack'
  >,
  options: { repairSql?: boolean } = {},
): MigrationRefusalText {
  const headline = decision.releaseStop
    ? 'Migrate stopped: database release is not supported by this build'
    : decision.packageStops.length
      ? `Migrate stopped: ${decision.packageStops.length} missing package(s), ${decision.stops.length} schema stop(s)`
      : `Migrate stopped: ${decision.stops.length} change(s) would lose or invent data`;
  const stopLines: string[] = [];
  if (decision.releaseStop)
    stopLines.push(`   ${decision.releaseStop.message}`);
  for (const stop of decision.packageStops)
    stopLines.push(`   ${stop.message}`);
  for (const stop of decision.stops) {
    stopLines.push(`   ${stop.message} (${stop.reason})`);
    if (options.repairSql)
      for (const sql of stop.change.advisory?.suggestedSql ?? [])
        stopLines.push(`      ${sql}`);
  }
  return {
    headline,
    stopLines,
    heldBackHeading: 'Held back (nothing was applied):',
    heldBackLines: decision.heldBack.map((held) => `   ${held.description}`),
  };
}

/** {@link describeMigrationRefusal} as one multi-line string. */
export function formatMigrationRefusal(
  decision: Parameters<typeof describeMigrationRefusal>[0],
  options: { repairSql?: boolean } = {},
): string {
  const text = describeMigrationRefusal(decision, options);
  return [
    text.headline,
    ...text.stopLines,
    text.heldBackHeading,
    ...text.heldBackLines,
  ].join('\n');
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

/**
 * The name of the option through which an app that migrates itself (the local
 * runtime) confirms, in code, that it removed a package on purpose. It means
 * what `smrt db:migrate --confirm-removed-package` means.
 */
export const APP_CONFIRM_REMOVED_PACKAGES_OPTION = 'confirmRemovedPackages';

/** A refused run worded for the two readers of an app that migrates itself. */
export interface AppMigrationRefusalText {
  /**
   * One short line the app may show its user: the app could not update this
   * database, nothing was changed, who to contact. No command, no option.
   */
  userLine: string;
  /** What stopped the run, for the app's developer. */
  headline: string;
  /** One indented line per stop, each saying what the developer can do. */
  developerLines: string[];
  /** Heading for the held-back list. */
  heldBackHeading: string;
  /** One indented line per change that was held back. */
  heldBackLines: string[];
}

/**
 * {@link describeMigrationRefusal} for an app that migrates itself and has no
 * operator: an end user who can run no command, and a developer who can set
 * options in code and ship a new build. Same stops, same facts; the user line
 * carries no instruction the user cannot follow, and each developer line says
 * what the developer can do about that stop (or that nothing in the app's
 * options can). `smrt db:migrate` keeps using {@link describeMigrationRefusal}.
 */
export function describeAppMigrationRefusal(
  decision: Pick<
    MigrationRunDecision,
    'releaseStop' | 'packageStops' | 'stops' | 'heldBack'
  >,
): AppMigrationRefusalText {
  const base = describeMigrationRefusal(decision);
  const option = APP_CONFIRM_REMOVED_PACKAGES_OPTION;
  const developerLines: string[] = [];
  const stop = decision.releaseStop;
  if (stop) {
    developerLines.push(
      stop.recorded && stop.oldest && stop.firstHop
        ? `   This database was last migrated by smrt ${stop.recorded}, and this build supports upgrades from ${stop.oldest} and later. No app option skips this: ship a build of the app made with smrt ${stop.firstHop} for installations to run first, then this build.`
        : `   ${stop.message} No app option skips this: ship a build of the app that can read the record, or one made with a supported smrt release that installations run first.`,
    );
  }
  for (const packageStop of decision.packageStops) {
    developerLines.push(
      packageStop.kind === 'unloaded'
        ? `   Package ${packageStop.packageName} is part of this build, but this run has not loaded its tables (${(packageStop.tables ?? []).join(', ')}). Import every model module before the runtime starts. The ${option} option does not clear this: ship a build that loads them.`
        : `   Package ${packageStop.packageName} was seen last time but is missing now. A package that declared required columns may be missing; the migrate could loosen them. If you removed it on purpose, add "${packageStop.packageName}" to the ${option} option of the app's runtime and ship that build; otherwise load the package again.`,
    );
  }
  for (const schemaStop of decision.stops)
    developerLines.push(`   ${schemaStop.message} (${schemaStop.reason})`);
  if (decision.stops.length)
    developerLines.push(
      '   No app option overrides a schema stop: ship a build whose models do not make this change.',
    );
  return {
    userLine:
      "This app could not update its local database to this version, and nothing was changed. Your data is as it was. Contact the app's developer.",
    headline: base.headline,
    developerLines,
    heldBackHeading: base.heldBackHeading,
    heldBackLines: base.heldBackLines,
  };
}
