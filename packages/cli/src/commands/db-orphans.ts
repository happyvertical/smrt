/**
 * db:orphans Command (#2753)
 *
 * Read-only per-foreign-key orphan count report. `db:migrate`'s orphan probe
 * already gates `ADD CONSTRAINT` with a `LIMIT 1` existence check and prints a
 * suggested repair; this command runs the identical probe as `COUNT(*)` for
 * every manifest-declared foreign key, so planning a repair no longer starts
 * with hand-writing the same SQL against the live database.
 *
 * Strictly diagnostic: it never repairs anything and always exits 0 — the
 * existing "no foreign-key orphan repair, by design" boundary stays exactly
 * where it is. Use `--json` for scripting.
 */

import {
  collectForeignKeyOrphanCounts,
  type ForeignKeyOrphanCount,
  type ForeignKeyOrphanCountReport,
  type ForeignKeyOrphanSkipped,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

interface DbOrphansOptions {
  json?: boolean;
  verbose?: boolean;
}

/** Render one count row as a compact, script-friendly line. */
export function formatOrphanCountLine(count: ForeignKeyOrphanCount): string {
  const marker = count.nullable ? '' : ' [NOT NULL]';
  return (
    `${count.childTable}.${count.childColumn} -> ` +
    `${count.parentTable}.${count.parentColumn}: ${count.orphanCount} orphan(s)${marker}`
  );
}

/** Render the full report as console lines. */
export function formatOrphanReport(
  report: ForeignKeyOrphanCountReport,
  options: { verbose?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const affected = report.counts.filter((count) => count.orphanCount > 0);

  lines.push(
    `   Engine: ${report.engine} · foreign keys checked: ${report.counts.length}` +
      (report.skipped.length > 0 ? ` · skipped: ${report.skipped.length}` : ''),
  );

  if (affected.length === 0) {
    lines.push('   ✅ No orphan rows found across any manifest foreign key.');
  } else {
    for (const count of affected) {
      const icon = count.nullable ? '⚠️' : '❌';
      lines.push(`   ${icon} ${formatOrphanCountLine(count)}`);
    }
  }

  if (options.verbose) {
    const clean = report.counts.filter((count) => count.orphanCount === 0);
    if (clean.length > 0) {
      lines.push(`   ✅ Zero orphans (${clean.length}):`);
      for (const count of clean) {
        lines.push(`      • ${formatOrphanCountLine(count)}`);
      }
    }
  }

  if (report.skipped.length > 0) {
    lines.push('   Skipped:');
    for (const skip of report.skipped) {
      const marker = skip.kind === 'probe_failed' ? ' [PROBE FAILED]' : '';
      lines.push(
        `      • ${skip.childTable}.${skip.childColumn} -> ${skip.parentTable}.${skip.parentColumn}: ${skip.reason}${marker}`,
      );
    }
  }

  return lines;
}

/** One-line summary used by `db:status`. */
export function summarizeOrphanReport(
  report: ForeignKeyOrphanCountReport,
): string {
  const affected = report.counts.filter((count) => count.orphanCount > 0);
  return `${affected.length} foreign key(s) with orphans, ${report.skipped.length} skipped`;
}

/** Foreign keys with at least one orphan row, for `db:status`'s summary. */
export function affectedOrphanCounts(
  report: ForeignKeyOrphanCountReport,
): ForeignKeyOrphanCount[] {
  return report.counts.filter((count) => count.orphanCount > 0);
}

export type {
  ForeignKeyOrphanCount,
  ForeignKeyOrphanCountReport,
  ForeignKeyOrphanSkipped,
};

export const dbOrphansCommand: CLICommand = {
  name: 'db:orphans',
  description:
    'Read-only per-foreign-key orphan count report: for every manifest foreign key, prints child/parent table and column, the live orphan row count, and whether the child column is NOT NULL. Never repairs. Always exits 0.',
  aliases: ['orphans', 'db-orphans'],
  args: [],
  options: {
    json: {
      type: 'boolean',
      description: 'Output as JSON (for scripting)',
      default: false,
      short: 'j',
    },
    verbose: {
      type: 'boolean',
      description: 'Also list foreign keys with zero orphans',
      default: false,
      short: 'v',
    },
  },
  handler: async (_args: string[], options: DbOrphansOptions) => {
    let db: DatabaseInterface | undefined;

    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      if (!config.database?.url || config.database.url === ':memory:') {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Database not configured' }));
        } else {
          console.error('\n❌ Database configuration required');
          console.error('\nPlease configure database in smrt.config.js\n');
        }
        process.exitCode = 1;
        return;
      }

      const dbType = config.database.type || 'sqlite';
      const dbUrl = config.database.url;

      if (!options.json) {
        console.log('\n🔎 Foreign-key orphan report\n');
        console.log(`Database: ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`);
      }

      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      await autoDiscoverAndLoad();
      const manifestSchemas = ObjectRegistry.getAllSchemasAsDefinitions();

      const report = await collectForeignKeyOrphanCounts(db, manifestSchemas, {
        engineHint: dbType,
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      for (const line of formatOrphanReport(report, {
        verbose: options.verbose,
      })) {
        console.log(line);
      }
      console.log();
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to collect the orphan report:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
