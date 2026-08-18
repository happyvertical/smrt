/**
 * Live-schema parity reporting for the CLI (#2368)
 *
 * Shared by `smrt doctor --db` and `smrt db:status --parity`. Both surfaces
 * introspect the configured database and compare it to the shape the model
 * layer assumes — including the hand-DDL `_smrt_*` system tables and an index
 * policy that does not consult the manifest, since the manifest is the artifact
 * that dropped the index in the first place (#2356).
 *
 * Everything here fails closed: a database that cannot be reached, or an
 * adapter that cannot describe its tables, is reported as a failure rather
 * than as "in sync".
 */

import {
  type ConflictTargetInput,
  checkLiveSchemaParity,
  type LiveParityFinding,
  type LiveParitySeverity,
  type LiveSchemaParityReport,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

/** Options accepted by {@link runLiveSchemaParity}. */
export interface RunLiveSchemaParityOptions {
  /** Include `_smrt_*` system tables (default true). */
  includeSystemTables?: boolean;
  /**
   * Load manifests before reading the registry (default true). Callers that
   * already ran discovery pass false to avoid a second pass.
   */
  discover?: boolean;
}

/** Result of one CLI-level parity run. */
export interface LiveSchemaParityOutcome {
  report: LiveSchemaParityReport | null;
  /** Human-readable failure reason; non-null exactly when `report` is null. */
  error: string | null;
  database: { type: string; url: string } | null;
}

/**
 * Collect every declared upsert conflict target, keyed by table name.
 *
 * The conflict target is a registry property, not a manifest one: a class may
 * declare `conflictColumns` explicitly, inherit the CTI `(slug, context)`
 * default, or get the STI `(slug, context, _meta_type)` triple. Whatever it
 * resolves to, the live database needs a matching UNIQUE index or every upsert
 * against that table either errors (PostgreSQL) or duplicates rows.
 */
export function collectRegistryConflictTargets(): Record<
  string,
  ConflictTargetInput[]
> {
  const targets: Record<string, ConflictTargetInput[]> = {};

  for (const className of ObjectRegistry.getQualifiedClassNames()) {
    const tableName = ObjectRegistry.getTableName(className);
    if (!tableName) continue;

    const columns = ObjectRegistry.getConflictColumns(className);
    if (!columns || columns.length === 0) continue;

    const bucket = targets[tableName] ?? [];
    bucket.push({ columns, source: className });
    targets[tableName] = bucket;
  }

  return targets;
}

/**
 * Run the parity check against the configured database.
 *
 * Never throws for an operational problem: connection and introspection
 * failures come back as `{ report: null, error }` so both callers can render
 * them in their own idiom while still failing closed.
 */
export async function runLiveSchemaParity(
  options: RunLiveSchemaParityOptions = {},
): Promise<LiveSchemaParityOutcome> {
  const { includeSystemTables = true, discover = true } = options;
  let db: DatabaseInterface | undefined;

  try {
    const { getPackageConfig } = await import('@happyvertical/smrt-config');
    const { DEFAULT_CLI_CONFIG } = await import('../config.js');
    const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

    if (!config.database?.url || config.database.url === ':memory:') {
      return {
        report: null,
        database: null,
        error:
          'No persistent database is configured, so live-schema parity cannot be verified. Set `database.url` in smrt.config.ts (or DATABASE_URL).',
      };
    }

    const dbUrl = config.database.url;
    const dbType = config.database.type || 'sqlite';
    const database = {
      type: dbType,
      url: formatDatabaseDisplayUrl(dbType, dbUrl),
    };

    if (discover) {
      await autoDiscoverAndLoad();
    }

    const { getDatabase } = await import('@happyvertical/sql');
    db = await getDatabase({ type: dbType, url: dbUrl });

    const report = await checkLiveSchemaParity({
      db,
      schemas: ObjectRegistry.getAllSchemasAsDefinitions(),
      conflictTargets: collectRegistryConflictTargets(),
      includeSystemTables,
      engineHint: dbType,
    });

    return { report, database, error: null };
  } catch (error) {
    return {
      report: null,
      database: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeDatabaseConnection(db);
  }
}

const SEVERITY_ICON: Record<LiveParitySeverity, string> = {
  error: '❌',
  warning: '⚠️',
  info: 'ℹ️',
};

/** Findings of one severity, ordered by table then target. */
export function selectFindings(
  report: LiveSchemaParityReport,
  severity: LiveParitySeverity,
): LiveParityFinding[] {
  return report.findings
    .filter((finding) => finding.severity === severity)
    .sort(
      (left, right) =>
        left.table.localeCompare(right.table) ||
        (left.target ?? '').localeCompare(right.target ?? ''),
    );
}

/**
 * Render a parity report as console lines.
 *
 * Errors and warnings always print. Informational findings (undeclared tables,
 * columns and indexes) print only with `verbose`, because on a shared database
 * they are numerous and expected.
 */
export function formatParityReport(
  report: LiveSchemaParityReport,
  options: { verbose?: boolean } = {},
): string[] {
  const lines: string[] = [];

  lines.push(
    `   Engine: ${report.engine} · tables checked: ${report.tablesChecked}` +
      (report.tablesMissing > 0 ? ` · missing: ${report.tablesMissing}` : '') +
      (report.systemTablesIncluded ? ' · system tables included' : ''),
  );

  if (report.indexIntrospection === 'unavailable') {
    lines.push(
      '   ⚠️  Index metadata is not readable on this engine; index, uniqueness and conflict-target checks were skipped.',
    );
  }

  const severities: LiveParitySeverity[] = options.verbose
    ? ['error', 'warning', 'info']
    : ['error', 'warning'];

  for (const severity of severities) {
    for (const finding of selectFindings(report, severity)) {
      lines.push(`   ${SEVERITY_ICON[severity]} ${finding.message}`);
      if (options.verbose) {
        lines.push(`      → ${finding.recommendation}`);
      }
    }
  }

  if (report.counts.info > 0 && !options.verbose) {
    lines.push(
      `   ℹ️  ${report.counts.info} informational finding(s) hidden; re-run with --verbose.`,
    );
  }

  if (report.findings.length === 0) {
    lines.push('   ✅ Live schema matches the expected shape.');
  }

  return lines;
}

/** One-line summary used by callers that render their own detail. */
export function summarizeParityReport(report: LiveSchemaParityReport): string {
  return `${report.counts.error} error(s), ${report.counts.warning} warning(s), ${report.counts.info} informational`;
}
