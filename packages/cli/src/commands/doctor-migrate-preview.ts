/** SELECT-only preview of the next ordinary migrate, after live-schema parity. */
import {
  checkOldestSupportedRelease,
  checkPackagesSeen,
  collectMigrateRecordInput,
  decideMigrationRun,
  decideSchemaChange,
  type LastMigrateRecord,
  type MigrateRecordInput,
  type MigrationRunDecision,
  ObjectRegistry,
  OLDEST_SUPPORTED_RELEASE,
  readLastMigrateRecord,
  type SchemaChangeEngine,
} from '@happyvertical/smrt-core';
import {
  getPendingSchemaStatements,
  type SchemaChange,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  quoteIdentifier,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';
import { orphanCountSql } from './db-migrate-actions.js';

export interface MigratePreviewReport {
  removed: string[];
  kept: string[];
  rules: string[];
  apply: Record<string, string[]>;
  tables: string[];
  current: MigrateRecordInput;
  last: LastMigrateRecord;
  missingPackages: string[];
  newPackages: string[];
  decision: MigrationRunDecision<SchemaChange>;
  stops: string[];
  issues: string[];
  warnings: string[];
}
export interface MigratePreviewOutcome {
  report: MigratePreviewReport | null;
  error: string | null;
}
const subject = (change: SchemaChange) =>
  `${change.table}${change.foreignKey?.column || change.name ? `.${change.foreignKey?.column ?? change.name}` : ''}`;
const errorText = (error: unknown) =>
  redactDatabaseUrlsInText(
    error instanceof Error ? error.message : String(error),
  );

/** Count using the differ's exact orphan predicate, including its UUID casts. */
async function stopCount(
  db: DatabaseInterface,
  stop: MigrationRunDecision<SchemaChange>['stops'][number],
): Promise<string> {
  try {
    const { change, kind } = stop;
    let sql: string;
    if (kind === 'foreign-key.orphans') {
      const detector = change.advisory?.suggestedSql?.[0];
      if (!detector) throw new Error('The differ supplied no orphan detector');
      sql = orphanCountSql(detector);
    } else {
      sql = `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(change.table)}`;
      if (kind === 'column.required-nulls') {
        if (!change.name) throw new Error('The stop has no column name');
        sql += ` WHERE ${quoteIdentifier(change.name)} IS NULL`;
      }
    }
    const result = await db.query(sql);
    const row = (Array.isArray(result) ? result : result.rows)[0];
    const count = row?.row_count ?? row?.orphan_count;
    if (count === undefined || !/^\d+$/.test(String(count)))
      throw new Error('The count query returned no row count');
    return `${count} row(s)`;
  } catch (error) {
    return `row count unavailable: ${errorText(error)}`;
  }
}

/** Does not bootstrap tracking/system tables or take a migration write lock. */
export async function buildMigratePreview(
  db: DatabaseInterface,
  engine: SchemaChangeEngine,
): Promise<MigratePreviewReport> {
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  const pending = await getPendingSchemaStatements(db, { engineHint: engine });
  const current = collectMigrateRecordInput();
  const last = await readLastMigrateRecord(db, { engineHint: engine });
  const recorded = last.state === 'recorded' ? last.record : null;
  const packagesSeen = {
    recorded: recorded?.packages ?? null,
    current: current.packages,
    confirmedRemoved: [],
  };
  const packages = checkPackagesSeen(packagesSeen);
  const decision = decideMigrationRun({
    changes: pending.diff.changes,
    addedTables: pending.diff.added_tables,
    engine,
    packagesSeen,
    recordedRelease: recorded?.release ?? null,
  });
  const report: MigratePreviewReport = {
    removed: [],
    kept: [],
    rules: [],
    apply: {},
    tables: pending.diff.added_tables.map((table) => table.tableName),
    current,
    last,
    missingPackages: packages.unconfirmed,
    newPackages: recorded
      ? current.packages.filter((name) => !recorded.packages.includes(name))
      : [],
    decision,
    stops: [],
    issues: [],
    warnings: [],
  };
  const removalKinds: Record<string, string> = {
    'column.drop-not-null': 'NOT NULL',
    'column.drop-default': 'default',
    'foreign-key.drop': 'foreign key',
    'index.drop': 'index',
  };
  for (const change of pending.diff.changes) {
    const verdict = decideSchemaChange(change, engine);
    const name = subject(change);
    const removal = removalKinds[verdict.kind];
    if (removal || change.alteration === 'drop_check') {
      report.removed.push(
        `${name}: removes ${removal ?? 'CHECK'}. To keep it, declare it in code.`,
      );
    }
    if (verdict.kind === 'column.relaxation-report')
      report.kept.push(`${name}: ${change.alteration?.replaceAll('_', ' ')}.`);
    if (verdict.decision === 'apply') {
      report.apply[verdict.kind] ??= [];
      report.apply[verdict.kind].push(name);
    }
    if (
      change.alteration === 'set_not_null' &&
      schemas[change.table]?.columns[change.name ?? '']?.notNull
    ) {
      report.rules.push(
        `${name}: required in code; ${verdict.kind === 'column.set-not-null' || verdict.kind === 'column.rebuild-covered' ? 'the next migrate sets NOT NULL' : ['column.required-nulls', 'column.required-missing'].includes(verdict.kind) ? 'existing rows have no value; the next migrate stops' : `the next migrate stops: ${verdict.message}`}.`,
      );
    }
  }

  // The differ does not expose its live CHECK names. Read the same catalog;
  // unlike its best-effort comparison, an unreadable catalog fails closed here.
  for (const schema of Object.values(schemas)) {
    const checks = (schema.checks ?? []).filter((check) =>
      check.name.startsWith('smrt_ck_'),
    );
    if (!checks.length) continue;
    let live = new Set<string>();
    if (engine === 'postgres') {
      const result = await db.query(
        `SELECT con.conname AS name FROM pg_constraint AS con JOIN pg_class AS rel ON rel.oid = con.conrelid JOIN pg_namespace AS ns ON ns.oid = rel.relnamespace WHERE con.contype = 'c' AND ns.nspname = 'public' AND rel.relname = $1`,
        [schema.tableName],
      );
      live = new Set(
        (Array.isArray(result) ? result : result.rows).map((row) =>
          String(row.name),
        ),
      );
    }
    for (const check of checks) {
      if (live.has(check.name)) continue;
      let why =
        'this engine cannot enforce a rule for one subclass; smrt checks it when saving';
      if (engine === 'postgres') {
        const change = pending.diff.changes.find(
          (item) =>
            item.table === schema.tableName &&
            item.alteration === 'set_check' &&
            item.name === check.columns[0],
        );
        why = change?.advisory
          ? 'rows already break it'
          : 'the next migrate adds it';
        if (change && decideSchemaChange(change, engine).decision === 'stop')
          why +=
            '; held until the shared migration policy accepts this CHECK change';
      }
      report.rules.push(
        `${schema.tableName}.${check.columns.join(', ')} (${check.name}): ${why}.`,
      );
    }
  }
  for (const stop of decision.stops) {
    const line = `${stop.kind} (${stop.reason}): ${stop.message} — ${await stopCount(db, stop)}`;
    report.stops.push(line);
    report.issues.push(`Next migrate: ${line}`);
  }
  for (const stop of decision.packageStops)
    report.issues.push(`Next migrate: ${stop.message}`);
  if (report.removed.length)
    report.warnings.push('Next migrate removes constraints made by hand');
  if (report.rules.length)
    report.warnings.push(
      'Next migrate: rules in code the database is not enforcing',
    );
  const age = checkOldestSupportedRelease(recorded?.release ?? null);
  if (!age.ok) report.warnings.push(age.message);
  // Startup compares the build's stamp, so the doctor does too (#4929).
  const expected = current.build
    ? current.build.fingerprint
    : current.fingerprint;
  if (!expected)
    report.warnings.push(
      'This build carries no schema fingerprint: it will refuse to start in production.',
    );
  else if (recorded?.fingerprint !== expected)
    report.warnings.push(
      recorded
        ? 'Schema fingerprint differs: this build will refuse to start in production until `smrt db:migrate` runs.'
        : `Database migration check: expected ${expected.slice(0, 12)}, found no migrate record. Run smrt db:migrate before starting this build. A restarted old copy or code rolled back without its database is refused for the same reason.`,
    );
  report.issues = report.issues.map(redactDatabaseUrlsInText);
  report.warnings = report.warnings.map(redactDatabaseUrlsInText);
  return report;
}

/** Connection/configuration errors return an outcome, never a diagnostic pass. */
export async function runMigratePreview(
  options: { discover?: boolean } = {},
): Promise<MigratePreviewOutcome> {
  let db: DatabaseInterface | undefined;
  try {
    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('../config.js');
    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
    if (!config.database?.url || config.database.url === ':memory:')
      return {
        report: null,
        error:
          'No persistent database is configured, so the next migrate cannot be verified. Set `database.url` in smrt.config.ts (or DATABASE_URL).',
      };
    if (options.discover !== false) await autoDiscoverAndLoad();
    const { getDatabase } = await import('@happyvertical/sql');
    const type = config.database.type || 'sqlite';
    const engine =
      type === 'postgres'
        ? 'postgres'
        : type === 'sqlite'
          ? 'sqlite'
          : type === 'duckdb'
            ? 'duckdb'
            : null;
    if (!engine)
      throw new Error(`Next migrate does not support database type ${type}`);
    db = await getDatabase({ type, url: config.database.url });
    return { report: await buildMigratePreview(db, engine), error: null };
  } catch (error) {
    return { report: null, error: errorText(error) };
  } finally {
    await closeDatabaseConnection(db);
  }
}

/** Each labelled group always has content, including an explicit empty line. */
export function formatMigratePreview(
  report: MigratePreviewReport,
  options: { verbose?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const group = (title: string, items: string[]) => {
    lines.push(`   ${title}:`);
    lines.push(
      ...(items.length ? items : ['none']).map((item) => `      ${item}`),
    );
  };
  group(
    'Constraints made by hand that the next migrate removes',
    report.removed,
  );
  group('Constraint relaxations kept until you opt in', report.kept);
  group('Rules in code the database is not enforcing', report.rules);
  group(
    'What the next migrate applies',
    Object.entries(report.apply)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([kind, names]) =>
          `${kind}: ${names.length} — ${names.slice(0, 10).join(', ')}${names.length > 10 ? `; ${names.length - 10} more` : ''}${!report.decision.proceed ? ' (held back)' : ''}`,
      ),
  );
  group(
    'Tables to create',
    report.tables.map(
      (table) => `${table}${!report.decision.proceed ? ' (held back)' : ''}`,
    ),
  );
  const recorded = report.last.state === 'recorded' ? report.last.record : null;
  group(
    'Packages',
    recorded
      ? [
          `Last migrate: ${recorded.packages.join(', ') || 'none'}`,
          `Loaded now: ${report.current.packages.join(', ') || 'none'}`,
          ...report.missingPackages.map(
            (name) =>
              `Missing: ${name}. Load it or pass --confirm-removed-package ${name}.`,
          ),
          `New: ${report.newPackages.join(', ') || 'none'}`,
          ...(!report.missingPackages.length ? ['Missing: none'] : []),
        ]
      : [
          'no earlier migrate record; the first migrate under this scheme writes one',
        ],
  );
  group('What the next migrate stops on', [
    ...report.stops,
    ...report.decision.packageStops.map((stop) => stop.message),
    ...(report.decision.releaseStop
      ? [report.decision.releaseStop.message]
      : []),
  ]);
  group(
    report.decision.proceed
      ? 'Held back'
      : 'Held back: nothing is applied while any stop stands',
    report.decision.heldBack.map((item) => item.description),
  );
  const age = checkOldestSupportedRelease(recorded?.release ?? null);
  group(
    'Database release',
    !recorded
      ? ['age unknown: no earlier migrate record']
      : [
          age.ok
            ? `ok: ${recorded.release}; oldest supported ${OLDEST_SUPPORTED_RELEASE}`
            : `⚠️ ${age.message}`,
        ],
  );
  const hash = (value: string) =>
    options.verbose ? `${value.slice(0, 12)} (${value})` : value.slice(0, 12);
  // The build's stamp is what startup compares (#4929).
  const build = report.current.build
    ? report.current.build.fingerprint
    : report.current.fingerprint;
  group('Schema fingerprint', [
    `Build: ${build ? hash(build) : 'none'}; database: ${recorded ? hash(recorded.fingerprint) : 'no migrate record'}`,
    build && recorded?.fingerprint === build
      ? 'matches'
      : (report.warnings.find(
          (warning) =>
            warning.startsWith('Schema fingerprint') ||
            warning.startsWith('Database migration check') ||
            warning.startsWith('This build carries'),
        ) ?? ''),
  ]);
  return lines.map(redactDatabaseUrlsInText);
}

/** The actual doctor section, extracted so bucketing is tested with a real DB. */
export async function runDoctorMigratePreviewSection(
  buckets: { issues: string[]; warnings: string[]; passed: string[] },
  check: (name: string, ok: boolean, reason: string) => void,
  options: { verbose?: boolean } = {},
): Promise<void> {
  console.log('\n🗄️  Next migrate\n');
  const { report, error } = await runMigratePreview({ discover: false });
  if (!report) {
    check('Next migrate', false, error ?? 'Could not preview the next migrate');
    return;
  }
  for (const line of formatMigratePreview(report, options)) console.log(line);
  buckets.issues.push(...report.issues);
  buckets.warnings.push(...report.warnings);
  if (!report.issues.length && !report.warnings.length)
    buckets.passed.push('Next migrate');
}
